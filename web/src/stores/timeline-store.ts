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
      entries.push({ kind: 'user', content: text, ...(images.length > 0 && { images }) });
    }

    const plan = parsePersistedPlan(items);
    const turnItems = items
      .map(parseTurnItem)
      .filter((it): it is TurnItem => it !== null);

    if (turnItems.length > 0 || plan) {
      entries.push({
        kind: 'turn',
        turnId: turn.id,
        plan,
        items: turnItems,
        completed: turn.status === 'completed',
      });
    }
  }

  return entries;
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

/** Ensures a turn entry exists in timeline for a given turnId (needed for request-only cards). */
function ensureTurnEntry(timeline: TimelineEntry[], turnId: string): TimelineEntry[] {
  if (timeline.some((entry) => entry.kind === 'turn' && entry.turnId === turnId)) {
    return timeline;
  }
  return [...timeline, { kind: 'turn', turnId, items: [], completed: false }];
}

/** After hydration, preserve turn entries for pending user-input requests. */
function ensureUserInputTurnEntries(
  timeline: TimelineEntry[],
  requests: Record<string, UserInputRequest>,
): TimelineEntry[] {
  return Object.values(requests).reduce(
    (next, req) => ensureTurnEntry(next, req.turnId),
    timeline,
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

  ensureThreadState: (input: ThreadRuntimeInput) => void;
  selectThread: (threadId: string | null) => void;
  resubscribeAll: () => void;
  unsubscribeThread: (threadId: string) => void;
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
  resolveApproval: (itemId: string, decision: ResolvableApprovalDecision) => void;
  resolveUserInputRequest: (requestId: string | number) => void;
  setTokenUsage: (turnId: string, usage: ThreadTokenUsage) => void;
  setThreadStatus: (status: ThreadStatusType | null) => void;
  setActiveTurnId: (turnId: string | null) => void;
  clearActiveTurn: () => void;
  hydrateTokenUsage: (turns: Array<{ turnId: string; usage: ThreadTokenUsage }>) => void;
  hydrateTurnDiffs: (turns: Array<{ turnId: string; diff: string }>) => void;
  resolveApprovalByRequestId: (requestId: string | number) => void;

  hydrateTimelineForThread: (threadId: string, turns: TurnDto[], cwd?: string | null) => void;
  hydrateTokenUsageForThread: (threadId: string, turns: Array<{ turnId: string; usage: ThreadTokenUsage }>) => void;
  hydrateTurnDiffsForThread: (threadId: string, turns: Array<{ turnId: string; diff: string }>) => void;
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
  updateTurnDiffForThread: (threadId: string, turnId: string, diff: string) => void;
  updateTurnPlanForThread: (threadId: string, turnId: string, plan: TurnPlanState) => void;
  appendPlanDeltaForThread: (threadId: string, turnId: string, itemId: string, delta: string) => void;
  setLoadingForThread: (threadId: string, loading: boolean) => void;
  addApprovalForThread: (threadId: string, approval: ApprovalRequest) => void;
  addUserInputRequestForThread: (threadId: string, request: UserInputRequest) => void;
  resolveApprovalForThread: (threadId: string, itemId: string, decision: ResolvableApprovalDecision) => void;
  resolveUserInputRequestForThread: (threadId: string, requestId: string | number) => void;
  setTokenUsageForThread: (threadId: string, turnId: string, usage: ThreadTokenUsage) => void;
  setThreadStatusForThread: (threadId: string, status: ThreadStatusType | null) => void;
  setActiveTurnIdForThread: (threadId: string, turnId: string | null) => void;
  clearActiveTurnForThread: (threadId: string) => void;
  addSystemMessageForThread: (threadId: string, message: string, severity?: 'info' | 'warning' | 'error') => void;
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
      const runtime = updater(base);
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
        const runtime = threadsById[threadId] ?? createRuntime({ threadId });
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

    resolveApproval: (itemId, decision) => {
      const threadId = selectedThread();
      if (threadId) get().resolveApprovalForThread(threadId, itemId, decision);
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
        timeline: ensureUserInputTurnEntries(
          turnsToTimeline(turns),
          runtime.userInputRequests,
        ),
        activeTurnId: null,
        hydrated: true,
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

    updateCurrentTurnForThread: (threadId, turnId, updater) => {
      applyThreadUpdate(threadId, (runtime) => updateRuntimeCurrentTurn(runtime, turnId, updater));
    },

    updateTurnItemForThread: (threadId, turnId, itemId, updater) => {
      applyThreadUpdate(threadId, (runtime) => updateRuntimeTurnItem(runtime, turnId, itemId, updater));
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
          approvals: { ...runtime.approvals, [approval.itemId]: finalApproval },
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

    resolveApprovalForThread: (threadId, itemId, decision) => {
      applyThreadUpdate(threadId, (runtime) => {
        const existing = runtime.approvals[itemId];
        if (!existing) return runtime;
        return {
          ...runtime,
          approvals: {
            ...runtime.approvals,
            [itemId]: { ...existing, status: decision },
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
      applyThreadUpdate(threadId, (runtime) => ({ ...runtime, activeTurnId: turnId }));
    },

    clearActiveTurnForThread: (threadId) => {
      applyThreadUpdate(threadId, (runtime) => ({ ...runtime, activeTurnId: null, loading: false }));
    },

    addSystemMessageForThread: (threadId, message, severity = 'info') => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: [
          ...runtime.timeline,
          { kind: 'system' as const, content: message, severity },
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
        const approval = Object.values(runtime.approvals).find(
          (entry) => String(entry.requestId) === requestKey,
        );
        if (approval) {
          return {
            ...runtime,
            approvals: {
              ...runtime.approvals,
              [approval.itemId]: { ...approval, status: 'resolved' },
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
