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
  isNotMaterializedError,
  isThreadServerUnavailableError,
  isUnsupportedForkBoundaryFieldError,
} from './thread-errors';
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

    if (!this.forkPrefixMatches(forkResponse.thread, expectedPrefixTurnIds)) {
      await this.deleteUntrackedThread(childThreadId);
      throw new BusinessException(
        ErrorCode.threads.branchPrefixMismatch,
        HttpStatus.BAD_GATEWAY,
        'thread/fork did not return the expected common prefix',
        { threadId: sourceThreadId, childThreadId },
      );
    }

    try {
      const recorded = this.branches.recordMessageBranch({
        sourceThreadId,
        childThreadId,
        treeRootThreadId,
        commonPrefixTurnId,
        editedTurnId,
        inheritedTurnIds: expectedPrefixTurnIds,
        originalPreviewText,
        branchPreviewText,
      });
      this.resumeRegistry.markResumed(childThreadId);
      this.resumeRegistry.cacheResponse(childThreadId, forkResponse);
      return { fork: forkResponse, ...recorded };
    } catch {
      const cleanupError = await this.deleteUntrackedThread(childThreadId);
      const cleanupSuffix = cleanupError
        ? ` Cleanup of ${childThreadId} also failed: ${cleanupError.message}`
        : '';
      throw BusinessException.internal(
        ErrorCode.threads.branchMetadataFailed,
        `Failed to persist branch metadata.${cleanupSuffix}`,
        { threadId: sourceThreadId, childThreadId },
      );
    }
  }

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
      if (includeTurns && isNotMaterializedError(err)) {
        const response = await this.codex.request<v2.ThreadReadResponse>(
          'thread/read',
          { threadId, includeTurns: false },
        );
        return { thread: { ...response.thread, turns: [] } };
      }
      throw err;
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
    forkedThread: v2.Thread,
    expectedPrefixTurnIds: string[],
  ): boolean {
    const actualIds = forkedThread.turns.map((turn) => turn.id);
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
