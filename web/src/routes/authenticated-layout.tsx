/**
 * Authenticated layout: sidebar + header + main content outlet.
 * Replaces the old App.tsx conditional rendering.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from '@/components/ui/sheet';
import { ChatHeader } from '@/components/chat/chat-header';
import { ThreadSidebar } from '@/components/chat/thread-sidebar';
import { SnackbarContainer } from '@/components/snackbar/snackbar-container';
import { CodexStatusBanner } from '@/components/codex-status-banner';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { useCodexSocket } from '@/hooks/use-codex-socket';
import { useFilesStore } from '@/stores/files-store';
import { useLayoutStore } from '@/stores/layout-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { useThemeStore } from '@/stores/theme-store';
import { cn } from '@/lib/utils';
import { clearApiToken } from '@/auth-token';
import { getSocket, resetSocket } from '@/socket';
import { filesGetRoots, filesAddRoot } from '@/generated/api';
import {
  pendingApprovalsListPending,
  settingsListSettings,
  threadsListLoadedThreads,
  threadsResumeThread,
} from '@/generated/api/sdk.gen';
import { settingsListSettingsQueryKey } from '@/generated/api/@tanstack/react-query.gen';
import type { PendingServerRequestDto } from '@/generated/api';
import type { ApprovalRequest } from '@/types/approval';
import { parseAvailableDecisions, parseStringArray, parseNetworkAmendments } from '@/lib/approval-parsers';
import { userInputFromPending } from '@/lib/user-input-parsers';
import { applyOpenResponse } from '@/hooks/use-thread-open';

const MAX_IDLE_SUBSCRIPTIONS_KEY = 'general.maxIdleSubscriptions';
const DEFAULT_MAX_IDLE_SUBSCRIPTIONS = 30;
const IDLE_SUBSCRIPTION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

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

function readMaxIdleSubscriptions(
  settings: Array<{ key: string; value: unknown }> | undefined,
): number {
  const value = settings?.find(
    (setting) => setting.key === MAX_IDLE_SUBSCRIPTIONS_KEY,
  )?.value;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : DEFAULT_MAX_IDLE_SUBSCRIPTIONS;
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
  const setMaxIdleSubscriptions = useTimelineStore((s) => s.setMaxIdleSubscriptions);
  const cleanupIdleThreadSubscriptions = useTimelineStore((s) => s.cleanupIdleThreadSubscriptions);
  const setRootDir = useFilesStore((s) => s.setRootDir);
  const dark = useThemeStore((s) => s.dark);
  const toggleDark = useThemeStore((s) => s.toggleDark);
  const generalSettingsQuery = useQuery({
    queryKey: settingsListSettingsQueryKey({ query: { category: 'general' } }),
    queryFn: async () => {
      const { data } = await settingsListSettings({
        query: { category: 'general' },
        throwOnError: true,
      });
      return data;
    },
  });
  const maxIdleSubscriptions = readMaxIdleSubscriptions(
    generalSettingsQuery.data?.settings,
  );

  useCodexSocket(true);

  useEffect(() => {
    setMaxIdleSubscriptions(maxIdleSubscriptions);
  }, [maxIdleSubscriptions, setMaxIdleSubscriptions]);

  useEffect(() => {
    const timer = window.setInterval(
      () => cleanupIdleThreadSubscriptions(maxIdleSubscriptions),
      IDLE_SUBSCRIPTION_CLEANUP_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [cleanupIdleThreadSubscriptions, maxIdleSubscriptions]);

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

          // Reopen to restore state. Backend dedup makes this safe, and the
          // shared applier is what keeps this path in step with the route's:
          // the response carries a recent page of turns, not a whole history.
          // `recordActive: false` — nobody opened these, the page was reloaded.
          // Letting a bulk restore write the active-branch pointer would leave
          // each tree naming whichever member happened to be restored last.
          void threadsResumeThread({
            path: { threadId: tid },
            query: { recordActive: false },
          })
            .then(({ data: resumeData }) => {
              if (cancelled || !resumeData) return;
              applyOpenResponse(resumeData);
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

  const { t } = useTranslation();
  const handleToggleDiagnostics = useCallback(() => {
    void navigate({ to: '/diagnostics' });
  }, [navigate]);

  // ── Responsive layout ────────────────────────────────────────────────
  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const setSidebarOpen = useLayoutStore((s) => s.setSidebarOpen);
  const desktopSidebarCollapsed = useLayoutStore((s) => s.desktopSidebarCollapsed);

  // Auto-close sidebar sheet on route change
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname, setSidebarOpen]);

  // Auto-close sidebar sheet when entering desktop breakpoint
  useEffect(() => {
    if (isDesktop) setSidebarOpen(false);
  }, [isDesktop, setSidebarOpen]);

  return (
    <TooltipProvider>
      <div className="flex h-full overflow-hidden bg-background">
        {/* Desktop: inline sidebar with collapse animation */}
        {isDesktop && (
          <aside
            className={cn(
              'relative z-10 shrink-0 overflow-hidden border-r border-[var(--glass-border-subtle)] transition-[width] duration-200 ease-in-out',
              desktopSidebarCollapsed ? 'w-0 border-r-0' : 'w-64',
            )}
          >
            <div className="flex h-full w-64 flex-col">
              <ThreadSidebar />
            </div>
          </aside>
        )}

        {/* Mobile/Tablet: sidebar as Sheet overlay */}
        {!isDesktop && (
          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetContent side="left" className="!w-[280px] p-0 sm:!max-w-[320px]" showCloseButton={false}>
              <SheetTitle className="sr-only">{t('Navigation')}</SheetTitle>
              <ThreadSidebar />
            </SheetContent>
          </Sheet>
        )}

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
