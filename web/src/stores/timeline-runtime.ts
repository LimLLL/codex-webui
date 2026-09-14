/** Conversation timeline runtime. */
import { useThreadPolicyStore } from './thread-policy-store';
import {
  type ThreadRuntimeState,
  type ThreadRuntimeInput,
  type TimelineState,
} from './timeline-state';

export const DEFAULT_MAX_IDLE_SUBSCRIPTIONS = 30;

export const MIN_MAX_IDLE_SUBSCRIPTIONS = 5;

export const MAX_MAX_IDLE_SUBSCRIPTIONS = 200;

export const IDLE_SUBSCRIPTION_TTL_MS = 15 * 60 * 1000;

/** Keeps the store-side fallback aligned with the backend runtime setting. */
export function normalizeMaxIdleSubscriptions(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_MAX_IDLE_SUBSCRIPTIONS;
  return Math.min(
    MAX_MAX_IDLE_SUBSCRIPTIONS,
    Math.max(MIN_MAX_IDLE_SUBSCRIPTIONS, Math.trunc(limit)),
  );
}

export function createRuntime(input: ThreadRuntimeInput): ThreadRuntimeState {
  return {
    threadId: input.threadId,
    threadCwd: input.cwd ?? null,
    threadTitle: input.title ?? null,
    threadMode: input.mode ?? 'live',
    timeline: [],
    turnStartPending: false,
    historyRequest: 'idle',
    historyError: null,
    openState: 'unopened',
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

export function runtimeFromSelected(
  state: TimelineState,
): ThreadRuntimeState | null {
  if (!state.threadId) return null;
  return {
    threadId: state.threadId,
    threadCwd: state.threadCwd,
    threadTitle: state.threadTitle,
    threadMode: state.threadMode,
    timeline: state.timeline,
    turnStartPending: state.turnStartPending,
    historyRequest: state.historyRequest,
    historyError: state.historyError,
    openState: state.openState,
    expandedReasoning: state.expandedReasoning,
    approvals: state.approvals,
    userInputRequests: state.userInputRequests,
    tokenUsageByTurn: state.tokenUsageByTurn,
    latestTokenUsage: state.latestTokenUsage,
    threadStatus: state.threadStatus,
    activeTurnId: state.activeTurnId,
    pendingResolvedRequestIds: state.pendingResolvedRequestIds,
    hydrated: state.hydrated,
    historyCursor: state.historyCursor,
    historyLoading: state.historyLoading,
    readOnlyReason: state.readOnlyReason,
    deletedRemotely: state.deletedRemotely,
    lastActivityAt: state.lastActivityAt,
  };
}

export function readRuntime(
  state: TimelineState,
  threadId: string,
): ThreadRuntimeState | null {
  if (state.threadId === threadId) return runtimeFromSelected(state);
  return state.threadsById[threadId] ?? null;
}

export function selectedFields(
  runtime: ThreadRuntimeState | null,
): Partial<TimelineState> {
  if (!runtime) {
    return {
      threadId: null,
      threadCwd: null,
      threadTitle: null,
      threadMode: 'live',
      timeline: [],
      turnStartPending: false,
      historyRequest: 'idle',
      historyError: null,
      openState: 'unopened',
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
      lastActivityAt: 0,
    };
  }
  return {
    threadId: runtime.threadId,
    threadCwd: runtime.threadCwd,
    threadTitle: runtime.threadTitle,
    threadMode: runtime.threadMode,
    timeline: runtime.timeline,
    turnStartPending: runtime.turnStartPending,
    historyRequest: runtime.historyRequest,
    historyError: runtime.historyError,
    openState: runtime.openState,
    expandedReasoning: runtime.expandedReasoning,
    approvals: runtime.approvals,
    userInputRequests: runtime.userInputRequests,
    tokenUsageByTurn: runtime.tokenUsageByTurn,
    latestTokenUsage: runtime.latestTokenUsage,
    threadStatus: runtime.threadStatus,
    activeTurnId: runtime.activeTurnId,
    pendingResolvedRequestIds: runtime.pendingResolvedRequestIds,
    hydrated: runtime.hydrated,
    historyCursor: runtime.historyCursor,
    historyLoading: runtime.historyLoading,
    readOnlyReason: runtime.readOnlyReason,
    deletedRemotely: runtime.deletedRemotely,
    lastActivityAt: runtime.lastActivityAt,
  };
}

export function persistSelectedRuntime(
  state: TimelineState,
): Record<string, ThreadRuntimeState> {
  const selected = runtimeFromSelected(state);
  if (!selected) return state.threadsById;
  return { ...state.threadsById, [selected.threadId]: selected };
}

export function hasPendingApproval(
  runtime: ThreadRuntimeState | null,
): boolean {
  if (!runtime) return false;
  const flagBlocked =
    runtime.threadStatus?.type === 'active' &&
    runtime.threadStatus.activeFlags.includes('waitingOnApproval');
  const cardBlocked = Object.values(runtime.approvals).some(
    (approval) => approval.status === 'pending',
  );
  return flagBlocked || cardBlocked;
}

export function hasPendingUserInput(
  runtime: ThreadRuntimeState | null,
): boolean {
  if (!runtime) return false;
  return Object.values(runtime.userInputRequests).some(
    (request) => request.status === 'pending',
  );
}

export function touchRuntime(runtime: ThreadRuntimeState): ThreadRuntimeState {
  return { ...runtime, lastActivityAt: Date.now() };
}

export function isSafeToCleanupIdleRuntime(
  runtime: ThreadRuntimeState | null,
  selectedThreadId: string | null,
): runtime is ThreadRuntimeState {
  return Boolean(
    runtime &&
    runtime.threadId !== selectedThreadId &&
    !runtime.turnStartPending &&
    runtime.openState !== 'opening' &&
    runtime.historyRequest !== 'loading' &&
    !runtime.historyLoading &&
    useThreadPolicyStore.getState().pendingByThread[runtime.threadId]
      ?.outcome !== 'pending' &&
    !runtime.activeTurnId &&
    runtime.pendingResolvedRequestIds.size === 0 &&
    runtime.threadStatus?.type !== 'active' &&
    !hasPendingApproval(runtime) &&
    !hasPendingUserInput(runtime),
  );
}

export function compareIdleCleanupCandidates(
  now: number,
  a: { lastActivityAt: number },
  b: { lastActivityAt: number },
): number {
  const aExpired = now - a.lastActivityAt >= IDLE_SUBSCRIPTION_TTL_MS;
  const bExpired = now - b.lastActivityAt >= IDLE_SUBSCRIPTION_TTL_MS;
  if (aExpired !== bExpired) return aExpired ? -1 : 1;
  return a.lastActivityAt - b.lastActivityAt;
}
