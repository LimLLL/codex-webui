/**
 * Hook that connects socket.io events to Zustand stores.
 * Delegates all Codex notification routing to the dispatcher.
 * Also triggers TanStack Query invalidation for relevant events.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '../socket';
import { useConnectionStore } from '../stores/connection-store';
import { useTimelineStore } from '../stores/timeline-store';
import { useFilesStore } from '../stores/files-store';
import { handleNotification, type NotificationContext } from './notification-handlers';
import { tokenUsageReadThreadTokenUsage } from '@/generated/api/sdk.gen';
import i18n from '@/i18n';

type CodexLifecycleEvent =
  | { type: 'appServerRestarting'; generation: number; delayMs: number }
  | { type: 'appServerUnavailable'; generation: number; message: string }
  | { type: 'appServerReady'; generation: number; restarted: boolean }
  | { type: 'autoResumeCompleted'; generation: number; resumedThreadIds: string[]; failedThreadIds: string[] };

export function useCodexSocket(enabled = true) {
  const setConnected = useConnectionStore((s) => s.setConnected);
  const queryClient = useQueryClient();
  const rootDir = useFilesStore((s) => s.rootDir);
  const expandedDirs = useFilesStore((s) => s.expandedDirs);
  const {
    threadId,
    updateCurrentTurn,
    updateTurnItem,
    updateTurnDiff,
    setLoading,
    expandReasoning,
    collapseReasoning,
    addApproval,
    addSystemMessage,
    addSystemError,
    setTokenUsage,
    setThreadStatus,
    setActiveTurnId,
    clearActiveTurn,
    hydrateTokenUsage,
    setThreadTitle,
    resolveApprovalByRequestId,
  } = useTimelineStore();

  useEffect(() => {
    if (!enabled) return;

    const socket = getSocket();

    socket.on('connect', () => {
      setConnected(true);
      const { threadId: activeId, threadMode: mode } = useTimelineStore.getState();
      if (activeId && mode === 'live') {
        socket.emit('thread.subscribe', { threadId: activeId });
      }
    });
    socket.on('disconnect', () => setConnected(false));

    // Build context object for the notification dispatcher
    const ctx: NotificationContext = {
      threadId,
      queryClient,
      updateCurrentTurn,
      updateTurnItem,
      updateTurnDiff,
      setLoading,
      expandReasoning,
      collapseReasoning,
      addApproval,
      addSystemMessage,
      addSystemError,
      setTokenUsage,
      setThreadStatus,
      setActiveTurnId,
      clearActiveTurn,
      setThreadTitle,
      resolveApprovalByRequestId,
    };

    socket.on(
      'codex.notification',
      (notification: { method: string; params: Record<string, unknown> }) => {
        handleNotification(notification.method, notification.params, ctx);
      },
    );

    socket.on('codex.lifecycle', (event: CodexLifecycleEvent) => {
      const activeThreadId = useTimelineStore.getState().threadId;

      if (event.type === 'appServerUnavailable') {
        clearActiveTurn();
        setThreadStatus({ type: 'systemError' });
      }

      if (event.type === 'appServerRestarting') {
        clearActiveTurn();
        setThreadStatus({ type: 'systemError' });
        if (activeThreadId) {
          addSystemMessage(
            i18n.t('Codex app-server is restarting. Waiting to resume this thread.'),
            'warning',
          );
        }
      }

      if (event.type === 'appServerReady') {
        void queryClient.invalidateQueries();
      }

      if (event.type !== 'autoResumeCompleted' || !activeThreadId) return;

      if (event.failedThreadIds.includes(activeThreadId)) {
        addSystemMessage(i18n.t('Auto-resume failed. Reopen this thread to retry.'), 'error');
        return;
      }

      if (event.resumedThreadIds.includes(activeThreadId)) {
        addSystemMessage(i18n.t('Thread resumed after app-server restart.'), 'info');
        void tokenUsageReadThreadTokenUsage({ path: { threadId: activeThreadId } })
          .then(({ data }) => data && hydrateTokenUsage(data.turns))
          .catch(() =>
            addSystemMessage(i18n.t('Token usage recovery failed after resume.'), 'warning'),
          );
      }
    });

    // File watcher events → invalidate affected file queries
    socket.on('fs.changed', (event: { event: string; path: string }) => {
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) => {
          const key = queryKey[0] as
            | { _id?: string; query?: { path?: string; root?: string } }
            | undefined;
          if (!key?._id) return false;
          if (key._id === 'filesReadTree') return true;
          return (
            (key._id === 'filesReadFile' || key._id === 'filesGetMetadata') &&
            key.query?.path === event.path
          );
        },
      });
    });

    socket.on(
      'codex.serverRequest',
      (request: {
        id: number | string;
        method: string;
        params: Record<string, unknown>;
      }) => {
        const { id, method, params } = request;
        const reqThreadId = params.threadId as string;
        const turnId = params.turnId as string;
        const itemId = params.itemId as string;

        if (method === 'item/commandExecution/requestApproval') {
          addApproval({
            requestId: id,
            kind: 'commandExecution',
            threadId: reqThreadId,
            turnId,
            itemId,
            status: 'pending',
            command: (params.command as string) ?? null,
            cwd: (params.cwd as string) ?? null,
            reason: (params.reason as string) ?? null,
          });
        }

        if (method === 'item/fileChange/requestApproval') {
          addApproval({
            requestId: id,
            kind: 'fileChange',
            threadId: reqThreadId,
            turnId,
            itemId,
            status: 'pending',
            reason: (params.reason as string) ?? null,
            grantRoot: (params.grantRoot as string) ?? null,
          });
        }
      },
    );

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('codex.notification');
      socket.off('codex.lifecycle');
      socket.off('codex.serverRequest');
      socket.off('fs.changed');
    };
  }, [
    enabled,
    threadId,
    setConnected,
    queryClient,
    updateCurrentTurn,
    updateTurnItem,
    updateTurnDiff,
    setLoading,
    expandReasoning,
    collapseReasoning,
    addApproval,
    addSystemMessage,
    addSystemError,
    setTokenUsage,
    setThreadStatus,
    setActiveTurnId,
    clearActiveTurn,
    hydrateTokenUsage,
    setThreadTitle,
    resolveApprovalByRequestId,
  ]);

  // Subscribe/unsubscribe file watchers for visible directories
  useEffect(() => {
    if (!enabled) return;

    const socket = getSocket();
    const watchedDirs = new Set<string>();
    if (rootDir) watchedDirs.add(rootDir);
    for (const dir of expandedDirs) watchedDirs.add(dir);

    for (const path of watchedDirs) {
      socket.emit('fs.subscribe', { path });
    }

    return () => {
      for (const path of watchedDirs) {
        socket.emit('fs.unsubscribe', { path });
      }
    };
  }, [enabled, rootDir, expandedDirs]);
}
