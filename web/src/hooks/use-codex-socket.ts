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
import { tokenUsageReadThreadTokenUsage, turnDiffReadThreadTurnDiffs, threadsResumeThread } from '@/generated/api/sdk.gen';
import { parseAvailableDecisions, parseStringArray, parseNetworkAmendments } from '@/lib/approval-parsers';
import { userInputFromSocket } from '@/lib/user-input-parsers';
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

    const handleConnect = () => {
      setConnected(true);
      useTimelineStore.getState().resubscribeAll();
    };
    const handleDisconnect = () => setConnected(false);

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    const ctx: NotificationContext = {
      threadId: null,
      queryClient,
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
      addSystemMessage: (message, severity) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().addSystemMessageForThread(threadId, message, severity);
      },
      addSystemError: (message) => {
        const threadId = ctx.threadId;
        if (threadId) useTimelineStore.getState().addSystemErrorForThread(threadId, message);
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
        void threadsResumeThread({ path: { threadId } })
          .then(async ({ data }) => {
            if (!data) return;
            store.hydrateTimelineForThread(threadId, data.thread.turns, data.cwd);
            store.setThreadStatusForThread(threadId, data.thread.status);
            const activeTurn = data.thread.turns?.find((t: { status?: string }) => t.status === 'inProgress');
            store.setActiveTurnIdForThread(threadId, activeTurn?.id ?? null);
            store.setLoadingForThread(threadId, Boolean(activeTurn));
            // Hydrate after timeline is in place to avoid race.
            const [tokenRes, diffRes] = await Promise.allSettled([
              tokenUsageReadThreadTokenUsage({ path: { threadId } }),
              turnDiffReadThreadTurnDiffs({ path: { threadId } }),
            ]);
            if (tokenRes.status === 'fulfilled' && tokenRes.value.data) {
              store.hydrateTokenUsageForThread(threadId, tokenRes.value.data.turns);
            }
            if (diffRes.status === 'fulfilled' && diffRes.value.data) {
              store.hydrateTurnDiffsForThread(threadId, diffRes.value.data.turns);
            }
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
      if (
        typeof params.threadId !== 'string' ||
        typeof params.turnId !== 'string' ||
        typeof params.itemId !== 'string'
      ) {
        return;
      }
      const reqThreadId = params.threadId;
      const turnId = params.turnId;
      const itemId = params.itemId;
      const store = useTimelineStore.getState();
      const title = store.getThreadTitle(reqThreadId);
      let snackbarMessage: string | null = null;

      if (method === 'item/commandExecution/requestApproval') {
        store.addApprovalForThread(reqThreadId, {
          requestId: id,
          kind: 'commandExecution',
          threadId: reqThreadId,
          turnId,
          itemId,
          status: 'pending',
          command: (params.command as string) ?? null,
          cwd: (params.cwd as string) ?? null,
          reason: (params.reason as string) ?? null,
          availableDecisions: parseAvailableDecisions(params.availableDecisions),
          proposedExecpolicyAmendment: parseStringArray(params.proposedExecpolicyAmendment),
          proposedNetworkPolicyAmendments: parseNetworkAmendments(params.proposedNetworkPolicyAmendments),
        });
        snackbarMessage = i18n.t('Approval needed in {{thread}}', { thread: title });
      }

      if (method === 'item/fileChange/requestApproval') {
        store.addApprovalForThread(reqThreadId, {
          requestId: id,
          kind: 'fileChange',
          threadId: reqThreadId,
          turnId,
          itemId,
          status: 'pending',
          reason: (params.reason as string) ?? null,
          grantRoot: (params.grantRoot as string) ?? null,
        });
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
