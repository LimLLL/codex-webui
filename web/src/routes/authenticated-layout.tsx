/**
 * Authenticated layout: sidebar + header + main content outlet.
 * Replaces the old App.tsx conditional rendering.
 */
import { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatHeader } from '@/components/chat/chat-header';
import { ThreadSidebar } from '@/components/chat/thread-sidebar';
import { SnackbarContainer } from '@/components/snackbar/snackbar-container';
import { CodexStatusBanner } from '@/components/codex-status-banner';
import { useCodexSocket } from '@/hooks/use-codex-socket';
import { useFilesStore } from '@/stores/files-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { useThemeStore } from '@/stores/theme-store';
import { clearApiToken } from '@/auth-token';
import { getSocket, resetSocket } from '@/socket';
import { filesGetRoots, filesAddRoot } from '@/generated/api';
import {
  pendingApprovalsListPending,
  threadsListLoadedThreads,
  threadsResumeThread,
} from '@/generated/api/sdk.gen';
import type { PendingServerRequestDto } from '@/generated/api';
import type { ApprovalRequest } from '@/types/approval';
import { parseAvailableDecisions, parseStringArray, parseNetworkAmendments } from '@/lib/approval-parsers';
import { userInputFromPending } from '@/lib/user-input-parsers';

function approvalFromPending(request: PendingServerRequestDto): ApprovalRequest | null {
  const params = request.params;
  const turnId = typeof params.turnId === 'string' ? params.turnId : request.turnId;
  const itemId = typeof params.itemId === 'string' ? params.itemId : request.itemId;
  if (!turnId || !itemId || request.status !== 'pending') return null;

  if (request.method === 'item/commandExecution/requestApproval') {
    return {
      requestId: request.requestId,
      kind: 'commandExecution',
      threadId: request.threadId,
      turnId,
      itemId,
      status: 'pending',
      command: (params.command as string) ?? null,
      cwd: (params.cwd as string) ?? null,
      reason: (params.reason as string) ?? null,
      availableDecisions: parseAvailableDecisions(params.availableDecisions),
      proposedExecpolicyAmendment: parseStringArray(params.proposedExecpolicyAmendment),
      proposedNetworkPolicyAmendments: parseNetworkAmendments(params.proposedNetworkPolicyAmendments),
    };
  }

  if (request.method === 'item/fileChange/requestApproval') {
    return {
      requestId: request.requestId,
      kind: 'fileChange',
      threadId: request.threadId,
      turnId,
      itemId,
      status: 'pending',
      reason: (params.reason as string) ?? null,
      grantRoot: (params.grantRoot as string) ?? null,
    };
  }

  return null;
}

export function AuthenticatedLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [homeDir, setHomeDir] = useState<string | null>(null);

  const threadCwd = useTimelineStore((s) => s.threadCwd);
  const addApprovalForThread = useTimelineStore((s) => s.addApprovalForThread);
  const addUserInputRequestForThread = useTimelineStore((s) => s.addUserInputRequestForThread);
  const ensureThreadState = useTimelineStore((s) => s.ensureThreadState);
  const hydrateTimelineForThread = useTimelineStore((s) => s.hydrateTimelineForThread);
  const setLoadingForThread = useTimelineStore((s) => s.setLoadingForThread);
  const setThreadStatusForThread = useTimelineStore((s) => s.setThreadStatusForThread);
  const setActiveTurnIdForThread = useTimelineStore((s) => s.setActiveTurnIdForThread);
  const setThreadTitleForThread = useTimelineStore((s) => s.setThreadTitleForThread);
  const setActiveThread = useTimelineStore((s) => s.setActiveThread);
  const setRootDir = useFilesStore((s) => s.setRootDir);
  const dark = useThemeStore((s) => s.dark);
  const toggleDark = useThemeStore((s) => s.toggleDark);

  useCodexSocket(true);

  // Fetch home dir on mount
  useEffect(() => {
    filesGetRoots({ throwOnError: true })
      .then(({ data }) => setHomeDir(data.homeDir))
      .catch(() => undefined);
  }, []);

  // Discover loaded threads and hydrate pending approvals on mount.
  useEffect(() => {
    let cancelled = false;
    const socket = getSocket();

    // 1. Discover loaded threads from app-server memory and subscribe them.
    const discoverLoadedThreads = async () => {
      const seen = new Set<string>();
      let cursor: string | undefined;

      // Paginate up to 3 pages (600 threads max — more than enough for a single user).
      for (let page = 0; page < 3; page += 1) {
        const { data } = await threadsListLoadedThreads({
          query: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        if (cancelled || !data) return;

        for (const tid of data.data) {
          if (seen.has(tid)) continue;
          seen.add(tid);

          ensureThreadState({ threadId: tid });
          setLoadingForThread(tid, true);
          socket.emit('thread.subscribe', { threadId: tid });
          useTimelineStore.setState((s) => ({
            subscribedThreadIds: new Set(s.subscribedThreadIds).add(tid),
          }));

          // Resume to get full thread state (dedup makes this safe).
          void threadsResumeThread({ path: { threadId: tid } })
            .then(({ data: resumeData }) => {
              if (cancelled || !resumeData) return;
              hydrateTimelineForThread(
                tid,
                resumeData.thread.turns ?? [],
                resumeData.cwd ?? resumeData.thread.cwd,
              );
              setThreadTitleForThread(
                tid,
                resumeData.thread.name ?? resumeData.thread.preview ?? null,
              );
              setThreadStatusForThread(tid, resumeData.thread.status);
              const activeTurn = resumeData.thread.turns?.find(
                (turn: { status?: string }) => turn.status === 'inProgress',
              );
              setActiveTurnIdForThread(tid, activeTurn?.id ?? null);
              setLoadingForThread(tid, Boolean(activeTurn));
            })
            .catch(() => {
              if (!cancelled) setLoadingForThread(tid, false);
            });
        }

        if (!data.nextCursor) break;
        cursor = data.nextCursor;
      }
    };
    void discoverLoadedThreads().catch(() => undefined);

    // 2. Hydrate pending approvals and user input requests.
    void pendingApprovalsListPending()
      .then(({ data }) => {
        if (cancelled || !data) return;
        for (const request of data.requests) {
          const approval = approvalFromPending(request);
          if (approval) addApprovalForThread(request.threadId, approval);
          const userInput = userInputFromPending(request);
          if (userInput) addUserInputRequestForThread(request.threadId, userInput);
        }
      })
      .catch(() => undefined);

    return () => { cancelled = true; };
  }, [
    addApprovalForThread,
    addUserInputRequestForThread,
    ensureThreadState,
    hydrateTimelineForThread,
    setActiveTurnIdForThread,
    setLoadingForThread,
    setThreadStatusForThread,
    setThreadTitleForThread,
  ]);

  // Handle snackbar jump-to-thread actions.
  useEffect(() => {
    const handleJump = (event: Event) => {
      const threadId = (event as CustomEvent<{ threadId?: string }>).detail?.threadId;
      if (!threadId) return;
      setActiveThread(threadId);
      void navigate({ to: '/t/$threadId', params: { threadId } });
    };
    window.addEventListener('codex-webui:jump-thread', handleJump);
    return () => window.removeEventListener('codex-webui:jump-thread', handleJump);
  }, [navigate, setActiveThread]);

  // Handle auth expiry → redirect to /login
  useEffect(() => {
    const handleAuthExpired = () => {
      clearApiToken();
      resetSocket();
      void navigate({ to: '/login', search: { redirect: '/' } });
    };
    window.addEventListener('codex-webui:auth-expired', handleAuthExpired);
    return () => window.removeEventListener('codex-webui:auth-expired', handleAuthExpired);
  }, [navigate]);

  // Sync file tree root based on current route context
  useEffect(() => {
    const dir = pathname.startsWith('/files')
      ? homeDir
      : pathname.startsWith('/t/')
        ? threadCwd
        : null;
    if (dir) {
      void filesAddRoot({ body: { root: dir }, throwOnError: true, meta: { silent: true } })
        .then(() => setRootDir(dir))
        .catch(() => { /* root rejected */ });
    } else {
      setRootDir(null);
    }
  }, [pathname, threadCwd, homeDir, setRootDir]);

  const handleToggleDiagnostics = useCallback(() => {
    void navigate({ to: '/diagnostics' });
  }, [navigate]);

  return (
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden bg-background">
        <ThreadSidebar />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col isolate">
          <ChatHeader
            dark={dark}
            onToggleDark={toggleDark}
            onToggleDiagnostics={handleToggleDiagnostics}
          />
          <CodexStatusBanner />
          <Outlet />
        </div>
      </div>
      <SnackbarContainer />
    </TooltipProvider>
  );
}
