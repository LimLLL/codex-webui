/** Conversation timeline state. */
import {
  type TimelineEntry,
  type TurnFailure,
  type TurnItem,
  type TurnPlanState,
} from '../types/timeline';
import {
  type ApprovalRequest,
  type ResolvableApprovalDecision,
  type UserInputRequest,
} from '../types/approval';
import {
  type PersistedTurnErrorDto,
  type ThreadDto,
  type TurnDto,
} from '../generated/api';
import {
  type ThreadTokenUsage,
  type ThreadStatusType,
} from '../types/codex-notifications';

export type ThreadMode = 'live' | 'readOnly';

export interface ThreadRuntimeState {
  threadId: string;
  /** Working directory of this thread. */
  threadCwd: string | null;
  /** Display title, falling back to preview/id in UI. */
  threadTitle: string | null;
  /** Live threads are resumable; read-only threads are archived snapshots. */
  threadMode: ThreadMode;
  timeline: TimelineEntry[];
  /** A start submission remains pending until its response or lifecycle is reconciled. */
  turnStartPending: boolean;
  /** Full first-page request state, independent of execution and retained usable history. */
  historyRequest: 'idle' | 'loading' | 'error';
  historyError: string | null;
  /** Whether writer ownership and next-turn settings have been resolved. */
  openState: 'unopened' | 'opening' | 'ready' | 'error';
  expandedReasoning: Set<string>;
  approvals: Record<string, ApprovalRequest>;
  userInputRequests: Record<string, UserInputRequest>;
  tokenUsageByTurn: Record<string, ThreadTokenUsage>;
  latestTokenUsage: ThreadTokenUsage | null;
  threadStatus: ThreadStatusType | null;
  activeTurnId: string | null;
  pendingResolvedRequestIds: Set<string>;
  hydrated: boolean;
  /**
   * Cursor for the next *older* page of turns, or null when history is complete.
   *
   * Opening a thread no longer materializes its whole history: the server
   * returns metadata plus the most recent page. Everything before that is
   * fetched on demand, so the timeline can be complete-but-truncated rather
   * than simply empty, and the two states must stay distinguishable.
   */
  historyCursor: string | null;
  /** True while an older-history page is being fetched. */
  historyLoading: boolean;
  /**
   * Why this thread cannot be written to, or null when it is writable.
   *
   * Only one app-server process may hold a paginated thread open for writing.
   * Losing that race is not a failure to open — the history is still readable —
   * so it degrades to a read-only view that says why rather than an error.
   */
  readOnlyReason: string | null;
  /**
   * True once this conversation is known to have been destroyed elsewhere.
   *
   * The transcript is deliberately kept — see the `thread/deleted` handler — but
   * keeping it must not leave the conversation writable: every send would fail
   * against a thread that no longer exists. Distinct from
   * {@link readOnlyReason} because the cause and the remedy differ, and telling
   * a user their deleted conversation is "open in another client" is worse than
   * saying nothing.
   */
  deletedRemotely: boolean;
  /** Millisecond timestamp for LRU-style idle subscription cleanup. */
  lastActivityAt: number;
}

export interface ThreadRuntimeInput {
  threadId: string;
  cwd?: string | null;
  title?: string | null;
  mode?: ThreadMode;
}

export interface TimelineState {
  selectedThreadId: string | null;
  threadsById: Record<string, ThreadRuntimeState>;
  subscribedThreadIds: Set<string>;
  maxIdleSubscriptions: number;

  threadId: string | null;
  threadCwd: string | null;
  threadTitle: string | null;
  threadMode: ThreadMode;
  timeline: TimelineEntry[];
  /** A start submission remains pending until its response or lifecycle is reconciled. */
  turnStartPending: boolean;
  /** Full first-page request state, independent of execution and retained usable history. */
  historyRequest: 'idle' | 'loading' | 'error';
  historyError: string | null;
  /** Whether writer ownership and next-turn settings have been resolved. */
  openState: 'unopened' | 'opening' | 'ready' | 'error';
  expandedReasoning: Set<string>;
  approvals: Record<string, ApprovalRequest>;
  userInputRequests: Record<string, UserInputRequest>;
  tokenUsageByTurn: Record<string, ThreadTokenUsage>;
  latestTokenUsage: ThreadTokenUsage | null;
  threadStatus: ThreadStatusType | null;
  activeTurnId: string | null;
  pendingResolvedRequestIds: Set<string>;
  /**
   * Mirrors the selected thread's real hydration state.
   *
   * This used to be absent here and hardcoded true when the flat selection was
   * read back as a runtime, which asserted that merely selecting a thread had
   * loaded it. Selection is not hydration: a thread can be selected while its
   * transcript has never been fetched, and the flat state is written back into
   * `threadsById`, so the false claim was persisted rather than just misread.
   */
  hydrated: boolean;
  historyCursor: string | null;
  historyLoading: boolean;
  readOnlyReason: string | null;
  deletedRemotely: boolean;
  lastActivityAt: number;

  ensureThreadState: (input: ThreadRuntimeInput) => void;
  selectThread: (threadId: string | null) => void;
  resubscribeAll: (onSubscribed?: (threadId: string) => void) => void;
  unsubscribeThread: (threadId: string) => void;
  forgetThreads: (threadIds: string[]) => void;
  setMaxIdleSubscriptions: (limit: number) => void;
  cleanupIdleThreadSubscriptions: (limit?: number) => void;
  getThreadTitle: (threadId: string) => string;
  getThreadRuntime: (threadId: string) => ThreadRuntimeState | null;
  isThreadBusy: (threadId: string) => boolean;
  hasPendingApproval: (threadId: string) => boolean;

  setActiveThread: (
    threadId: string,
    cwd?: string | null,
    title?: string | null,
  ) => Promise<boolean>;
  setReadOnlyThread: (thread: ThreadDto) => void;
  clearThread: () => void;
  hydrateTimeline: (turns: TurnDto[], cwd?: string | null) => void;
  setThreadTitle: (title: string | null) => void;
  addUserMessage: (text: string, images?: string[]) => void;
  addSystemError: (message: string) => void;
  addSystemMessage: (
    message: string,
    severity?: 'info' | 'warning' | 'error',
  ) => void;
  upsertTurnFailure: (failure: TurnFailure) => void;

  toggleReasoning: (itemId: string) => void;
  updateCurrentTurn: (
    turnId: string,
    updater: (
      items: TurnItem[],
      completed: boolean,
    ) => { items: TurnItem[]; completed: boolean },
  ) => void;
  updateTurnItem: (
    turnId: string,
    itemId: string,
    updater: (existing: TurnItem | undefined) => TurnItem,
  ) => void;
  updateTurnDiff: (turnId: string, diff: string) => void;
  updateTurnPlan: (turnId: string, plan: TurnPlanState) => void;
  appendPlanDelta: (turnId: string, itemId: string, delta: string) => void;
  setTurnStartPending: (turnStartPending: boolean) => void;
  expandReasoning: (itemId: string) => void;
  collapseReasoning: (itemId: string) => void;
  addApproval: (approval: ApprovalRequest) => void;
  addUserInputRequest: (request: UserInputRequest) => void;
  resolveApproval: (
    requestId: string | number,
    decision: ResolvableApprovalDecision,
  ) => void;
  resolveUserInputRequest: (requestId: string | number) => void;
  setTokenUsage: (turnId: string, usage: ThreadTokenUsage) => void;
  setThreadStatus: (status: ThreadStatusType | null) => void;
  setActiveTurnId: (turnId: string | null) => void;
  clearActiveTurn: () => void;
  hydrateTokenUsage: (
    turns: Array<{ turnId: string; usage: ThreadTokenUsage }>,
    baseline?: ThreadRuntimeState,
  ) => void;
  hydrateTurnDiffs: (turns: Array<{ turnId: string; diff: string }>) => void;
  resolveApprovalByRequestId: (requestId: string | number) => void;

  hydrateTimelineForThread: (
    threadId: string,
    turns: TurnDto[],
    cwd?: string | null,
  ) => void;
  hydrateOpenedThread: (params: {
    threadId: string;
    turnsNewestFirst: TurnDto[];
    historyCursor: string | null;
    readOnlyReason: string | null;
    /** Turn identities captured before the newest-page read, not live arrivals. */
    knownTurnIdsAtRead?: ReadonlySet<string>;
    cwd?: string | null;
  }) => void;
  prependHistoryForThread: (
    threadId: string,
    turnsNewestFirst: TurnDto[],
    nextCursor: string | null,
  ) => void;
  setHistoryLoadingForThread: (threadId: string, loading: boolean) => void;
  markThreadDeletedRemotely: (threadId: string, message: string) => void;
  hydrateTokenUsageForThread: (
    threadId: string,
    turns: Array<{ turnId: string; usage: ThreadTokenUsage }>,
    baseline?: ThreadRuntimeState,
  ) => void;
  hydrateTurnDiffsForThread: (
    threadId: string,
    turns: Array<{ turnId: string; diff: string }>,
    baseline?: ThreadRuntimeState,
  ) => void;
  hydrateTurnErrorsForThread: (
    threadId: string,
    errors: PersistedTurnErrorDto[],
  ) => void;
  updateCurrentTurnForThread: (
    threadId: string,
    turnId: string,
    updater: (
      items: TurnItem[],
      completed: boolean,
    ) => { items: TurnItem[]; completed: boolean },
  ) => void;
  updateTurnItemForThread: (
    threadId: string,
    turnId: string,
    itemId: string,
    updater: (existing: TurnItem | undefined) => TurnItem,
  ) => void;
  /** Applies an explicitly supplied full item set without any render-triggered request. */
  applyFullTurnItemsForThread: (
    threadId: string,
    turnId: string,
    items: Array<Record<string, unknown>>,
  ) => void;
  /**
   * Repairs a turn from persisted items without declaring its history complete.
   *
   * Used for a turn that is still running and for turns repaired after a
   * reconnect, where more items may still arrive.
   */
  applyRecoveredTurnItemsForThread: (
    threadId: string,
    turnId: string,
    items: Array<Record<string, unknown>>,
    baselineSeq: number,
  ) => void;
  /**
   * Settles turn lifecycle from freshly read turn headers.
   *
   * Items and lifecycle are separate facts on separate notifications, so
   * repairing a transcript after a disconnect does not repair the spinner. Only
   * turns the headers actually name are touched, and only forwards.
   */
  settleTurnLifecycleForThread: (
    threadId: string,
    turns: Array<{ id: string; status: TurnDto['status'] }>,
  ) => void;
  updateTurnDiffForThread: (
    threadId: string,
    turnId: string,
    diff: string,
  ) => void;
  updateTurnPlanForThread: (
    threadId: string,
    turnId: string,
    plan: TurnPlanState,
  ) => void;
  appendPlanDeltaForThread: (
    threadId: string,
    turnId: string,
    itemId: string,
    delta: string,
  ) => void;
  /**
   * Replaces one plan item's text with its authoritative accumulated value.
   *
   * Plan text streams as deltas like any other item, so a fragment missed
   * during a disconnect leaves a truncated plan on screen. The terminal payload
   * carries the whole text rather than a tail, which makes repair a
   * replacement — appending it would duplicate everything received so far.
   */
  setPlanTextForThread: (
    threadId: string,
    turnId: string,
    itemId: string,
    text: string,
  ) => void;
  setTurnStartPendingForThread: (
    threadId: string,
    turnStartPending: boolean,
  ) => void;
  /** Updates only opening/history readiness; never changes turn execution. */
  setOpenStateForThread: (
    threadId: string,
    state: Partial<
      Pick<ThreadRuntimeState, 'historyRequest' | 'historyError' | 'openState'>
    >,
  ) => void;
  addApprovalForThread: (threadId: string, approval: ApprovalRequest) => void;
  addUserInputRequestForThread: (
    threadId: string,
    request: UserInputRequest,
  ) => void;
  resolveApprovalForThread: (
    threadId: string,
    requestId: string | number,
    decision: ResolvableApprovalDecision,
  ) => void;
  resolveUserInputRequestForThread: (
    threadId: string,
    requestId: string | number,
  ) => void;
  setTokenUsageForThread: (
    threadId: string,
    turnId: string,
    usage: ThreadTokenUsage,
  ) => void;
  setThreadStatusForThread: (
    threadId: string,
    status: ThreadStatusType | null,
  ) => void;
  setActiveTurnIdForThread: (threadId: string, turnId: string | null) => void;
  clearActiveTurnForThread: (threadId: string) => void;
  addSystemMessageForThread: (
    threadId: string,
    message: string,
    severity?: 'info' | 'warning' | 'error',
    turnId?: string,
    requestInstanceId?: string,
  ) => void;
  addSystemErrorForThread: (threadId: string, message: string) => void;
  upsertTurnFailureForThread: (threadId: string, failure: TurnFailure) => void;
  setThreadTitleForThread: (threadId: string, title: string | null) => void;
  resolveApprovalByRequestIdForThread: (
    threadId: string,
    requestId: string | number,
    generation?: number,
    instanceId?: string,
    status?: 'submitted' | 'resolved' | 'failed',
    decision?: ResolvableApprovalDecision,
  ) => void;
}

/** Shared store operations used by the concrete timeline action groups. */
export interface TimelineActionContext {
  set: import('zustand').StoreApi<TimelineState>['setState'];
  get: () => TimelineState;
  applyThreadUpdate: (
    threadId: string,
    updater: (runtime: ThreadRuntimeState) => ThreadRuntimeState,
  ) => void;
}
