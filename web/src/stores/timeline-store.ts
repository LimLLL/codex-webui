/** Conversation timeline store. */
import { create } from 'zustand';
import { type ThreadRuntimeState, type TimelineState } from './timeline-state';
import {
  DEFAULT_MAX_IDLE_SUBSCRIPTIONS,
  createRuntime,
  readRuntime,
  selectedFields,
  persistSelectedRuntime,
  touchRuntime,
} from './timeline-runtime';
import { createTimelineNavigationActions } from './timeline-navigation-actions';
import { createTimelineHistoryActions } from './timeline-history-actions';
import { createTimelineTurnsActions } from './timeline-turns-actions';
import { createTimelineInteractionsActions } from './timeline-interactions-actions';

export const useTimelineStore = create<TimelineState>((set, get) => {
  const applyThreadUpdate = (
    threadId: string,
    updater: (runtime: ThreadRuntimeState) => ThreadRuntimeState,
  ) => {
    set((state) => {
      const base = readRuntime(state, threadId) ?? createRuntime({ threadId });
      const runtime = touchRuntime(updater(base));
      const threadsById = {
        ...persistSelectedRuntime(state),
        [threadId]: runtime,
      };
      const patch: Partial<TimelineState> = { threadsById };
      if (state.threadId === threadId)
        Object.assign(patch, selectedFields(runtime));
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
    pendingResolvedRequestIds: new Set(),
    hydrated: false,
    historyCursor: null,
    historyLoading: false,
    readOnlyReason: null,
    deletedRemotely: false,
    lastActivityAt: 0,
    ...createTimelineNavigationActions({ set, get, applyThreadUpdate }),
    ...createTimelineHistoryActions({ set, get, applyThreadUpdate }),
    ...createTimelineTurnsActions({ set, get, applyThreadUpdate }),
    ...createTimelineInteractionsActions({ set, get, applyThreadUpdate }),
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
          {
            kind: 'user' as const,
            content: text,
            ...(images?.length && { images }),
          },
        ],
        turnStartPending: true,
      }));
    },

    addSystemError: (message) => {
      const threadId = selectedThread();
      if (threadId) get().addSystemErrorForThread(threadId, message);
    },

    addSystemMessage: (message, severity = 'info') => {
      const threadId = selectedThread();
      if (threadId)
        get().addSystemMessageForThread(threadId, message, severity);
    },

    upsertTurnFailure: (failure) => {
      const threadId = selectedThread();
      if (threadId) get().upsertTurnFailureForThread(threadId, failure);
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
      if (threadId)
        get().updateTurnItemForThread(threadId, turnId, itemId, updater);
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
      if (threadId)
        get().appendPlanDeltaForThread(threadId, turnId, itemId, delta);
    },

    setTurnStartPending: (turnStartPending) => {
      const threadId = selectedThread();
      if (threadId)
        get().setTurnStartPendingForThread(threadId, turnStartPending);
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

    addApproval: (approval) =>
      get().addApprovalForThread(approval.threadId, approval),

    addUserInputRequest: (request) =>
      get().addUserInputRequestForThread(request.threadId, request),

    resolveApproval: (requestId, decision) => {
      const threadId = selectedThread();
      if (threadId)
        get().resolveApprovalForThread(threadId, requestId, decision);
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
      if (threadId)
        get().resolveApprovalByRequestIdForThread(threadId, requestId);
    },
  };
});

/** Selects data from the currently visible thread runtime. */
export function useSelectedThreadState<T>(
  selector: (runtime: ThreadRuntimeState | null) => T,
): T {
  return useTimelineStore((state) =>
    selector(state.threadId ? readRuntime(state, state.threadId) : null),
  );
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

export type { ThreadMode, ThreadRuntimeState } from './timeline-state';
