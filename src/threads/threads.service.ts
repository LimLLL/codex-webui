/**
 * Handles thread and turn operations by delegating to Codex app-server.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';
import type {
  BranchStateDto,
  BranchTreeDto,
  CreateMessageBranchDto,
} from '../conversation-branches/dto/conversation-branches.dto';
import type {
  ThreadOpenResponseDto,
  ThreadOverviewResponseDto,
  ThreadTurnCountsResponseDto,
  ThreadTurnItemsResponseDto,
  ThreadTurnsPageDto,
} from './dto/threads.dto';
import {
  ThreadsBranchingService,
  type CreateMessageBranchResult,
} from './threads-branching.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { isUnmaterializedThreadReadError } from './thread-errors';
import { previewFromUserInput } from './thread-input-preview';
import {
  ThreadHistoryService,
  type SortDirection,
  type TurnItemsView,
} from './thread-history.service';
import {
  assertPaginatedThread,
  isPaginatedThread,
  REQUIRED_HISTORY_MODE,
} from './thread-history-mode';
import {
  ThreadsOverviewService,
  type ThreadOverviewParams,
} from './threads-overview.service';

/** Maximum ancestors walked when a fork chain is not locally tracked. */
const MAX_FORK_CHAIN_WALK = 32;

type ExperimentalThreadStartParams = v2.ThreadStartParams & {
  historyMode: typeof REQUIRED_HISTORY_MODE;
};

type ThreadForkParamsWithGoalCarry = v2.ThreadForkParams & {
  deferGoalContinuation?: boolean;
  excludeTurns: true;
};

@Injectable()
export class ThreadsService {
  private readonly logger = new Logger(ThreadsService.name);

  constructor(
    private readonly codex: CodexService,
    private readonly resumeRegistry: ThreadResumeRegistryService,
    private readonly branches: ConversationBranchesService,
    private readonly branchMutations: ConversationBranchMutationsService,
    private readonly branching: ThreadsBranchingService,
    private readonly deletionRegistry: ThreadDeletionRegistryService,
    private readonly history: ThreadHistoryService,
    private readonly overview: ThreadsOverviewService,
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
    if (!isPaginatedThread(response.thread)) {
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

  /** Lists branch-collapsed conversation overview rows for the sidebar. */
  async listOverview(
    params: ThreadOverviewParams,
  ): Promise<ThreadOverviewResponseDto> {
    return this.overview.listOverview(params);
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
   * If `includeTurns` is requested before the thread's first user message,
   * app-server refuses to reconstruct history rather than returning an empty
   * list. Retrying without turns is the only way to answer at all, and an
   * unmaterialized thread has no turns to lose.
   *
   * @param threadId - The thread identifier
   * @param includeTurns - Whether to include turn history
   * @returns The thread data
   */
  async readThread(
    threadId: string,
    includeTurns = false,
  ): Promise<v2.ThreadReadResponse> {
    let response: v2.ThreadReadResponse;
    try {
      response = await this.codex.request<v2.ThreadReadResponse>(
        'thread/read',
        {
          threadId,
          includeTurns,
        },
      );
    } catch (err) {
      if (!includeTurns || !isUnmaterializedThreadReadError(err)) throw err;
      const metadata = await this.codex.request<v2.ThreadReadResponse>(
        'thread/read',
        { threadId, includeTurns: false },
      );
      response = { thread: { ...metadata.thread, turns: [] } };
    }
    assertPaginatedThread(response.thread, 'thread/read');
    return response;
  }

  /**
   * Ensures a persisted thread is resumed once for the current app-server generation.
   *
   * @param threadId - The thread identifier
   * @param options - `recordActive: false` for background reopens that must not
   *   move the tree's active-branch pointer
   * @returns The resumed or already-active thread with resolved settings
   */
  async resumeThread(
    threadId: string,
    options: { recordActive?: boolean } = {},
  ): Promise<ThreadOpenResponseDto> {
    this.deletionRegistry.assertMutable(threadId);
    const response = await this.resumeRegistry.ensureOpened(threadId);
    // The pointer means "the branch a person last looked at", so only a
    // deliberate open may move it. Background reopens — app-server auto-resume,
    // and the client restoring its loaded threads after a refresh or a socket
    // reconnect — walk every loaded thread in whatever order they come back;
    // letting those write would leave each tree pointing at whichever member
    // happened to be restored last, which is exactly the behaviour this pointer
    // was added to fix.
    if (options.recordActive !== false) {
      // Deliberately not awaited. The pointer only decides where a later
      // sidebar click lands, and resolving it can cost a round trip per
      // ancestor for a thread whose topology is not locally known — on the one
      // path this round exists to make faster.
      void this.recordActiveBranchMember(response.thread).catch(
        (err: unknown) => {
          this.logger.debug(
            `Could not record active branch member for thread=${threadId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        },
      );
    }
    return response;
  }

  /** Pages turn history without acquiring writer ownership. */
  async listTurns(params: {
    threadId: string;
    cursor?: string;
    limit?: number;
    sortDirection?: SortDirection;
    itemsView?: TurnItemsView;
  }): Promise<ThreadTurnsPageDto> {
    return this.history.listTurns(params);
  }

  /**
   * Reads one turn's full persisted items without resuming the thread.
   *
   * Lets a client that opened a thread with the cheap `summary` view top a
   * single turn up to full detail, recovering the `reasoning` and `plan` items
   * that view omits.
   *
   * @param threadId - Thread that owns the turn
   * @param turnId - Turn whose items should be returned
   * @returns The turn's items, oldest first
   */
  async listTurnItems(
    threadId: string,
    turnId: string,
  ): Promise<ThreadTurnItemsResponseDto> {
    const entries = await this.history.listTurnItems(threadId, turnId);
    return { items: entries.map((entry) => entry.item) };
  }

  /** Counts graph-node turns without resuming; failures become unknown counts. */
  async countTurns(threadIds: string[]): Promise<ThreadTurnCountsResponseDto> {
    return {
      counts: await this.history.countTurnsForThreads(threadIds),
    };
  }

  /**
   * Starts a new turn (user message + agent response cycle).
   *
   * @param params - Turn start parameters (threadId, input, model overrides, etc.)
   * @returns The created turn
   */
  async startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse> {
    this.deletionRegistry.assertMutable(params.threadId);
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
    this.deletionRegistry.assertMutable(params.threadId);
    return this.codex.request<v2.TurnSteerResponse>('turn/steer', params);
  }

  /**
   * Interrupts an in-progress turn.
   *
   * @param threadId - The thread identifier
   * @param turnId - The turn to interrupt
   */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.deletionRegistry.assertMutable(threadId);
    await this.codex.request('turn/interrupt', { threadId, turnId });
  }

  /**
   * Archives a thread so it no longer appears in the active thread list.
   *
   * @param threadId - The thread identifier
   */
  async archiveThread(threadId: string): Promise<void> {
    this.deletionRegistry.assertMutable(threadId);
    await this.applyToBranchTree(threadId, async (treeThreadId) => {
      this.deletionRegistry.assertMutable(treeThreadId);
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
    this.deletionRegistry.assertMutable(threadId);
    let requested: v2.ThreadUnarchiveResponse | undefined;
    await this.applyToBranchTree(threadId, async (treeThreadId) => {
      this.deletionRegistry.assertMutable(treeThreadId);
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
    this.deletionRegistry.assertMutable(threadId);
    // This guard is ours, not a mirror of app-server: verified against 0.149.0,
    // `thread/compact/start` accepts a thread that has forks (unlike
    // `thread/delete`, which rejects it outright). We block it anyway because
    // compaction rewrites earlier turns while paginated forks address their
    // parent's history by ordinal and byte offset, so a descendant's base can
    // silently stop lining up.
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
   * Forks a thread and records its inherited history as local provenance.
   *
   * @param threadId - The source thread identifier
   * @returns The forked thread and resolved settings
   */
  async forkThread(
    threadId: string,
    options: { carryGoal?: boolean; ephemeral?: boolean } = {},
  ): Promise<v2.ThreadForkResponse> {
    this.deletionRegistry.assertMutable(threadId);
    if (options.carryGoal && options.ephemeral) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidForkOptions,
        'deferGoalContinuation cannot be combined with ephemeral forks',
      );
    }
    const source = await this.history.readThreadMetadata(threadId);
    if (source.thread.id !== threadId) {
      throw new BusinessException(
        ErrorCode.threads.branchForkUnsupported,
        HttpStatus.BAD_GATEWAY,
        'thread/read returned a different source conversation id',
        { threadId, returnedThreadId: source.thread.id },
      );
    }
    const treeRootThreadId = this.branches.resolveTreeRootThreadId(
      source.thread.id,
    );
    const params: ThreadForkParamsWithGoalCarry = {
      threadId,
      excludeTurns: true,
      ...(options.ephemeral !== undefined && { ephemeral: options.ephemeral }),
      ...(options.carryGoal && { deferGoalContinuation: true }),
    };
    const response = await this.codex.request<v2.ThreadForkResponse>(
      'thread/fork',
      params,
    );
    const childThreadId = response.thread.id;
    if (childThreadId === threadId) {
      throw new BusinessException(
        ErrorCode.threads.branchForkUnsupported,
        HttpStatus.BAD_GATEWAY,
        'thread/fork returned the source conversation id',
        { threadId },
      );
    }

    let inheritedTurnIds: string[];
    try {
      const forkedFromId = response.thread.forkedFromId;
      if (forkedFromId && forkedFromId !== threadId) {
        throw new Error(
          `thread/fork returned parent ${forkedFromId} instead of ${threadId}`,
        );
      }
      assertPaginatedThread(response.thread, 'thread/fork');
      inheritedTurnIds = await this.history.listAllTurnIds(childThreadId);
    } catch (err) {
      const cleanupError = await this.deleteUntrackedThread(childThreadId);
      if (!cleanupError) throw err;
      throw BusinessException.internal(
        ErrorCode.threads.branchMetadataFailed,
        `Fork validation failed and cleanup of ${childThreadId} also failed: ${cleanupError.message}`,
        { threadId, childThreadId },
      );
    }

    try {
      this.branchMutations.recordLocalFork({
        sourceThreadId: threadId,
        childThreadId,
        treeRootThreadId,
        inheritedTurnIds,
      });
    } catch (err) {
      // A durable edge is the commit boundary. Never compensate after it, even
      // if a later local projection unexpectedly fails.
      if (this.branches.hasForkEdge(childThreadId)) {
        throw BusinessException.internal(
          ErrorCode.threads.branchMetadataFailed,
          'Fork provenance was persisted but the response could not be completed; the child conversation was preserved',
          { threadId, childThreadId },
        );
      }
      const cleanupError = await this.deleteUntrackedThread(childThreadId);
      const cleanupSuffix = cleanupError
        ? ` Cleanup of ${childThreadId} also failed: ${cleanupError.message}`
        : '';
      throw BusinessException.internal(
        ErrorCode.threads.branchMetadataFailed,
        `Failed to persist fork provenance: ${
          err instanceof Error ? err.message : String(err)
        }.${cleanupSuffix}`,
        { threadId, childThreadId },
      );
    }
    this.resumeRegistry.markResumed(childThreadId);
    this.resumeRegistry.cacheResponse(childThreadId, response);
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
    this.deletionRegistry.assertMutable(sourceThreadId);
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
    this.deletionRegistry.assertMutable(threadId);
    await this.codex.request<v2.ThreadSetNameResponse>('thread/name/set', {
      threadId,
      name,
    });
  }

  private async recordActiveBranchMember(thread: {
    id: string;
    forkedFromId?: string | null;
  }): Promise<void> {
    const treeRootThreadId = await this.resolveActivePointerRoot(thread);
    // Re-checked after the resolve, not only before it. Resolving the root can
    // await app-server reads, and a delete may have claimed the thread in the
    // meantime — deletion clears pointers during cleanup, so a write landing
    // afterwards would reinstate one naming a destroyed thread. Reads validate
    // membership and would ignore it, but the invariant is worth holding at the
    // write rather than relying on every reader to compensate.
    this.deletionRegistry.assertMutable(thread.id);
    this.deletionRegistry.assertMutable(treeRootThreadId);
    this.branches.setActiveMember(treeRootThreadId, thread.id);
  }

  private async resolveActivePointerRoot(thread: {
    id: string;
    forkedFromId?: string | null;
  }): Promise<string> {
    const localRoot = this.branches.resolveTreeRootThreadId(thread.id);
    if (localRoot !== thread.id) return localRoot;

    // Bounded because each step is a round trip and the chain comes from data
    // this client did not create. A pathological chain must degrade to a
    // slightly wrong pointer, never to an unbounded walk on every open.
    let current: { id: string; forkedFromId?: string | null } = thread;
    const seen = new Set<string>();
    let steps = 0;
    while (
      current.forkedFromId &&
      !seen.has(current.id) &&
      steps < MAX_FORK_CHAIN_WALK
    ) {
      seen.add(current.id);
      steps += 1;
      const parentThreadId = current.forkedFromId;
      try {
        const parent = await this.history.readThreadMetadata(parentThreadId);
        current = parent.thread;
      } catch (err) {
        this.logger.debug(
          `Could not resolve branch root through parent=${parentThreadId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return parentThreadId;
      }
    }
    return current.id;
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
