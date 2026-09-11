/**
 * Hook that connects socket.io events to multi-thread Zustand state.
 * Delegates Codex notifications to the dispatcher with a mutable routed thread id.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '../socket';
import { useConnectionStore } from '../stores/connection-store';
import { useTimelineStore } from '../stores/timeline-store';
import { handleNotification, type NotificationContext } from './notification-handlers';
import { parseApprovalRequest } from '@/lib/approval-parsers';
import { invalidateThreadEpoch } from '@/lib/thread-recovery-epoch';
import { restoreThread } from '@/lib/thread-restore';
import { forgetThreadPolicy } from '@/stores/thread-policy-store';
import { userInputFromSocket } from '@/lib/user-input-parsers';
import { syncPendingApprovals, retirePendingRequest } from '@/lib/pending-approvals-sync';
import { ingestAttention } from '@/lib/attention-ingestion';
import { invalidateThreadListSoon, invalidateThreadDetails, queryHasId } from '@/lib/query-invalidation';
import i18n from '@/i18n';
import type { InteractionPresentationDto, PendingRequestResolvedDto } from '@/generated/api';
import { ingestRequestFailure } from '@/lib/server-request-failures';

type CodexLifecycleEvent =
  | { type: 'appServerRestarting'; generation: number; delayMs: number }
  | { type: 'appServerUnavailable'; generation: number; message: string }
  | { type: 'appServerReady'; generation: number; restarted: boolean }
  | { type: 'autoResumeCompleted'; generation: number; resumedThreadIds: string[]; failedThreadIds: string[] };

export function useCodexSocket(enabled = true) {
  const setConnected = useConnectionStore((s) => s.setConnected);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const socket = getSocket();

    // A hint arriving during a read requires one trailing read. Joining the
    // in-flight request alone could lose a transition served after its snapshot.
    const pendingAbort = new AbortController();
    let pendingRunning = false;
    let pendingDirty = false;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshPending = () => {
      pendingDirty = true;
      if (pendingRunning || pendingTimer || pendingAbort.signal.aborted) return;
      pendingTimer = setTimeout(() => {
        pendingTimer = undefined;
        pendingRunning = true;
        void (async () => {
          try {
            while (pendingDirty && !pendingAbort.signal.aborted) {
              pendingDirty = false;
              await syncPendingApprovals(undefined, pendingAbort.signal, queryClient);
            }
          } finally { pendingRunning = false; }
        })();
      }, 0);
    };
    const refreshOverview = () => invalidateThreadListSoon(queryClient);
    const handleConnect = () => {
      setConnected(true);
      const store = useTimelineStore.getState();
      // Also repair the first connection: the route's HTTP open may have
      // finished before the socket joined. The room acknowledgement precedes
      // this read, including after reconnect (Socket.IO provides no replay).
      store.resubscribeAll((threadId) => {
        if (!pendingAbort.signal.aborted && useTimelineStore.getState().subscribedThreadIds.has(threadId)) {
          invalidateThreadDetails(queryClient, threadId);
          void restoreThread(threadId, 'reconnect');
        }
      });
      refreshPending();
      refreshOverview();
    };
    const handleFocus = () => { refreshPending(); refreshOverview(); };
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
          invalidateThreadEpoch(threadId);
          forgetThreadPolicy(threadId);
        }
        useTimelineStore.getState().forgetThreads(threadIds);
      },
      markThreadDeletedRemotely: (threadId, message) => {
        invalidateThreadEpoch(threadId);
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
        if (!threadId) return;
        const store = useTimelineStore.getState();
        const runtime = store.getThreadRuntime(threadId);
        const request = runtime?.approvals[String(requestId)] ?? runtime?.userInputRequests[String(requestId)];
        // The compatibility room notification has no generation. Modern cards
        // are retired exclusively by the authenticated global envelope.
        if (request && request.generation == null) store.resolveApprovalByRequestIdForThread(threadId, requestId);
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
        void queryClient.cancelQueries({ predicate: (query) => queryHasId(query, 'threadsListTurnItems') });
        for (const threadId of Object.keys(store.threadsById)) invalidateThreadEpoch(threadId);
        for (const threadId of liveThreadIds) {
          // Any recovery still in flight was baselined against the old process
          // generation. Its response must not be applied on top of whatever the
          // restarted server reports.
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
        // Includes visible completed owners omitted from autoResumeCompleted's
        // target list. Their item reads are passive and need no writer resume.
        void queryClient.invalidateQueries();
      }

      if (event.type !== 'autoResumeCompleted') return;

      for (const threadId of event.failedThreadIds.filter((id) => store.subscribedThreadIds.has(id))) {
        store.addSystemMessageForThread(
          threadId,
          i18n.t('Auto-resume failed. Reopen this thread to retry.'),
          'error',
        );
      }

      for (const threadId of event.resumedThreadIds.filter((id) => store.subscribedThreadIds.has(id))) {
        store.addSystemMessageForThread(
          threadId,
          i18n.t('Thread resumed after app-server restart.'),
          'info',
        );
        // The backend already owns execution reattachment. Only this viewed
        // transcript needs browser hydration; background ids create no runtimes.
        void restoreThread(threadId, 'appServerRestart').catch(() =>
          store.addSystemMessageForThread(
            threadId,
            i18n.t('State recovery failed after resume.'),
            'warning',
          ),
        );
      }
    };

    socket.on('codex.lifecycle', handleCodexLifecycle);

    /**
     * Ingests one human request delivered to every authenticated browser.
     *
     * Room membership no longer gates this: it selects who watches a
     * transcript, not who may answer a question. So the conversation is often
     * one this client has never opened, and the request has to carry everything
     * needed to act on it — which is why a file approval brings its own change
     * set rather than relying on an item stream that was never received here.
     */
    const handleCodexServerRequest = (request: {
      instanceId?: string;
      presentation?: InteractionPresentationDto | null;
      negativeOnlyReason?: string | null;
      id: number | string;
      method: string;
      params: Record<string, unknown>;
      generation?: number;
      reviewSubject?: unknown;
    }) => {
      const { id, method, params, generation, reviewSubject, instanceId, presentation, negativeOnlyReason } = request;
      if (typeof params.threadId !== 'string') return;
      const approval = parseApprovalRequest({
        requestId: id, method, params, generation, reviewSubject, instanceId, presentation, negativeOnlyReason,
      });
      if (approval) ingestAttention(approval, queryClient);
      if (method === 'item/tool/requestUserInput') {
        const userInput = userInputFromSocket({ id, params, generation, instanceId });
        if (userInput) ingestAttention(userInput, queryClient);
      }
    };

    socket.on('codex.serverRequest', handleCodexServerRequest);
    socket.on('codex.serverRequestFailed', ingestRequestFailure);

    /**
     * Retires a request that can no longer be answered, wherever it was
     * answered and whatever the outcome.
     *
     * Broadcasting creation without broadcasting its end would leave every
     * browser that did not answer holding a live card for a dead request. The
     * status stays deliberately neutral: `resolved` here also covers app-server
     * resolving it during lifecycle cleanup, so it never implies acceptance.
     */
    const handlePendingResolved = (event: PendingRequestResolvedDto) => {
      retirePendingRequest(event);
    };

    socket.on('conversation.pending.resolved', handlePendingResolved);

    /**
     * Refreshes the shared conversation projection.
     *
     * Content-free by design: the signal says the backend's shared view moved,
     * not how. Ordering, badges and freshness all come from re-reading it, and
     * the shared debounced invalidator keeps one burst of changes to one
     * refetch rather than one per event.
     */
    const handleOverviewChanged = refreshOverview;

    /**
     * Re-reads the pending set after the backend says it moved.
     *
     * This is what covers the transitions no per-request event can: a guard
     * release republishing what a deletion withheld, and the expiry sweep. The
     * read is idempotent and refuses to resolve anything it cannot prove, so
     * running it more often than strictly necessary is safe.
     */
    const handlePendingChanged = refreshPending;

    socket.on('conversation.overview.changed', handleOverviewChanged);
    socket.on('conversation.pending.changed', handlePendingChanged);

    window.addEventListener('focus', handleFocus);
    refreshPending();
    refreshOverview();
    if (socket.connected) handleConnect();

    return () => {
      pendingAbort.abort();
      clearTimeout(pendingTimer);
      window.removeEventListener('focus', handleFocus);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('codex.notification', handleCodexNotification);
      socket.off('codex.lifecycle', handleCodexLifecycle);
      socket.off('codex.serverRequest', handleCodexServerRequest);
      socket.off('codex.serverRequestFailed', ingestRequestFailure);
      socket.off('conversation.pending.resolved', handlePendingResolved);
      socket.off('conversation.overview.changed', handleOverviewChanged);
      socket.off('conversation.pending.changed', handlePendingChanged);
    };
  }, [enabled, setConnected, queryClient]);
}
