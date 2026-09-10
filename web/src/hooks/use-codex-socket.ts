/**
 * Hook that connects socket.io events to multi-thread Zustand state.
 * Delegates Codex notifications to the dispatcher with a mutable routed thread id.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '../socket';
import { useConnectionStore } from '../stores/connection-store';
import { useTimelineStore } from '../stores/timeline-store';
import { showSnackbar } from '@/stores/snackbar-store';
import { handleNotification, type NotificationContext } from './notification-handlers';
import { threadsResumeThread } from '@/generated/api/sdk.gen';
import { parseApprovalRequest } from '@/lib/approval-parsers';
import { recoverThreadAfterReconnect, supersedeRecovery } from '@/lib/thread-recovery';
import { nextObservationSeq } from '@/lib/turn-item-merge';
import { forgetThreadPolicy, refreshThreadPolicy, settleIfObserved } from '@/stores/thread-policy-store';
import { userInputFromSocket } from '@/lib/user-input-parsers';
import { syncPendingApprovals } from '@/lib/pending-approvals-sync';
import { applyOpenResponse } from './use-thread-open';
import i18n from '@/i18n';

type CodexLifecycleEvent =
  | { type: 'appServerRestarting'; generation: number; delayMs: number }
  | { type: 'appServerUnavailable'; generation: number; message: string }
  | { type: 'appServerReady'; generation: number; restarted: boolean }
  | { type: 'autoResumeCompleted'; generation: number; resumedThreadIds: string[]; failedThreadIds: string[] };

function dispatchJumpToThread(threadId: string): void {
  window.dispatchEvent(new CustomEvent('codex-webui:jump-thread', { detail: { threadId } }));
}

export function useCodexSocket(enabled = true) {
  const setConnected = useConnectionStore((s) => s.setConnected);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const socket = getSocket();

    // The first `connect` needs no repair: nothing has been missed yet, and the
    // open path recovers the running turn on its own. Only a genuine reconnect
    // implies a window in which notifications were dropped.
    let hasConnectedBefore = false;
    const handleConnect = () => {
      setConnected(true);
      const store = useTimelineStore.getState();
      store.resubscribeAll();
      if (hasConnectedBefore) {
        // Socket.IO guarantees ordering, not replay of events sent while this
        // client was away, so every subscribed conversation has to re-read the
        // durable history for the turns that could have moved during the gap.
        for (const threadId of store.subscribedThreadIds) {
          recoverThreadAfterReconnect(threadId);
          // The security policy has the same gap and no other repair path: its
          // only live source is `thread/settings/updated`, so a change made by
          // the CLI or another tab during the outage would otherwise leave the
          // badge asserting a policy the conversation is no longer under.
          void refreshThreadPolicy(threadId).then(() =>
            settleIfObserved(threadId),
          );
        }
        // Approvals reach this client only as socket events, so the gap loses
        // both halves of their lifecycle: one raised while away never appears,
        // and one answered on another device is never cleared.
        void syncPendingApprovals(store.subscribedThreadIds);
      }
      hasConnectedBefore = true;
    };
    const handleDisconnect = () => setConnected(false);

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    const ctx: NotificationContext = {
      threadId: null,
      // Read live rather than captured: this closure outlives many selections.
      getSelectedThreadId: () => useTimelineStore.getState().threadId,
      queryClient,
      forgetThreads: (threadIds) => {
        // Evicting a runtime while a recovery is outstanding would otherwise
        // let that response recreate the conversation it just discarded. Policy
        // state lives in its own store and needs the same treatment, or a
        // destroyed conversation leaves behind an observation and a running
        // confirmation timer.
        for (const threadId of threadIds) {
          supersedeRecovery(threadId);
          forgetThreadPolicy(threadId);
        }
        useTimelineStore.getState().forgetThreads(threadIds);
      },
      markThreadDeletedRemotely: (threadId, message) => {
        supersedeRecovery(threadId);
        forgetThreadPolicy(threadId);
        useTimelineStore.getState().markThreadDeletedRemotely(threadId, message);
      },
      updateCurrentTurn: (turnId, updater) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().updateCurrentTurnForThread(threadId, turnId, updater);
      },
      updateTurnItem: (turnId, itemId, updater) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().updateTurnItemForThread(threadId, turnId, itemId, updater);
      },
      updateTurnDiff: (turnId, diff) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().updateTurnDiffForThread(threadId, turnId, diff);
      },
      updateTurnPlan: (turnId, plan) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().updateTurnPlanForThread(threadId, turnId, plan);
      },
      appendPlanDelta: (turnId, itemId, delta) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().appendPlanDeltaForThread(threadId, turnId, itemId, delta);
      },
      setLoading: (loading) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().setLoadingForThread(threadId, loading);
      },
      expandReasoning: (itemId) => {
        const threadId = ctx.threadId;
        if (threadId && useTimelineStore.getState().threadId === threadId) {
          useTimelineStore.getState().expandReasoning(itemId);
        }
      },
      collapseReasoning: (itemId) => {
        const threadId = ctx.threadId;
        if (threadId && useTimelineStore.getState().threadId === threadId) {
          useTimelineStore.getState().collapseReasoning(itemId);
        }
      },
      addApproval: (approval) => useTimelineStore.getState().addApprovalForThread(approval.threadId, approval),
      addSystemMessage: (message, severity, turnId) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().addSystemMessageForThread(threadId, message, severity, turnId);
      },
      addSystemError: (message) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().addSystemErrorForThread(threadId, message);
      },
      upsertTurnFailure: (failure) => {
        const threadId = ctx.threadId;
        if (threadId) {
          useTimelineStore
            .getState()
            .upsertTurnFailureForThread(threadId, failure);
        }
      },
      setTokenUsage: (turnId, usage) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().setTokenUsageForThread(threadId, turnId, usage);
      },
      setThreadStatus: (status) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().setThreadStatusForThread(threadId, status);
      },
      setActiveTurnId: (turnId) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().setActiveTurnIdForThread(threadId, turnId);
      },
      clearActiveTurn: () => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().clearActiveTurnForThread(threadId);
      },
      setPlanText: (turnId, itemId, text) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().setPlanTextForThread(threadId, turnId, itemId, text);
      },
      getActiveTurnId: () => {
        const threadId = ctx.threadId;
        if (!threadId) return null;
        return useTimelineStore.getState().getThreadRuntime(threadId)?.activeTurnId ?? null;
      },
      isTurnTerminal: (turnId) => {
        const threadId = ctx.threadId;
        if (!threadId) return false;
        const runtime = useTimelineStore.getState().getThreadRuntime(threadId);
        // An unknown turn is not terminal. Treating it as terminal would drop
        // the first `turn/started` of every turn this client has yet to see.
        return (
          runtime?.timeline.some(
            (entry) => entry.kind === 'turn' && entry.turnId === turnId && entry.completed,
          ) ?? false
        );
      },
      setThreadTitle: (title) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().setThreadTitleForThread(threadId, title);
      },
      resolveApprovalByRequestId: (requestId) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().resolveApprovalByRequestIdForThread(threadId, requestId);
      },
    };

    const handleCodexNotification = (notification: {
      method: string;
      params: Record<string, unknown>;
    }) => {
      handleNotification(notification.method, notification.params, ctx);
    };

    socket.on('codex.notification', handleCodexNotification);

    const handleCodexLifecycle = (event: CodexLifecycleEvent) => {
      const store = useTimelineStore.getState();
      const liveThreadIds = [...store.subscribedThreadIds];

      if (event.type === 'appServerUnavailable') {
        for (const threadId of liveThreadIds) {
          store.clearActiveTurnForThread(threadId);
          store.setThreadStatusForThread(threadId, { type: 'systemError' });
        }
      }

      if (event.type === 'appServerRestarting') {
        for (const threadId of liveThreadIds) {
          // Any recovery still in flight was baselined against the old process
          // generation. Its response must not be applied on top of whatever the
          // restarted server reports.
          supersedeRecovery(threadId);
          store.clearActiveTurnForThread(threadId);
          store.setThreadStatusForThread(threadId, { type: 'systemError' });
          store.addSystemMessageForThread(
            threadId,
            i18n.t('Codex app-server is restarting. Waiting to resume this thread.'),
            'warning',
          );
        }
      }

      if (event.type === 'appServerReady') {
        void queryClient.invalidateQueries();
      }

      if (event.type !== 'autoResumeCompleted') return;

      for (const threadId of event.failedThreadIds) {
        store.addSystemMessageForThread(
          threadId,
          i18n.t('Auto-resume failed. Reopen this thread to retry.'),
          'error',
        );
      }

      for (const threadId of event.resumedThreadIds) {
        store.addSystemMessageForThread(
          threadId,
          i18n.t('Thread resumed after app-server restart.'),
          'info',
        );
        // Restore full thread state via deduped resume, then hydrate dependent data sequentially.
        // Recovery after an app-server restart, not a user opening anything:
        // the active-branch pointer must keep naming what they last chose.
        const openBaselineSeq = nextObservationSeq();
        void threadsResumeThread({
          path: { threadId },
          query: { recordActive: false },
        })
          .then(({ data }) => {
            if (!data) return;
            // Shared with the route and the refresh-recovery path: the response
            // carries a recent page of turns rather than the whole history, and
            // three separate readings of that shape is how one of them goes stale.
            //
            // The auxiliary datasets are deliberately NOT fetched again here.
            // Applying the open response already reads all three, and it does so
            // after the timeline is in place — which is the ordering this call
            // site used to duplicate them for. Issuing them twice cost every
            // restart-recovered conversation three wasted round trips.
            applyOpenResponse(data, openBaselineSeq);
          })
          .catch(() =>
            store.addSystemMessageForThread(
              threadId,
              i18n.t('State recovery failed after resume.'),
              'warning',
            ),
          );
      }
    };

    socket.on('codex.lifecycle', handleCodexLifecycle);

    const handleCodexServerRequest = (request: {
      id: number | string;
      method: string;
      params: Record<string, unknown>;
    }) => {
      const { id, method, params } = request;
      if (typeof params.threadId !== 'string') return;
      const reqThreadId = params.threadId;
      const store = useTimelineStore.getState();
      const title = store.getThreadTitle(reqThreadId);
      let snackbarMessage: string | null = null;

      const approval = parseApprovalRequest({ requestId: id, method, params });
      if (approval) {
        store.addApprovalForThread(reqThreadId, approval);
        snackbarMessage = i18n.t('Approval needed in {{thread}}', { thread: title });
      }

      if (method === 'item/tool/requestUserInput') {
        const userInputRequest = userInputFromSocket({ id, params });
        if (userInputRequest) {
          store.addUserInputRequestForThread(reqThreadId, userInputRequest);
          snackbarMessage = i18n.t('Input needed in {{thread}}', { thread: title });
        }
      }

      if (snackbarMessage && store.threadId !== reqThreadId) {
        showSnackbar(snackbarMessage, 'warning', 0, {
          label: i18n.t('Open thread'),
          onClick: () => dispatchJumpToThread(reqThreadId),
        });
      }
    };

    socket.on('codex.serverRequest', handleCodexServerRequest);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('codex.notification', handleCodexNotification);
      socket.off('codex.lifecycle', handleCodexLifecycle);
      socket.off('codex.serverRequest', handleCodexServerRequest);
    };
  }, [enabled, setConnected, queryClient]);
}
