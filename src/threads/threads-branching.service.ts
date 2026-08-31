/** Implements tracked message-level branching on top of thread/fork. */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import type {
  BranchGroupDto,
  BranchTreeDto,
  BranchVersionDto,
  CreateMessageBranchDto,
} from '../conversation-branches/dto/conversation-branches.dto';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import {
  isInvalidForkBoundaryError,
  isThreadServerUnavailableError,
  isUnmaterializedThreadReadError,
  isUnsupportedForkBoundaryFieldError,
} from './thread-errors';
import { ThreadHistoryService } from './thread-history.service';
import { assertPaginatedThread } from './thread-history-mode';
import { previewFromUserInput, truncatePreview } from './thread-input-preview';

/**
 * `thread/fork` params using the experimental exclusive boundary.
 *
 * `beforeTurnId` is accepted at runtime by codex 0.149 but absent from the
 * generated schema. It is preferred over `lastTurnId` because it also accepts
 * interrupted turns, which `lastTurnId` refuses — roughly 1 in 13 turns in
 * practice, all of which would otherwise be uneditable.
 */
type ExperimentalThreadForkBeforeParams = Omit<
  v2.ThreadForkParams,
  'lastTurnId'
> & {
  beforeTurnId: string;
  excludeTurns: true;
};

type UserMessageItem = Extract<v2.ThreadItem, { type: 'userMessage' }>;

export type CreateMessageBranchResult = {
  fork: v2.ThreadForkResponse;
  tree: BranchTreeDto;
  group: BranchGroupDto;
  version: BranchVersionDto;
};

@Injectable()
export class ThreadsBranchingService {
  private readonly logger = new Logger(ThreadsBranchingService.name);

  constructor(
    private readonly codex: CodexService,
    private readonly resumeRegistry: ThreadResumeRegistryService,
    private readonly branches: ConversationBranchesService,
    private readonly history: ThreadHistoryService,
  ) {}

  /**
   * Creates a tracked message branch by forking immediately before a user turn.
   *
   * The fork boundary and the version-grouping key are intentionally different:
   * app-server forks before the edited turn, while versions group by the common
   * prefix's last turn id, or a start sentinel when the prefix is empty.
   */
  async createMessageBranch(
    sourceThreadId: string,
    body: CreateMessageBranchDto,
  ): Promise<CreateMessageBranchResult> {
    const editedTurnId = this.readEditedTurnId(body);
    const branchPreviewText = this.readBranchPreviewText(body);
    const source = await this.readThread(sourceThreadId, true);
    assertPaginatedThread(source.thread, 'thread/read');
    if (source.thread.id !== sourceThreadId) {
      throw new BusinessException(
        ErrorCode.threads.branchForkUnsupported,
        HttpStatus.BAD_GATEWAY,
        'thread/read returned a different source conversation id',
        { threadId: sourceThreadId, returnedThreadId: source.thread.id },
      );
    }

    this.assertThreadIsBranchable(source.thread, sourceThreadId);

    const turns = source.thread.turns;
    const editedTurnIndex = turns.findIndex((turn) => turn.id === editedTurnId);
    if (editedTurnIndex < 0) {
      throw BusinessException.notFound(
        ErrorCode.threads.branchEditedTurnNotFound,
        'Edited turn was not found in this conversation',
        { threadId: sourceThreadId, turnId: editedTurnId },
      );
    }

    const userMessage = this.findUserMessageItem(turns[editedTurnIndex]);
    if (!userMessage) {
      throw BusinessException.badRequest(
        ErrorCode.threads.branchEditedTurnNotUserMessage,
        'Edited turn must contain a user message',
        { threadId: sourceThreadId, turnId: editedTurnId },
      );
    }

    const expectedPrefixTurnIds = turns
      .slice(0, editedTurnIndex)
      .map((turn) => turn.id);
    const commonPrefixTurnId = expectedPrefixTurnIds.at(-1) ?? null;
    const treeRootThreadId =
      this.branches.resolveTreeRootThreadId(sourceThreadId);
    const originalPreviewText = previewFromUserInput(userMessage.content);

    let forkResponse: v2.ThreadForkResponse;
    try {
      forkResponse = await this.forkBeforeTurn(sourceThreadId, editedTurnId);
    } catch (err) {
      this.throwBranchForkError(err);
    }

    const childThreadId = forkResponse.thread.id;
    if (childThreadId === sourceThreadId) {
      throw new BusinessException(
        ErrorCode.threads.branchForkUnsupported,
        HttpStatus.BAD_GATEWAY,
        'thread/fork returned the source conversation id',
        { threadId: sourceThreadId },
      );
    }

    try {
      const forkedFromId = forkResponse.thread.forkedFromId;
      if (forkedFromId && forkedFromId !== sourceThreadId) {
        throw new BusinessException(
          ErrorCode.threads.branchPrefixMismatch,
          HttpStatus.BAD_GATEWAY,
          'thread/fork returned a child of a different source conversation',
          { threadId: sourceThreadId, childThreadId, forkedFromId },
        );
      }
      assertPaginatedThread(forkResponse.thread, 'thread/fork');
      const actualPrefixTurnIds =
        await this.history.listAllTurnIds(childThreadId);
      if (!this.forkPrefixMatches(actualPrefixTurnIds, expectedPrefixTurnIds)) {
        throw new BusinessException(
          ErrorCode.threads.branchPrefixMismatch,
          HttpStatus.BAD_GATEWAY,
          'thread/fork did not persist the expected common prefix',
          { threadId: sourceThreadId, childThreadId },
        );
      }
    } catch (err) {
      const cleanupError = await this.deleteUntrackedThread(childThreadId);
      if (!cleanupError) throw err;
      throw BusinessException.internal(
        ErrorCode.threads.branchMetadataFailed,
        `Fork validation failed and cleanup of ${childThreadId} also failed: ${cleanupError.message}`,
        { threadId: sourceThreadId, childThreadId },
      );
    }

    let recorded: ReturnType<
      ConversationBranchesService['recordMessageBranch']
    >;
    try {
      recorded = this.branches.recordMessageBranch({
        sourceThreadId,
        childThreadId,
        treeRootThreadId,
        commonPrefixTurnId,
        editedTurnId,
        inheritedTurnIds: expectedPrefixTurnIds,
        originalPreviewText,
        branchPreviewText,
      });
    } catch (err) {
      // `recordMessageBranch` builds its response DTO after committing. A
      // projection failure must never delete a child whose edge is durable.
      if (this.branches.hasForkEdge(childThreadId)) {
        throw BusinessException.internal(
          ErrorCode.threads.branchMetadataFailed,
          'Branch metadata was persisted but its response could not be built; the child conversation was preserved',
          { threadId: sourceThreadId, childThreadId },
        );
      }
      const cleanupError = await this.deleteUntrackedThread(childThreadId);
      const cleanupSuffix = cleanupError
        ? ` Cleanup of ${childThreadId} also failed: ${cleanupError.message}`
        : '';
      throw BusinessException.internal(
        ErrorCode.threads.branchMetadataFailed,
        `Failed to persist branch metadata: ${
          err instanceof Error ? err.message : String(err)
        }.${cleanupSuffix}`,
        { threadId: sourceThreadId, childThreadId },
      );
    }
    this.resumeRegistry.markResumed(childThreadId);
    this.resumeRegistry.cacheResponse(childThreadId, forkResponse);
    return { fork: forkResponse, ...recorded };
  }

  /**
   * Reads a source thread, tolerating a thread with no persisted history.
   *
   * An unmaterialized source cannot be branched, but it must fail the
   * branchability check with a caller-facing error rather than surfacing a raw
   * app-server refusal.
   */
  private async readThread(
    threadId: string,
    includeTurns: boolean,
  ): Promise<v2.ThreadReadResponse> {
    try {
      return await this.codex.request<v2.ThreadReadResponse>('thread/read', {
        threadId,
        includeTurns,
      });
    } catch (err) {
      if (!includeTurns || !isUnmaterializedThreadReadError(err)) throw err;
      const metadata = await this.codex.request<v2.ThreadReadResponse>(
        'thread/read',
        { threadId, includeTurns: false },
      );
      return { thread: { ...metadata.thread, turns: [] } };
    }
  }

  private assertThreadIsBranchable(
    thread: v2.Thread,
    sourceThreadId: string,
  ): void {
    if (thread.status.type === 'active') {
      throw BusinessException.conflict(
        ErrorCode.threads.branchThreadInProgress,
        'Cannot branch a conversation while it has an active turn',
        { threadId: sourceThreadId },
      );
    }

    if (thread.turns.some((turn) => turn.status === 'inProgress')) {
      throw BusinessException.conflict(
        ErrorCode.threads.branchThreadInProgress,
        'Cannot branch a conversation while it has an in-progress turn',
        { threadId: sourceThreadId },
      );
    }
  }

  private async forkBeforeTurn(
    sourceThreadId: string,
    editedTurnId: string,
  ): Promise<v2.ThreadForkResponse> {
    const params: ExperimentalThreadForkBeforeParams = {
      threadId: sourceThreadId,
      beforeTurnId: editedTurnId,
      excludeTurns: true,
    };
    return this.codex.request<v2.ThreadForkResponse>('thread/fork', params);
  }

  private readEditedTurnId(body: CreateMessageBranchDto): string {
    if (typeof body?.editedTurnId !== 'string') {
      throw BusinessException.badRequest(
        ErrorCode.threads.branchEditedTurnRequired,
        'editedTurnId is required',
      );
    }
    const editedTurnId = body.editedTurnId.trim();
    if (!editedTurnId) {
      throw BusinessException.badRequest(
        ErrorCode.threads.branchEditedTurnRequired,
        'editedTurnId is required',
      );
    }
    return editedTurnId;
  }

  private readBranchPreviewText(body: CreateMessageBranchDto): string {
    if (body.previewText === undefined || body.previewText === null) return '';
    if (typeof body.previewText !== 'string') {
      throw BusinessException.badRequest(
        ErrorCode.validation.typeMismatch,
        'previewText must be a string',
        { field: 'previewText', type: 'string' },
      );
    }
    return truncatePreview(body.previewText.trim());
  }

  private findUserMessageItem(turn: v2.Turn): UserMessageItem | null {
    return (
      turn.items.find((item): item is UserMessageItem => {
        return item.type === 'userMessage';
      }) ?? null
    );
  }

  private forkPrefixMatches(
    actualIds: string[],
    expectedPrefixTurnIds: string[],
  ): boolean {
    return (
      actualIds.length === expectedPrefixTurnIds.length &&
      actualIds.every(
        (turnId, index) => turnId === expectedPrefixTurnIds[index],
      )
    );
  }

  private throwBranchForkError(err: unknown): never {
    if (isThreadServerUnavailableError(err)) {
      throw new BusinessException(
        ErrorCode.codex.serverUnavailable,
        HttpStatus.SERVICE_UNAVAILABLE,
        'Codex app-server is not connected',
      );
    }
    if (isUnsupportedForkBoundaryFieldError(err)) {
      throw BusinessException.badRequest(
        ErrorCode.threads.branchForkUnsupported,
        'thread/fork before-turn boundary is not supported by this server',
      );
    }
    if (isInvalidForkBoundaryError(err)) {
      throw BusinessException.badRequest(
        ErrorCode.threads.branchInvalidBoundary,
        'thread/fork rejected the requested branch boundary',
      );
    }
    throw err;
  }

  private async deleteUntrackedThread(threadId: string): Promise<Error | null> {
    try {
      await this.codex.request<v2.ThreadDeleteResponse>('thread/delete', {
        threadId,
      });
      this.resumeRegistry.forget(threadId);
      return null;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.warn(
        `Failed to delete untracked fork thread=${threadId}: ${error.message}`,
      );
      return error;
    }
  }
}
