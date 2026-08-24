/**
 * Handles thread and turn operations by delegating to Codex app-server.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import type {
  BranchStateDto,
  BranchTreeDto,
  CreateMessageBranchDto,
} from '../conversation-branches/dto/conversation-branches.dto';
import {
  ThreadsBranchingService,
  type CreateMessageBranchResult,
} from './threads-branching.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { isNotMaterializedError } from './thread-errors';
import { previewFromUserInput } from './thread-input-preview';

const REQUIRED_HISTORY_MODE = 'paginated';

type ExperimentalThreadStartParams = v2.ThreadStartParams & {
  historyMode: typeof REQUIRED_HISTORY_MODE;
};

type ThreadWithHistoryMode = v2.Thread & { historyMode?: string };

@Injectable()
export class ThreadsService {
  private readonly logger = new Logger(ThreadsService.name);

  constructor(
    private readonly codex: CodexService,
    private readonly resumeRegistry: ThreadResumeRegistryService,
    private readonly branches: ConversationBranchesService,
    private readonly branching: ThreadsBranchingService,
  ) {}

  /**
   * Creates a new thread (conversation).
   *
   * @param params - Thread start parameters (model, cwd, approvalPolicy, etc.)
   * @returns The created thread with resolved settings
   */
  async startThread(
    params: v2.ThreadStartParams,
  ): Promise<v2.ThreadStartResponse> {
    const requestParams: ExperimentalThreadStartParams = {
      ...params,
      historyMode: REQUIRED_HISTORY_MODE,
    };
    const response = await this.codex.request<v2.ThreadStartResponse>(
      'thread/start',
      requestParams,
    );
    if (!this.isPaginatedThread(response.thread)) {
      const cleanupError = await this.deleteUntrackedThread(response.thread.id);
      const message = cleanupError
        ? `thread/start did not return paginated history; cleanup of ${response.thread.id} also failed: ${cleanupError.message}`
        : 'thread/start did not return paginated history';
      throw new BusinessException(
        ErrorCode.threads.paginatedHistoryRequired,
        HttpStatus.BAD_GATEWAY,
        message,
        { threadId: response.thread.id },
      );
    }
    this.resumeRegistry.markResumed(response.thread.id);
    this.resumeRegistry.cacheResponse(response.thread.id, response);
    return response;
  }

  /**
   * Lists threads with optional filtering and pagination.
   *
   * @param params - List parameters (cursor, limit, archived, searchTerm, etc.)
   * @returns Paginated thread list
   */
  async listThreads(
    params: v2.ThreadListParams,
  ): Promise<v2.ThreadListResponse> {
    return this.codex.request<v2.ThreadListResponse>('thread/list', params);
  }

  /**
   * Lists thread IDs currently loaded in the Codex app-server memory.
   *
   * @param params - Optional pagination cursor and limit
   * @returns Paginated loaded thread IDs
   */
  async listLoadedThreads(
    params: v2.ThreadLoadedListParams,
  ): Promise<v2.ThreadLoadedListResponse> {
    return this.codex.request<v2.ThreadLoadedListResponse>(
      'thread/loaded/list',
      params,
    );
  }

  /**
   * Reads a single thread by ID.
   *
   * If `includeTurns` is requested but the thread is not yet materialized
   * (no user messages), falls back to reading without turns — an
   * unmaterialized thread has no turns anyway.
   *
   * @param threadId - The thread identifier
   * @param includeTurns - Whether to include turn history
   * @returns The thread data
   */
  async readThread(
    threadId: string,
    includeTurns = false,
  ): Promise<v2.ThreadReadResponse> {
    try {
      return await this.codex.request<v2.ThreadReadResponse>('thread/read', {
        threadId,
        includeTurns,
      });
    } catch (err) {
      // Thread not materialized — retry without turns if that was requested.
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

  /**
   * Ensures a persisted thread is resumed once for the current app-server generation.
   *
   * @param threadId - The thread identifier
   * @returns The resumed or already-active thread with resolved settings
   */
  async resumeThread(threadId: string): Promise<v2.ThreadResumeResponse> {
    return this.resumeRegistry.ensureResumed(threadId);
  }

  /**
   * Starts a new turn (user message + agent response cycle).
   *
   * @param params - Turn start parameters (threadId, input, model overrides, etc.)
   * @returns The created turn
   */
  async startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse> {
    const response = await this.codex.request<v2.TurnStartResponse>(
      'turn/start',
      params,
    );
    this.branches.attachPendingVersionTurn(
      params.threadId,
      response.turn.id,
      previewFromUserInput(params.input),
    );
    return response;
  }

  /**
   * Sends additional user input to the currently active turn.
   *
   * @param params - Turn steer parameters including the active turn precondition
   * @returns The turn id accepted by app-server
   */
  async steerTurn(params: v2.TurnSteerParams): Promise<v2.TurnSteerResponse> {
    return this.codex.request<v2.TurnSteerResponse>('turn/steer', params);
  }

  /**
   * Interrupts an in-progress turn.
   *
   * @param threadId - The thread identifier
   * @param turnId - The turn to interrupt
   */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.codex.request('turn/interrupt', { threadId, turnId });
  }

  /**
   * Archives a thread so it no longer appears in the active thread list.
   *
   * @param threadId - The thread identifier
   */
  async archiveThread(threadId: string): Promise<void> {
    await this.applyToBranchTree(threadId, async (treeThreadId) => {
      await this.codex.request<v2.ThreadArchiveResponse>('thread/archive', {
        threadId: treeThreadId,
      });
      this.resumeRegistry.forget(treeThreadId);
    });
  }

  /**
   * Restores an archived thread back into the active thread list.
   *
   * @param threadId - The thread identifier
   * @returns The restored thread
   */
  async unarchiveThread(threadId: string): Promise<v2.ThreadUnarchiveResponse> {
    let requested: v2.ThreadUnarchiveResponse | undefined;
    await this.applyToBranchTree(threadId, async (treeThreadId) => {
      const response = await this.codex.request<v2.ThreadUnarchiveResponse>(
        'thread/unarchive',
        { threadId: treeThreadId },
      );
      if (treeThreadId === threadId) requested = response;
    });
    if (!requested) {
      throw new Error(`thread ${threadId} missing from its own branch tree`);
    }
    return requested;
  }

  /**
   * Starts context compaction for a thread.
   *
   * @param threadId - The thread identifier
   */
  async compactThread(threadId: string): Promise<void> {
    // Compaction rewrites earlier turns, and paginated forks read this thread's
    // history by reference, so descendants would observe a mutated base.
    const state = this.branches.readBranchState(threadId);
    // Local check first: it is authoritative and free, and must not be masked
    // by an app-server outage during the external scan below.
    if (state.hasKnownDescendants) {
      throw BusinessException.conflict(
        ErrorCode.threads.compactBlockedByDescendants,
        'Cannot compact a conversation that has branched descendants',
        { threadId },
      );
    }
    const external = await this.listExternalDescendantThreadIds(
      threadId,
      state.knownTreeThreadIds,
    );
    if (external.length > 0) {
      throw BusinessException.conflict(
        ErrorCode.threads.compactBlockedByDescendants,
        'Cannot compact a conversation that has branched descendants',
        { threadId },
      );
    }
    await this.codex.request<v2.ThreadCompactStartResponse>(
      'thread/compact/start',
      { threadId },
    );
  }

  /**
   * Forks a thread into a new live thread with extended history persistence.
   *
   * @param threadId - The source thread identifier
   * @returns The forked thread and resolved settings
   */
  async forkThread(threadId: string): Promise<v2.ThreadForkResponse> {
    const response = await this.codex.request<v2.ThreadForkResponse>(
      'thread/fork',
      {
        threadId,
      },
    );
    this.resumeRegistry.markResumed(response.thread.id);
    this.resumeRegistry.cacheResponse(response.thread.id, response);
    return response;
  }

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
    return this.branching.createMessageBranch(sourceThreadId, body);
  }

  /**
   * Returns branch capabilities and guard state for one thread.
   *
   * Answers from local topology only. Forks made by other clients are not
   * visible here — {@link compactThread} re-checks them on the write path,
   * where one scan of the thread list is affordable and a read is not.
   */
  readBranchState(threadId: string): BranchStateDto {
    return this.branches.readBranchState(threadId);
  }

  /** Returns the complete locally tracked branch tree for a thread. */
  readBranchTree(threadId: string): BranchTreeDto {
    return this.branches.readBranchTree(threadId);
  }

  /** Returns every locally tracked branch tree. */
  listBranchTrees(): BranchTreeDto[] {
    return this.branches.listBranchTrees();
  }

  /**
   * Updates the user-facing name for a thread.
   *
   * @param threadId - The thread identifier
   * @param name - Non-empty display name
   */
  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.codex.request<v2.ThreadSetNameResponse>('thread/name/set', {
      threadId,
      name,
    });
  }

  private isPaginatedThread(thread: v2.Thread): boolean {
    return (
      (thread as ThreadWithHistoryMode).historyMode === REQUIRED_HISTORY_MODE
    );
  }

  /**
   * Applies an operation to every locally known thread in a branch tree.
   *
   * Continues past failures instead of stopping at the first one: a half-archived
   * tree leaves hidden branches in the opposite state, which is exactly the
   * broken-switcher case whole-tree semantics exist to prevent. Errors are
   * collected and rethrown once every member has been attempted.
   *
   * @param threadId - Any member of the tree
   * @param apply - Operation to run per member thread
   * @throws The first failure, after all members have been attempted
   */
  private async applyToBranchTree(
    threadId: string,
    apply: (treeThreadId: string) => Promise<void>,
  ): Promise<void> {
    const failures: { threadId: string; error: Error }[] = [];
    for (const treeThreadId of this.branches.listKnownTreeThreadIds(threadId)) {
      try {
        await apply(treeThreadId);
      } catch (err) {
        failures.push({
          threadId: treeThreadId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
    if (failures.length === 0) return;

    this.logger.error(
      `Branch tree operation failed for ${failures.length} of its members: ` +
        failures.map((item) => item.threadId).join(', '),
    );
    throw failures[0].error;
  }

  /**
   * Finds forks of a thread that this client did not create.
   *
   * Walks `forkedFromId` over the full thread list, so it is only affordable on
   * write paths. Archived threads are included: an archived fork still reads
   * its parent's history.
   *
   * @param threadId - Thread about to be mutated
   * @param knownTreeThreadIds - Locally tracked members, excluded from the result
   */
  private async listExternalDescendantThreadIds(
    threadId: string,
    knownTreeThreadIds: string[],
  ): Promise<string[]> {
    const known = new Set(knownTreeThreadIds);
    const descendants = await this.listServerDescendantThreadIds(threadId);
    return descendants.filter((descendantId) => !known.has(descendantId));
  }

  private async listServerDescendantThreadIds(
    threadId: string,
  ): Promise<string[]> {
    const threads = [
      ...(await this.listAllThreadsForDescendantCheck(false)),
      ...(await this.listAllThreadsForDescendantCheck(true)),
    ];
    const childrenByParent = new Map<string, string[]>();
    for (const thread of threads) {
      if (!thread.forkedFromId) continue;
      const children = childrenByParent.get(thread.forkedFromId) ?? [];
      children.push(thread.id);
      childrenByParent.set(thread.forkedFromId, children);
    }

    const descendants: string[] = [];
    const queue = [...(childrenByParent.get(threadId) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || descendants.includes(current)) continue;
      descendants.push(current);
      queue.push(...(childrenByParent.get(current) ?? []));
    }
    return descendants;
  }

  private async listAllThreadsForDescendantCheck(
    archived: boolean,
  ): Promise<v2.Thread[]> {
    const data: v2.Thread[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await this.codex.request<v2.ThreadListResponse>(
        'thread/list',
        {
          cursor,
          limit: 200,
          archived,
          modelProviders: [],
        },
      );
      data.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return data;
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
