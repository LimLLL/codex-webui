/**
 * Zustand store for multi-thread chat timeline state.
 * The selected thread only controls visibility; live thread state is isolated by threadId.
 */
import { create } from 'zustand';
import { getSocket } from '../socket';
import type { TimelineEntry, TurnItem, TurnPlanState } from '../types/timeline';
import type { ApprovalRequest, ResolvableApprovalDecision, UserInputRequest } from '../types/approval';
import type { ThreadDto, TurnDto, FileUpdateChangeDto } from '../generated/api';
import type { ThreadTokenUsage, ThreadStatusType } from '../types/codex-notifications';

const DEFAULT_MAX_IDLE_SUBSCRIPTIONS = 30;
const MIN_MAX_IDLE_SUBSCRIPTIONS = 5;
const MAX_MAX_IDLE_SUBSCRIPTIONS = 200;
const IDLE_SUBSCRIPTION_TTL_MS = 15 * 60 * 1000;

/** Keeps the store-side fallback aligned with the backend runtime setting. */
function normalizeMaxIdleSubscriptions(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_MAX_IDLE_SUBSCRIPTIONS;
  return Math.min(
    MAX_MAX_IDLE_SUBSCRIPTIONS,
    Math.max(MIN_MAX_IDLE_SUBSCRIPTIONS, Math.trunc(limit)),
  );
}

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
  loading: boolean;
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

interface ThreadRuntimeInput {
  threadId: string;
  cwd?: string | null;
  title?: string | null;
  mode?: ThreadMode;
}


/** Converts a persisted turn item to a TurnItem for rendering. */
function parseTurnItem(item: Record<string, unknown>): TurnItem | null {
  const type = item.type as string;
  const id = item.id as string;

  switch (type) {
    case 'userMessage':
      return null;
    case 'reasoning':
      return {
        type: 'reasoning',
        itemId: id,
        content: ((item.summary as string[]) ?? []).join('\n'),
        completed: true,
      };
    case 'agentMessage':
      return {
        type: 'agentMessage',
        itemId: id,
        content: (item.text as string) ?? '',
        completed: true,
      };
    case 'mcpToolCall':
      return {
        type: 'mcpToolCall',
        itemId: id,
        content: item.result ? JSON.stringify(item.result, null, 2).slice(0, 500) : '',
        completed: true,
        toolServer: (item.server as string) ?? '',
        toolName: (item.tool as string) ?? '',
        toolArgs: item.arguments ? JSON.stringify(item.arguments, null, 2) : '',
      };
    case 'commandExecution':
      return {
        type: 'commandExecution',
        itemId: id,
        content: (item.aggregatedOutput as string) ?? (item.text as string) ?? '',
        completed: true,
        command: item.command as string | undefined,
        exitCode: item.exitCode as number | undefined,
      };
    case 'fileChange': {
      const changes = item.changes as FileUpdateChangeDto[] | undefined;
      return {
        type: 'fileChange',
        itemId: id,
        content: (item.text as string) ?? '',
        completed: true,
        filePath: changes?.[0]?.path,
        fileDiff: changes?.[0]?.diff ?? '',
      };
    }
    case 'contextCompaction':
      return {
        type: 'contextCompaction',
        itemId: id,
        content: '',
        completed: true,
      };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      // `review` names what was reviewed (e.g. "current changes"); it is the
      // only useful text these markers carry.
      return {
        type,
        itemId: id,
        content: (item.review as string) ?? '',
        completed: true,
      };
    default:
      return null;
  }
}

/** Extracts persisted plan text into a plan panel fallback. */
function parsePersistedPlan(items: Array<Record<string, unknown>>): TurnPlanState | undefined {
  const planText = items
    .filter((item) => item.type === 'plan')
    .map((item) => (typeof item.text === 'string' ? item.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n');

  return planText
    ? { explanation: planText, steps: [] }
    : undefined;
}

/** Converts persisted turns into timeline entries. */
function turnsToTimeline(turns: TurnDto[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const turn of turns) {
    const items = (turn.items ?? []) as Array<Record<string, unknown>>;

    const userMsg = items.find((it) => it.type === 'userMessage');
    if (userMsg) {
      const content = userMsg.content as Array<{ type: string; text?: string; path?: string; url?: string }> | undefined;
      const textParts = content?.filter((c) => c.type === 'text').map((c) => c.text ?? '') ?? [];
      const text = textParts.join('\n') || ((userMsg.text as string) ?? '');
      const images: string[] = [];
      for (const block of content ?? []) {
        if (block.type === 'localImage' && block.path) images.push(block.path);
        else if (block.type === 'image' && block.url) images.push(block.url);
      }
      entries.push({
        kind: 'user',
        content: text,
        turnId: turn.id,
        ...(images.length > 0 && { images }),
      });
    }

    const plan = parsePersistedPlan(items);
    const turnItems = items
      .map(parseTurnItem)
      .filter((it): it is TurnItem => it !== null);

    // A summary turn may look empty here purely because app-server withheld
    // its reasoning and plan items, so it still needs an entry to hang the
    // on-demand top-up off.
    const itemsView = turn.itemsView as
      | 'notLoaded'
      | 'summary'
      | 'full'
      | undefined;
    if (turnItems.length > 0 || plan || itemsView === 'summary') {
      entries.push({
        kind: 'turn',
        turnId: turn.id,
        plan,
        items: turnItems,
        completed: turn.status === 'completed',
        ...(itemsView && { itemsView }),
      });
    }
  }

  return entries;
}

/**
 * Collects every turn id already represented in a timeline.
 *
 * Must consider `user` entries as well as `turn` entries: a turn carrying only
 * a user message — one that was interrupted, or is still awaiting its first
 * item — produces a `user` entry and no `turn` entry at all. Reading turn ids
 * from `turn` entries alone therefore misses it, which lets a history page
 * re-insert that message on paging and makes an already-loaded page look new
 * on reopen.
 */
function collectKnownTurnIds(timeline: TimelineEntry[]): Set<string> {
  const turnIds = new Set<string>();
  for (const entry of timeline) {
    if (entry.kind !== 'user' && entry.kind !== 'turn') continue;
    if (entry.turnId) turnIds.add(entry.turnId);
  }
  return turnIds;
}

function createRuntime(input: ThreadRuntimeInput): ThreadRuntimeState {
  return {
    threadId: input.threadId,
    threadCwd: input.cwd ?? null,
    threadTitle: input.title ?? null,
    threadMode: input.mode ?? 'live',
    timeline: [],
    loading: false,
    expandedReasoning: new Set<string>(),
    approvals: {},
    userInputRequests: {},
    tokenUsageByTurn: {},
    latestTokenUsage: null,
    threadStatus: null,
    activeTurnId: null,
    pendingResolvedRequestIds: new Set<string>(),
    hydrated: false,
    historyCursor: null,
    historyLoading: false,
    readOnlyReason: null,
    deletedRemotely: false,
    lastActivityAt: Date.now(),
  };
}

function runtimeFromSelected(state: TimelineState): ThreadRuntimeState | null {
  if (!state.threadId) return null;
  return {
    threadId: state.threadId,
    threadCwd: state.threadCwd,
    threadTitle: state.threadTitle,
    threadMode: state.threadMode,
    timeline: state.timeline,
    loading: state.loading,
    expandedReasoning: state.expandedReasoning,
    approvals: state.approvals,
    userInputRequests: state.userInputRequests,
    tokenUsageByTurn: state.tokenUsageByTurn,
    latestTokenUsage: state.latestTokenUsage,
    threadStatus: state.threadStatus,
    activeTurnId: state.activeTurnId,
    pendingResolvedRequestIds: state.pendingResolvedRequestIds,
    hydrated: true,
    historyCursor: state.historyCursor,
    historyLoading: state.historyLoading,
    readOnlyReason: state.readOnlyReason,
    deletedRemotely: state.deletedRemotely,
    lastActivityAt: state.lastActivityAt,
  };
}

function readRuntime(state: TimelineState, threadId: string): ThreadRuntimeState | null {
  if (state.threadId === threadId) return runtimeFromSelected(state);
  return state.threadsById[threadId] ?? null;
}

function selectedFields(runtime: ThreadRuntimeState | null): Partial<TimelineState> {
  if (!runtime) {
    return {
      threadId: null,
      threadCwd: null,
      threadTitle: null,
      threadMode: 'live',
      timeline: [],
      loading: false,
      expandedReasoning: new Set<string>(),
      approvals: {},
      userInputRequests: {},
      tokenUsageByTurn: {},
      latestTokenUsage: null,
      threadStatus: null,
      activeTurnId: null,
      pendingResolvedRequestIds: new Set<string>(),
      historyCursor: null,
      historyLoading: false,
      readOnlyReason: null,
      deletedRemotely: false,
      lastActivityAt: 0,
    };
  }
  return {
    threadId: runtime.threadId,
    threadCwd: runtime.threadCwd,
    threadTitle: runtime.threadTitle,
    threadMode: runtime.threadMode,
    timeline: runtime.timeline,
    loading: runtime.loading,
    expandedReasoning: runtime.expandedReasoning,
    approvals: runtime.approvals,
    userInputRequests: runtime.userInputRequests,
    tokenUsageByTurn: runtime.tokenUsageByTurn,
    latestTokenUsage: runtime.latestTokenUsage,
    threadStatus: runtime.threadStatus,
    activeTurnId: runtime.activeTurnId,
    pendingResolvedRequestIds: runtime.pendingResolvedRequestIds,
    historyCursor: runtime.historyCursor,
    historyLoading: runtime.historyLoading,
    readOnlyReason: runtime.readOnlyReason,
    deletedRemotely: runtime.deletedRemotely,
    lastActivityAt: runtime.lastActivityAt,
  };
}

function persistSelectedRuntime(state: TimelineState): Record<string, ThreadRuntimeState> {
  const selected = runtimeFromSelected(state);
  if (!selected) return state.threadsById;
  return { ...state.threadsById, [selected.threadId]: selected };
}

function hasPendingApproval(runtime: ThreadRuntimeState | null): boolean {
  if (!runtime) return false;
  const flagBlocked =
    runtime.threadStatus?.type === 'active' &&
    runtime.threadStatus.activeFlags.includes('waitingOnApproval');
  const cardBlocked = Object.values(runtime.approvals).some((approval) => approval.status === 'pending');
  return flagBlocked || cardBlocked;
}

function hasPendingUserInput(runtime: ThreadRuntimeState | null): boolean {
  if (!runtime) return false;
  return Object.values(runtime.userInputRequests).some((request) => request.status === 'pending');
}

function touchRuntime(runtime: ThreadRuntimeState): ThreadRuntimeState {
  return { ...runtime, lastActivityAt: Date.now() };
}

function isSafeToCleanupIdleRuntime(
  runtime: ThreadRuntimeState | null,
  selectedThreadId: string | null,
): runtime is ThreadRuntimeState {
  return Boolean(
    runtime &&
      runtime.threadId !== selectedThreadId &&
      !runtime.loading &&
      !runtime.activeTurnId &&
      runtime.pendingResolvedRequestIds.size === 0 &&
      runtime.threadStatus?.type !== 'active' &&
      !hasPendingApproval(runtime) &&
      !hasPendingUserInput(runtime),
  );
}

function compareIdleCleanupCandidates(
  now: number,
  a: { lastActivityAt: number },
  b: { lastActivityAt: number },
): number {
  const aExpired = now - a.lastActivityAt >= IDLE_SUBSCRIPTION_TTL_MS;
  const bExpired = now - b.lastActivityAt >= IDLE_SUBSCRIPTION_TTL_MS;
  if (aExpired !== bExpired) return aExpired ? -1 : 1;
  return a.lastActivityAt - b.lastActivityAt;
}

/** Ensures a turn entry exists in timeline for a given turnId (needed for request-only cards). */
function ensureTurnEntry(timeline: TimelineEntry[], turnId: string): TimelineEntry[] {
  if (timeline.some((entry) => entry.kind === 'turn' && entry.turnId === turnId)) {
    return timeline;
  }
  return [...timeline, { kind: 'turn', turnId, items: [], completed: false }];
}

/**
 * Binds a started turn to the optimistically appended user message.
 *
 * Messages are rendered before `turn/start` returns, so the newest unbound user
 * entry is the one this turn belongs to. Without the binding the message would
 * carry no turn id until the next hydration, and could not be branched.
 */
function bindPendingUserMessage(
  timeline: TimelineEntry[],
  turnId: string,
): TimelineEntry[] {
  if (timeline.some((entry) => entry.kind === 'user' && entry.turnId === turnId)) {
    return timeline;
  }
  const index = timeline.findLastIndex(
    (entry) => entry.kind === 'user' && entry.turnId === undefined,
  );
  if (index < 0) return timeline;

  const next = [...timeline];
  next[index] = { ...next[index], turnId } as TimelineEntry;
  return next;
}

/** After hydration, preserve turn entries for blocking request-only cards. */
function ensureRequestTurnEntries(
  timeline: TimelineEntry[],
  approvals: Record<string, ApprovalRequest>,
  userInputs: Record<string, UserInputRequest>,
): TimelineEntry[] {
  const withApprovals = Object.values(approvals).reduce(
    (next, approval) => ensureTurnEntry(next, approval.turnId),
    timeline,
  );
  return Object.values(userInputs).reduce(
    (next, request) => ensureTurnEntry(next, request.turnId),
    withApprovals,
  );
}

function updateRuntimeCurrentTurn(
  runtime: ThreadRuntimeState,
  turnId: string,
  updater: (
    items: TurnItem[],
    completed: boolean,
  ) => { items: TurnItem[]; completed: boolean },
): ThreadRuntimeState {
  const idx = runtime.timeline.findIndex(
    (entry) => entry.kind === 'turn' && entry.turnId === turnId,
  );

  if (idx >= 0) {
    const entry = runtime.timeline[idx];
    if (entry.kind !== 'turn') return runtime;
    const result = updater(entry.items, entry.completed);
    const timeline = [...runtime.timeline];
    timeline[idx] = { ...entry, items: result.items, completed: result.completed };
    return { ...runtime, timeline };
  }

  const result = updater([], false);
  return {
    ...runtime,
    timeline: [
      ...runtime.timeline,
      { kind: 'turn' as const, turnId, ...result },
    ],
  };
}

function updateRuntimeTurnItem(
  runtime: ThreadRuntimeState,
  turnId: string,
  itemId: string,
  updater: (existing: TurnItem | undefined) => TurnItem,
): ThreadRuntimeState {
  return updateRuntimeCurrentTurn(runtime, turnId, (items, completed) => {
    const idx = items.findIndex((it) => it.itemId === itemId);
    if (idx >= 0) {
      const updated = [...items];
      updated[idx] = updater(updated[idx]);
      return { items: updated, completed };
    }
    return { items: [...items, updater(undefined)], completed };
  });
}

function updateRuntimeDiff(runtime: ThreadRuntimeState, turnId: string, diff: string): ThreadRuntimeState {
  const timeline = runtime.timeline.map((entry) =>
    entry.kind === 'turn' && entry.turnId === turnId ? { ...entry, diff } : entry,
  );
  return { ...runtime, timeline };
}

function updateRuntimePlan(
  runtime: ThreadRuntimeState,
  turnId: string,
  plan: TurnPlanState,
): ThreadRuntimeState {
  const idx = runtime.timeline.findIndex(
    (entry) => entry.kind === 'turn' && entry.turnId === turnId,
  );
  if (idx >= 0) {
    const entry = runtime.timeline[idx];
    if (entry.kind !== 'turn') return runtime;
    const timeline = [...runtime.timeline];
    timeline[idx] = { ...entry, plan };
    return { ...runtime, timeline };
  }
  return {
    ...runtime,
    timeline: [
      ...runtime.timeline,
      { kind: 'turn' as const, turnId, items: [], completed: false, plan },
    ],
  };
}

interface TimelineState {
  selectedThreadId: string | null;
  threadsById: Record<string, ThreadRuntimeState>;
  subscribedThreadIds: Set<string>;
  maxIdleSubscriptions: number;

  threadId: string | null;
  threadCwd: string | null;
  threadTitle: string | null;
  threadMode: ThreadMode;
  timeline: TimelineEntry[];
  loading: boolean;
  expandedReasoning: Set<string>;
  approvals: Record<string, ApprovalRequest>;
  userInputRequests: Record<string, UserInputRequest>;
  tokenUsageByTurn: Record<string, ThreadTokenUsage>;
  latestTokenUsage: ThreadTokenUsage | null;
  threadStatus: ThreadStatusType | null;
  activeTurnId: string | null;
  pendingResolvedRequestIds: Set<string>;
  historyCursor: string | null;
  historyLoading: boolean;
  readOnlyReason: string | null;
  deletedRemotely: boolean;
  lastActivityAt: number;

  ensureThreadState: (input: ThreadRuntimeInput) => void;
  selectThread: (threadId: string | null) => void;
  resubscribeAll: () => void;
  unsubscribeThread: (threadId: string) => void;
  forgetThreads: (threadIds: string[]) => void;
  setMaxIdleSubscriptions: (limit: number) => void;
  cleanupIdleThreadSubscriptions: (limit?: number) => void;
  getThreadTitle: (threadId: string) => string;
  getThreadRuntime: (threadId: string) => ThreadRuntimeState | null;
  isThreadLoading: (threadId: string) => boolean;
  hasPendingApproval: (threadId: string) => boolean;

  setActiveThread: (threadId: string, cwd?: string | null, title?: string | null) => void;
  setReadOnlyThread: (thread: ThreadDto) => void;
  clearThread: () => void;
  hydrateTimeline: (turns: TurnDto[], cwd?: string | null) => void;
  setThreadTitle: (title: string | null) => void;
  addUserMessage: (text: string, images?: string[]) => void;
  addSystemError: (message: string) => void;
  addSystemMessage: (message: string, severity?: 'info' | 'warning' | 'error') => void;

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
  setLoading: (loading: boolean) => void;
  expandReasoning: (itemId: string) => void;
  collapseReasoning: (itemId: string) => void;
  addApproval: (approval: ApprovalRequest) => void;
  addUserInputRequest: (request: UserInputRequest) => void;
  resolveApproval: (requestId: string | number, decision: ResolvableApprovalDecision) => void;
  resolveUserInputRequest: (requestId: string | number) => void;
  setTokenUsage: (turnId: string, usage: ThreadTokenUsage) => void;
  setThreadStatus: (status: ThreadStatusType | null) => void;
  setActiveTurnId: (turnId: string | null) => void;
  clearActiveTurn: () => void;
  hydrateTokenUsage: (turns: Array<{ turnId: string; usage: ThreadTokenUsage }>) => void;
  hydrateTurnDiffs: (turns: Array<{ turnId: string; diff: string }>) => void;
  resolveApprovalByRequestId: (requestId: string | number) => void;

  hydrateTimelineForThread: (threadId: string, turns: TurnDto[], cwd?: string | null) => void;
  hydrateOpenedThread: (params: {
    threadId: string;
    turnsNewestFirst: TurnDto[];
    historyCursor: string | null;
    readOnlyReason: string | null;
    cwd?: string | null;
  }) => void;
  prependHistoryForThread: (
    threadId: string,
    turnsNewestFirst: TurnDto[],
    nextCursor: string | null,
  ) => void;
  setHistoryLoadingForThread: (threadId: string, loading: boolean) => void;
  markThreadDeletedRemotely: (threadId: string, message: string) => void;
  hydrateTokenUsageForThread: (threadId: string, turns: Array<{ turnId: string; usage: ThreadTokenUsage }>) => void;
  hydrateTurnDiffsForThread: (threadId: string, turns: Array<{ turnId: string; diff: string }>) => void;
  hydrateTurnErrorsForThread: (threadId: string, errors: Array<{ turnId: string; message: string }>) => void;
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
  /** Replaces a summary turn's items with the full set fetched on demand. */
  applyFullTurnItemsForThread: (
    threadId: string,
    turnId: string,
    items: Array<Record<string, unknown>>,
  ) => void;
  updateTurnDiffForThread: (threadId: string, turnId: string, diff: string) => void;
  updateTurnPlanForThread: (threadId: string, turnId: string, plan: TurnPlanState) => void;
  appendPlanDeltaForThread: (threadId: string, turnId: string, itemId: string, delta: string) => void;
  setLoadingForThread: (threadId: string, loading: boolean) => void;
  addApprovalForThread: (threadId: string, approval: ApprovalRequest) => void;
  addUserInputRequestForThread: (threadId: string, request: UserInputRequest) => void;
  resolveApprovalForThread: (threadId: string, requestId: string | number, decision: ResolvableApprovalDecision) => void;
  resolveUserInputRequestForThread: (threadId: string, requestId: string | number) => void;
  setTokenUsageForThread: (threadId: string, turnId: string, usage: ThreadTokenUsage) => void;
  setThreadStatusForThread: (threadId: string, status: ThreadStatusType | null) => void;
  setActiveTurnIdForThread: (threadId: string, turnId: string | null) => void;
  clearActiveTurnForThread: (threadId: string) => void;
  addSystemMessageForThread: (threadId: string, message: string, severity?: 'info' | 'warning' | 'error', turnId?: string) => void;
  addSystemErrorForThread: (threadId: string, message: string) => void;
  setThreadTitleForThread: (threadId: string, title: string | null) => void;
  resolveApprovalByRequestIdForThread: (threadId: string, requestId: string | number) => void;
}

export const useTimelineStore = create<TimelineState>((set, get) => {
  const applyThreadUpdate = (
    threadId: string,
    updater: (runtime: ThreadRuntimeState) => ThreadRuntimeState,
  ) => {
    set((state) => {
      const base = readRuntime(state, threadId) ?? createRuntime({ threadId });
      const runtime = touchRuntime(updater(base));
      const threadsById = { ...persistSelectedRuntime(state), [threadId]: runtime };
      const patch: Partial<TimelineState> = { threadsById };
      if (state.threadId === threadId) Object.assign(patch, selectedFields(runtime));
      return patch;
    });
  };

  const selectedThread = (): string | null => get().threadId;

  return {
    selectedThreadId: null,
    threadsById: {},
    subscribedThreadIds: new Set<string>(),
    maxIdleSubscriptions: DEFAULT_MAX_IDLE_SUBSCRIPTIONS,

    threadId: null,
    threadCwd: null,
    threadTitle: null,
    threadMode: 'live',
    timeline: [],
    loading: false,
    expandedReasoning: new Set<string>(),
    approvals: {},
    userInputRequests: {},
    tokenUsageByTurn: {},
    latestTokenUsage: null,
    threadStatus: null,
    activeTurnId: null,
    pendingResolvedRequestIds: new Set(),
    historyCursor: null,
    historyLoading: false,
    readOnlyReason: null,
    deletedRemotely: false,
    lastActivityAt: 0,

    ensureThreadState: (input) => {
      set((state) => {
        const existing = readRuntime(state, input.threadId);
        if (existing) return {};
        return {
          threadsById: {
            ...persistSelectedRuntime(state),
            [input.threadId]: createRuntime(input),
          },
        };
      });
    },

    selectThread: (threadId) => {
      set((state) => {
        const threadsById = persistSelectedRuntime(state);
        if (!threadId) {
          return {
            ...selectedFields(null),
            selectedThreadId: null,
            threadsById,
          };
        }
        const runtime = touchRuntime(threadsById[threadId] ?? createRuntime({ threadId }));
        return {
          ...selectedFields(runtime),
          selectedThreadId: threadId,
          threadsById: { ...threadsById, [threadId]: runtime },
        };
      });
    },

    resubscribeAll: () => {
      const socket = getSocket();
      for (const threadId of get().subscribedThreadIds) {
        socket.emit('thread.subscribe', { threadId });
      }
    },

    unsubscribeThread: (threadId) => {
      getSocket().emit('thread.unsubscribe', { threadId });
      set((state) => {
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        subscribedThreadIds.delete(threadId);
        return { subscribedThreadIds };
      });
    },

    /**
     * Drops every trace of threads that no longer exist.
     *
     * `unsubscribeThread` only leaves the socket room; the runtime survives in
     * `threadsById` and would be handed straight back to a deep link or a back
     * navigation to a deleted thread, showing content for a conversation that
     * is gone. The selected runtime needs special care: it lives in the
     * top-level fields, and the usual `selectThread(null)` path persists it into
     * `threadsById` on the way out — which would resurrect what we are deleting.
     *
     * @param threadIds - Threads that were destroyed
     */
    forgetThreads: (threadIds) => {
      const doomed = new Set(threadIds);
      if (doomed.size === 0) return;

      const socket = getSocket();
      const subscribed = get().subscribedThreadIds;
      for (const threadId of doomed) {
        if (subscribed.has(threadId)) {
          socket.emit('thread.unsubscribe', { threadId });
        }
      }

      set((state) => {
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        for (const threadId of doomed) subscribedThreadIds.delete(threadId);

        const selectedDoomed =
          state.selectedThreadId !== null && doomed.has(state.selectedThreadId);
        const threadsById = selectedDoomed
          ? { ...state.threadsById }
          : persistSelectedRuntime(state);
        for (const threadId of doomed) delete threadsById[threadId];

        return selectedDoomed
          ? {
              ...selectedFields(null),
              selectedThreadId: null,
              threadsById,
              subscribedThreadIds,
            }
          : { threadsById, subscribedThreadIds };
      });
    },

    setMaxIdleSubscriptions: (limit) => {
      const maxIdleSubscriptions = normalizeMaxIdleSubscriptions(limit);
      set({ maxIdleSubscriptions });
      get().cleanupIdleThreadSubscriptions(maxIdleSubscriptions);
    },

    cleanupIdleThreadSubscriptions: (limit) => {
      const maxIdleSubscriptions = normalizeMaxIdleSubscriptions(
        limit ?? get().maxIdleSubscriptions,
      );
      const evictedThreadIds: string[] = [];

      set((state) => {
        const candidates: Array<{ threadId: string; lastActivityAt: number }> = [];
        for (const threadId of state.subscribedThreadIds) {
          const runtime = readRuntime(state, threadId);
          if (isSafeToCleanupIdleRuntime(runtime, state.threadId)) {
            candidates.push({ threadId, lastActivityAt: runtime.lastActivityAt });
          }
        }

        if (candidates.length <= maxIdleSubscriptions) return {};

        const now = Date.now();
        candidates.sort((a, b) => compareIdleCleanupCandidates(now, a, b));
        const evictCount = candidates.length - maxIdleSubscriptions;
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        const threadsById = { ...persistSelectedRuntime(state) };

        for (const candidate of candidates.slice(0, evictCount)) {
          subscribedThreadIds.delete(candidate.threadId);
          delete threadsById[candidate.threadId];
          evictedThreadIds.push(candidate.threadId);
        }

        return { subscribedThreadIds, threadsById };
      });

      const socket = getSocket();
      for (const threadId of evictedThreadIds) {
        socket.emit('thread.unsubscribe', { threadId });
      }
    },

    getThreadTitle: (threadId) => {
      const runtime = readRuntime(get(), threadId);
      return runtime?.threadTitle ?? threadId.slice(0, 8);
    },

    getThreadRuntime: (threadId) => readRuntime(get(), threadId),
    isThreadLoading: (threadId) => readRuntime(get(), threadId)?.loading ?? false,
    hasPendingApproval: (threadId) => hasPendingApproval(readRuntime(get(), threadId)),

    setActiveThread: (threadId, cwd, title) => {
      get().ensureThreadState({ threadId, cwd, title, mode: 'live' });
      get().selectThread(threadId);
      getSocket().emit('thread.subscribe', { threadId });
      set((state) => ({ subscribedThreadIds: new Set(state.subscribedThreadIds).add(threadId) }));
      get().cleanupIdleThreadSubscriptions();
    },

    setReadOnlyThread: (thread) => {
      const title = thread.name ?? thread.preview ?? null;
      get().unsubscribeThread(thread.id);
      get().ensureThreadState({ threadId: thread.id, cwd: thread.cwd, title, mode: 'readOnly' });
      get().selectThread(thread.id);
      get().hydrateTimelineForThread(thread.id, thread.turns ?? [], thread.cwd);
      get().setThreadStatusForThread(thread.id, thread.status as ThreadStatusType);
    },

    clearThread: () => get().selectThread(null),

    hydrateTimeline: (turns, cwd) => {
      const threadId = selectedThread();
      if (threadId) get().hydrateTimelineForThread(threadId, turns, cwd);
    },

    setThreadTitle: (title) => {
      const threadId = selectedThread();
      if (threadId) get().setThreadTitleForThread(threadId, title);
    },

    addUserMessage: (text, images) => {
      const threadId = selectedThread();
      if (!threadId) return;
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: [
          ...runtime.timeline,
          { kind: 'user' as const, content: text, ...(images?.length && { images }) },
        ],
        loading: true,
      }));
    },

    addSystemError: (message) => {
      const threadId = selectedThread();
      if (threadId) get().addSystemErrorForThread(threadId, message);
    },

    addSystemMessage: (message, severity = 'info') => {
      const threadId = selectedThread();
      if (threadId) get().addSystemMessageForThread(threadId, message, severity);
    },

    toggleReasoning: (itemId) => {
      const threadId = selectedThread();
      if (!threadId) return;
      applyThreadUpdate(threadId, (runtime) => {
        const expandedReasoning = new Set(runtime.expandedReasoning);
        if (expandedReasoning.has(itemId)) expandedReasoning.delete(itemId);
        else expandedReasoning.add(itemId);
        return { ...runtime, expandedReasoning };
      });
    },

    updateCurrentTurn: (turnId, updater) => {
      const threadId = selectedThread();
      if (threadId) get().updateCurrentTurnForThread(threadId, turnId, updater);
    },

    updateTurnItem: (turnId, itemId, updater) => {
      const threadId = selectedThread();
      if (threadId) get().updateTurnItemForThread(threadId, turnId, itemId, updater);
    },

    updateTurnDiff: (turnId, diff) => {
      const threadId = selectedThread();
      if (threadId) get().updateTurnDiffForThread(threadId, turnId, diff);
    },

    updateTurnPlan: (turnId, plan) => {
      const threadId = selectedThread();
      if (threadId) get().updateTurnPlanForThread(threadId, turnId, plan);
    },

    appendPlanDelta: (turnId, itemId, delta) => {
      const threadId = selectedThread();
      if (threadId) get().appendPlanDeltaForThread(threadId, turnId, itemId, delta);
    },

    setLoading: (loading) => {
      const threadId = selectedThread();
      if (threadId) get().setLoadingForThread(threadId, loading);
    },

    expandReasoning: (itemId) => {
      const threadId = selectedThread();
      if (!threadId) return;
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        expandedReasoning: new Set(runtime.expandedReasoning).add(itemId),
      }));
    },

    collapseReasoning: (itemId) => {
      const threadId = selectedThread();
      if (!threadId) return;
      applyThreadUpdate(threadId, (runtime) => {
        const expandedReasoning = new Set(runtime.expandedReasoning);
        expandedReasoning.delete(itemId);
        return { ...runtime, expandedReasoning };
      });
    },

    addApproval: (approval) => get().addApprovalForThread(approval.threadId, approval),

    addUserInputRequest: (request) =>
      get().addUserInputRequestForThread(request.threadId, request),

    resolveApproval: (requestId, decision) => {
      const threadId = selectedThread();
      if (threadId) get().resolveApprovalForThread(threadId, requestId, decision);
    },

    resolveUserInputRequest: (requestId) => {
      const threadId = selectedThread();
      if (threadId) get().resolveUserInputRequestForThread(threadId, requestId);
    },

    setTokenUsage: (turnId, usage) => {
      const threadId = selectedThread();
      if (threadId) get().setTokenUsageForThread(threadId, turnId, usage);
    },

    setThreadStatus: (status) => {
      const threadId = selectedThread();
      if (threadId) get().setThreadStatusForThread(threadId, status);
    },

    setActiveTurnId: (turnId) => {
      const threadId = selectedThread();
      if (threadId) get().setActiveTurnIdForThread(threadId, turnId);
    },

    clearActiveTurn: () => {
      const threadId = selectedThread();
      if (threadId) get().clearActiveTurnForThread(threadId);
    },

    hydrateTokenUsage: (turns) => {
      const threadId = selectedThread();
      if (threadId) get().hydrateTokenUsageForThread(threadId, turns);
    },

    hydrateTurnDiffs: (turns) => {
      const threadId = selectedThread();
      if (threadId) get().hydrateTurnDiffsForThread(threadId, turns);
    },

    resolveApprovalByRequestId: (requestId) => {
      const threadId = selectedThread();
      if (threadId) get().resolveApprovalByRequestIdForThread(threadId, requestId);
    },

    hydrateTimelineForThread: (threadId, turns, cwd) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        threadCwd: cwd ?? runtime.threadCwd,
        loading: false,
        timeline: ensureRequestTurnEntries(
          turnsToTimeline(turns),
          runtime.approvals,
          runtime.userInputRequests,
        ),
        activeTurnId: null,
        hydrated: true,
      }));
    },

    /**
     * Seeds a thread from a metadata-first open.
     *
     * The server returns the most recent page of turns newest-first, because
     * that is the end the user is looking at; the timeline renders oldest-first,
     * so the page is reversed here rather than at every read site.
     */
    hydrateOpenedThread: ({
      threadId,
      turnsNewestFirst,
      historyCursor,
      readOnlyReason,
      cwd,
    }) => {
      const turns = [...turnsNewestFirst].reverse();
      applyThreadUpdate(threadId, (runtime) => {
        // Reopening must not undo paging. An open returns only the most recent
        // page, so replacing the timeline with it would discard every earlier
        // page the user had loaded — leave the conversation and come back and
        // the history silently shrinks again.
        //
        // The page is kept only when it introduces nothing this client does not
        // already hold. If it carries a turn we have never seen, the thread has
        // moved on elsewhere and the server's view wins outright; merging
        // partially would risk stitching two different moments together.
        const knownTurnIds = collectKnownTurnIds(runtime.timeline);
        const pageIsSubsumed =
          runtime.hydrated &&
          turns.length > 0 &&
          turns.every((turn) => knownTurnIds.has(turn.id));

        return {
          ...runtime,
          threadCwd: cwd ?? runtime.threadCwd,
          loading: false,
          timeline: pageIsSubsumed
            ? runtime.timeline
            : ensureRequestTurnEntries(
                turnsToTimeline(turns),
                runtime.approvals,
                runtime.userInputRequests,
              ),
          activeTurnId: null,
          hydrated: true,
          // Keeping the existing cursor matters as much as keeping the entries:
          // the cursor from a fresh open points just before the newest page, so
          // adopting it would offer to re-fetch history already on screen.
          historyCursor: pageIsSubsumed ? runtime.historyCursor : historyCursor,
          historyLoading: false,
          readOnlyReason,
        };
      });
    },

    /**
     * Adds an older page of history above what is already rendered.
     *
     * Guards against double-application: a turn already present is skipped
     * rather than duplicated, because the cursor page is inclusive of its
     * anchor row and a retry can overlap what the previous page delivered.
     */
    prependHistoryForThread: (threadId, turnsNewestFirst, nextCursor) => {
      applyThreadUpdate(threadId, (runtime) => {
        const knownTurnIds = collectKnownTurnIds(runtime.timeline);
        const older = [...turnsNewestFirst]
          .reverse()
          .filter((turn) => !knownTurnIds.has(turn.id));
        return {
          ...runtime,
          timeline: [...turnsToTimeline(older), ...runtime.timeline],
          historyCursor: nextCursor,
          historyLoading: false,
        };
      });
    },

    setHistoryLoadingForThread: (threadId, historyLoading) => {
      applyThreadUpdate(threadId, (runtime) => ({ ...runtime, historyLoading }));
    },

    /**
     * Marks a conversation destroyed elsewhere while keeping its transcript.
     *
     * Keeping what the user is reading is deliberate, but it must stop being
     * interactive in the same step: a preserved transcript that still accepts
     * messages is a conversation that fails on every send. Any in-flight turn
     * state is cleared too — it can no longer complete, and leaving it would
     * show a spinner that never resolves.
     */
    markThreadDeletedRemotely: (threadId, message) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        deletedRemotely: true,
        loading: false,
        activeTurnId: null,
        historyCursor: null,
        historyLoading: false,
        timeline: [
          ...runtime.timeline,
          { kind: 'system', content: message, severity: 'error' },
        ],
      }));
    },

    hydrateTokenUsageForThread: (threadId, turns) => {
      const byTurn: Record<string, ThreadTokenUsage> = {};
      for (const turn of turns) byTurn[turn.turnId] = turn.usage;
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        tokenUsageByTurn: byTurn,
        latestTokenUsage: turns.at(-1)?.usage ?? null,
      }));
    },

    hydrateTurnDiffsForThread: (threadId, turns) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: runtime.timeline.map((entry) => {
          if (entry.kind !== 'turn') return entry;
          const match = turns.find((turn) => turn.turnId === entry.turnId);
          return match ? { ...entry, diff: match.diff } : entry;
        }),
      }));
    },

    hydrateTurnErrorsForThread: (threadId, errors) => {
      if (errors.length === 0) return;
      applyThreadUpdate(threadId, (runtime) => {
        // Build a map of turnId → error entry, deduplicating against existing timeline
        // Dedup by turnId + content to avoid skipping same error message from different turns
        const existingErrorKeys = new Set(
          runtime.timeline
            .filter((e): e is Extract<typeof e, { kind: 'system' }> => e.kind === 'system' && e.severity === 'error')
            .map((e) => `${e.turnId ?? ''}:${e.content}`),
        );
        const pendingByTurn = new Map<string, { kind: 'system'; content: string; severity: 'error'; turnId: string }>();
        for (const err of errors) {
          const content = `Error: ${err.message}`;
          if (!existingErrorKeys.has(`${err.turnId}:${content}`)) {
            pendingByTurn.set(err.turnId, { kind: 'system', content, severity: 'error', turnId: err.turnId });
          }
        }
        if (pendingByTurn.size === 0) return runtime;

        // Insert each error entry right after its corresponding turn
        const timeline = [];
        for (const entry of runtime.timeline) {
          timeline.push(entry);
          if (entry.kind === 'turn') {
            const errorEntry = pendingByTurn.get(entry.turnId);
            if (errorEntry) {
              timeline.push(errorEntry);
              pendingByTurn.delete(entry.turnId);
            }
          }
        }
        // Append any remaining errors whose turn wasn't found in the timeline
        for (const entry of pendingByTurn.values()) {
          timeline.push(entry);
        }
        return { ...runtime, timeline };
      });
    },

    updateCurrentTurnForThread: (threadId, turnId, updater) => {
      applyThreadUpdate(threadId, (runtime) => updateRuntimeCurrentTurn(runtime, turnId, updater));
    },

    updateTurnItemForThread: (threadId, turnId, itemId, updater) => {
      applyThreadUpdate(threadId, (runtime) => updateRuntimeTurnItem(runtime, turnId, itemId, updater));
    },

    applyFullTurnItemsForThread: (threadId, turnId, items) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: runtime.timeline.map((entry) => {
          if (entry.kind !== 'turn' || entry.turnId !== turnId) return entry;
          // The request may have been in flight while live notifications
          // rebuilt this turn. A persisted snapshot is older than anything
          // that streamed in, so it may only fill gaps — never overwrite.
          if (entry.itemsView !== 'summary') return entry;
          const parsed = items
            .map(parseTurnItem)
            .filter((item): item is TurnItem => item !== null);
          const liveItemIds = new Set(entry.items.map((item) => item.itemId));
          const restored = parsed.filter(
            (item) => !liveItemIds.has(item.itemId),
          );
          return {
            ...entry,
            // Live items keep their position and their streamed state; the
            // snapshot only contributes what the summary view had withheld.
            items: [...restored, ...entry.items],
            plan: entry.plan ?? parsePersistedPlan(items),
            // Marking it full is what stops the top-up from firing again.
            itemsView: 'full' as const,
          };
        }),
      }));
    },
    updateTurnDiffForThread: (threadId, turnId, diff) => {
      applyThreadUpdate(threadId, (runtime) => updateRuntimeDiff(runtime, turnId, diff));
    },

    updateTurnPlanForThread: (threadId, turnId, plan) => {
      applyThreadUpdate(threadId, (runtime) => updateRuntimePlan(runtime, turnId, plan));
    },

    appendPlanDeltaForThread: (threadId, turnId, itemId, delta) => {
      if (!delta) return;
      applyThreadUpdate(threadId, (runtime) => {
        const patchPlan = (plan?: TurnPlanState): TurnPlanState => ({
          explanation: plan?.explanation ?? null,
          steps: plan?.steps ?? [],
          planTextByItemId: {
            ...(plan?.planTextByItemId ?? {}),
            [itemId]: `${plan?.planTextByItemId?.[itemId] ?? ''}${delta}`,
          },
        });
        const idx = runtime.timeline.findIndex(
          (entry) => entry.kind === 'turn' && entry.turnId === turnId,
        );
        if (idx >= 0) {
          const entry = runtime.timeline[idx];
          if (entry.kind !== 'turn') return runtime;
          const timeline = [...runtime.timeline];
          timeline[idx] = { ...entry, plan: patchPlan(entry.plan) };
          return { ...runtime, timeline };
        }
        return {
          ...runtime,
          timeline: [
            ...runtime.timeline,
            { kind: 'turn' as const, turnId, items: [], completed: false, plan: patchPlan() },
          ],
        };
      });
    },

    setLoadingForThread: (threadId, loading) => {
      applyThreadUpdate(threadId, (runtime) => ({ ...runtime, loading }));
    },

    addApprovalForThread: (threadId, approval) => {
      applyThreadUpdate(threadId, (runtime) => {
        const requestKey = String(approval.requestId);
        const alreadyResolved = runtime.pendingResolvedRequestIds.has(requestKey);
        const finalApproval = alreadyResolved
          ? { ...approval, status: 'resolved' as const }
          : approval;
        const pendingResolvedRequestIds = new Set(runtime.pendingResolvedRequestIds);
        if (alreadyResolved) pendingResolvedRequestIds.delete(requestKey);
        return {
          ...runtime,
          timeline: ensureTurnEntry(runtime.timeline, approval.turnId),
          approvals: { ...runtime.approvals, [requestKey]: finalApproval },
          pendingResolvedRequestIds,
        };
      });
    },

    addUserInputRequestForThread: (threadId, request) => {
      applyThreadUpdate(threadId, (runtime) => {
        const requestKey = String(request.requestId);
        const alreadyResolved = runtime.pendingResolvedRequestIds.has(requestKey);
        const finalRequest: UserInputRequest = alreadyResolved
          ? { ...request, status: 'resolved' }
          : request;
        const pendingResolvedRequestIds = new Set(runtime.pendingResolvedRequestIds);
        if (alreadyResolved) pendingResolvedRequestIds.delete(requestKey);
        return {
          ...runtime,
          timeline: ensureTurnEntry(runtime.timeline, request.turnId),
          userInputRequests: { ...runtime.userInputRequests, [requestKey]: finalRequest },
          pendingResolvedRequestIds,
        };
      });
    },

    resolveApprovalForThread: (threadId, requestId, decision) => {
      const requestKey = String(requestId);
      applyThreadUpdate(threadId, (runtime) => {
        const existing = runtime.approvals[requestKey];
        if (!existing) return runtime;
        return {
          ...runtime,
          approvals: {
            ...runtime.approvals,
            [requestKey]: { ...existing, status: decision },
          },
        };
      });
    },

    resolveUserInputRequestForThread: (threadId, requestId) => {
      const requestKey = String(requestId);
      applyThreadUpdate(threadId, (runtime) => {
        const existing = runtime.userInputRequests[requestKey];
        if (!existing) return runtime;
        const resolved: UserInputRequest = { ...existing, status: 'resolved' };
        return {
          ...runtime,
          userInputRequests: {
            ...runtime.userInputRequests,
            [requestKey]: resolved,
          },
        };
      });
    },

    setTokenUsageForThread: (threadId, turnId, usage) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        tokenUsageByTurn: { ...runtime.tokenUsageByTurn, [turnId]: usage },
        latestTokenUsage: usage,
      }));
    },

    setThreadStatusForThread: (threadId, status) => {
      applyThreadUpdate(threadId, (runtime) => ({ ...runtime, threadStatus: status }));
    },

    setActiveTurnIdForThread: (threadId, turnId) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        activeTurnId: turnId,
        timeline: turnId
          ? bindPendingUserMessage(runtime.timeline, turnId)
          : runtime.timeline,
      }));
    },

    clearActiveTurnForThread: (threadId) => {
      applyThreadUpdate(threadId, (runtime) => ({ ...runtime, activeTurnId: null, loading: false }));
    },

    addSystemMessageForThread: (threadId, message, severity = 'info', turnId?) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: [
          ...runtime.timeline,
          { kind: 'system' as const, content: message, severity, turnId },
        ],
      }));
    },

    addSystemErrorForThread: (threadId, message) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: [
          ...runtime.timeline,
          { kind: 'system' as const, content: `Error: ${message}`, severity: 'error' as const },
        ],
        loading: false,
      }));
    },

    setThreadTitleForThread: (threadId, title) => {
      applyThreadUpdate(threadId, (runtime) => ({ ...runtime, threadTitle: title }));
    },

    resolveApprovalByRequestIdForThread: (threadId, requestId) => {
      const requestKey = String(requestId);
      applyThreadUpdate(threadId, (runtime) => {
        const approval = runtime.approvals[requestKey];
        if (approval) {
          return {
            ...runtime,
            approvals: {
              ...runtime.approvals,
              [requestKey]: { ...approval, status: 'resolved' },
            },
          };
        }

        const userInput = runtime.userInputRequests[requestKey];
        if (userInput) {
          const resolved: UserInputRequest = { ...userInput, status: 'resolved' };
          return {
            ...runtime,
            userInputRequests: {
              ...runtime.userInputRequests,
              [requestKey]: resolved,
            },
          };
        }

        return {
          ...runtime,
          pendingResolvedRequestIds: new Set(runtime.pendingResolvedRequestIds).add(requestKey),
        };
      });
    },
  };
});

/** Selects data from the currently visible thread runtime. */
export function useSelectedThreadState<T>(selector: (runtime: ThreadRuntimeState | null) => T): T {
  return useTimelineStore((state) => selector(state.threadId ? readRuntime(state, state.threadId) : null));
}

/** Selects data from a specific thread runtime. */
export function useThreadState<T>(
  threadId: string | null | undefined,
  selector: (runtime: ThreadRuntimeState | undefined) => T,
): T {
  return useTimelineStore((state) =>
    selector(threadId ? state.threadsById[threadId] : undefined),
  );
}
