/**
 * Left sidebar: global actions (top) + workspace-grouped thread navigation.
 * Rendering is split into sidebar/ sub-components; this file orchestrates
 * state, queries, mutations, and view routing.
 */
import { useMemo, useState } from 'react';
import { FolderOpen, PanelLeftClose, Puzzle, Plus, Settings, Terminal } from 'lucide-react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  threadsArchiveThreadMutation,
  threadsCompactThreadMutation,
  threadsForkThreadMutation,
  threadsListBranchTreesOptions,
  threadsListThreadsOptions,
  threadsListThreadsQueryKey,
  threadsResumeThreadMutation,
  threadsSetThreadNameMutation,
  threadsStartThreadMutation,
  threadsUnarchiveThreadMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { tokenUsageReadThreadTokenUsage, turnDiffReadThreadTurnDiffs, turnErrorsReadThreadTurnErrors } from '@/generated/api/sdk.gen';
import type { ThreadDto } from '@/generated/api';
import { useTimelineStore } from '@/stores/timeline-store';
import { useLayoutStore } from '@/stores/layout-store';
import { cn } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/api-error';
import { BranchGraphDialog } from '@/components/branches/branch-graph-dialog';
import { DeleteConversationDialog } from '@/components/branches/delete-conversation-dialog';
import {
  adoptionBlockReason,
  useBranchAdoptionStatus,
  useDeletePreview,
  useDeleteThread,
} from '@/hooks/use-thread-deletion';
import type { ConfirmAction } from './sidebar/sidebar-types';
import {
  threadLabel,
  groupByWorkspace,
  buildBranchMemberIndex,
  buildBranchRootIndex,
  collapseBranchThreads,
} from './sidebar/sidebar-types';
import { ThreadRow } from './sidebar/thread-row';
import { WorkspaceOverview } from './sidebar/workspace-overview';
import { WorkspaceDetail } from './sidebar/workspace-detail';
import { RenameDialog, ConfirmDialog } from './sidebar/sidebar-dialogs';
import { DirectoryPickerDialog } from './sidebar/directory-picker-dialog';

/** Derives the active "view" from the current route path. */
function useActiveView(): 'chat' | 'files' | 'terminal' | 'diagnostics' | 'settings' | 'integrations' | 'other' {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname.startsWith('/files')) return 'files';
  if (pathname.startsWith('/terminal')) return 'terminal';
  if (pathname.startsWith('/diagnostics')) return 'diagnostics';
  if (pathname.startsWith('/integrations')) return 'integrations';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname === '/' || pathname.startsWith('/t/')) return 'chat';
  return 'other';
}

export function ThreadSidebar() {
  const navigate = useNavigate();
  const activeView = useActiveView();
  const { t } = useTranslation();
  const threadId = useTimelineStore((s) => s.threadId);
  const threadMode = useTimelineStore((s) => s.threadMode);
  const loading = useTimelineStore((s) => s.loading);
  const approvals = useTimelineStore((s) => s.approvals);
  const threadStatus = useTimelineStore((s) => s.threadStatus);
  const threadsById = useTimelineStore((s) => s.threadsById);
  const setActiveThread = useTimelineStore((s) => s.setActiveThread);
  const clearThread = useTimelineStore((s) => s.clearThread);
  const setThreadTitle = useTimelineStore((s) => s.setThreadTitle);
  const hydrateTimelineForThread = useTimelineStore((s) => s.hydrateTimelineForThread);
  const hydrateTokenUsageForThread = useTimelineStore((s) => s.hydrateTokenUsageForThread);
  const hydrateTurnDiffsForThread = useTimelineStore((s) => s.hydrateTurnDiffsForThread);
  const hydrateTurnErrorsForThread = useTimelineStore((s) => s.hydrateTurnErrorsForThread);
  const setThreadTitleForThread = useTimelineStore((s) => s.setThreadTitleForThread);
  const setLoadingForThread = useTimelineStore((s) => s.setLoadingForThread);
  const setThreadStatusForThread = useTimelineStore((s) => s.setThreadStatusForThread);
  const setActiveTurnIdForThread = useTimelineStore((s) => s.setActiveTurnIdForThread);
  const addSystemError = useTimelineStore((s) => s.addSystemError);
  const queryClient = useQueryClient();

  // ── Layout store (sidebar view + collapsed groups + collapse) ────────
  const sidebarView = useLayoutStore((s) => s.sidebarView);
  const setSidebarView = useLayoutStore((s) => s.setSidebarView);
  const collapsedGroupKeys = useLayoutStore((s) => s.collapsedGroupKeys);
  const toggleCollapsedGroup = useLayoutStore((s) => s.toggleCollapsedGroup);
  const toggleDesktopSidebarCollapsed = useLayoutStore((s) => s.toggleDesktopSidebarCollapsed);
  // Derive Set<string> for child components that expect it
  const collapsedGroups = useMemo(() => new Set(collapsedGroupKeys), [collapsedGroupKeys]);

  // ── Local UI state (ephemeral) ─────────────────────────────────────
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [renameThread, setRenameThread] = useState<ThreadDto | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [graphTargetId, setGraphTargetId] = useState<string | null>(null);

  // ── Queries ─────────────────────────────────────────────────────────
  const overviewThreadsQuery = useQuery({
    ...threadsListThreadsOptions({
      query: { archived: false, limit: 100, sortKey: 'updated_at' },
    }),
  });
  const overviewArchivedQuery = useQuery({
    ...threadsListThreadsOptions({
      query: { archived: true, limit: 5, sortKey: 'updated_at' },
    }),
  });
  const detailQuery = useQuery({
    ...threadsListThreadsOptions({
      query:
        sidebarView.type === 'workspaceDetail'
          ? { archived: false, cwd: sidebarView.cwd, cursor: cursor ?? undefined, limit: 20, sortKey: 'updated_at' }
          : { archived: true, cursor: cursor ?? undefined, limit: 20, sortKey: 'updated_at' },
    }),
    enabled: sidebarView.type !== 'overview',
  });

  const branchTreesQuery = useQuery({
    ...threadsListBranchTreesOptions(),
    staleTime: 30_000,
  });

  // ── Deletion ────────────────────────────────────────────────────────
  const adoptionStatus = useBranchAdoptionStatus();
  const deleteBlockedReason = adoptionBlockReason(adoptionStatus.data, t);
  const deletePreview = useDeletePreview(deleteTargetId);
  // No survivor to offer: this entry point deletes a whole conversation tree,
  // so there is nothing left of it to land on.
  const deleteThread = useDeleteThread({
    onFinished: () => setDeleteTargetId(null),
  });

  // Branch members are versions of a message, not conversations of their own,
  // so they are folded into the row of their tree root everywhere threads list.
  const branchRootIndex = useMemo(
    () => buildBranchRootIndex(branchTreesQuery.data),
    [branchTreesQuery.data],
  );
  const branchMemberIndex = useMemo(
    () => buildBranchMemberIndex(branchTreesQuery.data),
    [branchTreesQuery.data],
  );
  const activeThreads = useMemo(
    () => collapseBranchThreads(overviewThreadsQuery.data?.data ?? [], branchRootIndex),
    [overviewThreadsQuery.data, branchRootIndex],
  );
  const archivedThreads = useMemo(
    () => collapseBranchThreads(overviewArchivedQuery.data?.data ?? [], branchRootIndex),
    [overviewArchivedQuery.data, branchRootIndex],
  );
  const workspaceGroups = useMemo(() => groupByWorkspace(activeThreads), [activeThreads]);
  const detailThreads = useMemo(
    () => collapseBranchThreads(detailQuery.data?.data ?? [], branchRootIndex),
    [detailQuery.data, branchRootIndex],
  );

  // A deep link to a branch must light up the root row the branch lives under.
  const highlightedThreadId = threadId
    ? (branchRootIndex.get(threadId) ?? threadId)
    : null;

  const invalidateThreads = () => {
    void queryClient.invalidateQueries({ queryKey: threadsListThreadsQueryKey() });
  };

  // ── Thread open helpers ─────────────────────────────────────────────
  const resumeThread = useMutation({
    ...threadsResumeThreadMutation(),
    onSuccess: (res) => {
      const tid = res.thread.id;
      setThreadTitleForThread(tid, threadLabel(res.thread));
      hydrateTimelineForThread(tid, res.thread.turns, res.cwd);
      setThreadStatusForThread(tid, res.thread.status);
      const activeTurn = res.thread.turns.find((turn) => turn.status === 'inProgress');
      setActiveTurnIdForThread(tid, activeTurn?.id ?? null);
      setLoadingForThread(tid, Boolean(activeTurn));
      void tokenUsageReadThreadTokenUsage({ path: { threadId: tid } })
        .then(({ data }) => data && hydrateTokenUsageForThread(tid, data.turns))
        .catch(() => undefined);
      void turnDiffReadThreadTurnDiffs({ path: { threadId: tid } })
        .then(({ data }) => data && hydrateTurnDiffsForThread(tid, data.turns))
        .catch(() => undefined);
      void turnErrorsReadThreadTurnErrors({ path: { threadId: tid } })
        .then(({ data }) => data && hydrateTurnErrorsForThread(tid, data.errors))
        .catch(() => undefined);
    },
    onError: (_err, vars) => setLoadingForThread(vars.path.threadId, false),
  });

  /**
   * True when the thread is already open *and on screen*.
   *
   * Selecting a thread leaves it selected in the store while the user moves to
   * settings, diagnostics or integrations, so store state alone cannot answer
   * "is a click a no-op" — the chat view has to actually be the one showing.
   */
  const isThreadOnScreen = (thread: ThreadDto, mode: 'live' | 'readOnly') =>
    thread.id === threadId && threadMode === mode && activeView === 'chat';

  /** Navigate to archived thread — ThreadView handles loading (resume → fail → read). */
  const openArchivedThread = (thread: ThreadDto) => {
    if (isThreadOnScreen(thread, 'readOnly')) return;
    void navigate({ to: '/t/$threadId', params: { threadId: thread.id } });
  };

  const openLiveThread = (thread: ThreadDto) => {
    if (isThreadOnScreen(thread, 'live')) return;
    setActiveThread(thread.id, thread.cwd, threadLabel(thread));
    setLoadingForThread(thread.id, true);
    resumeThread.mutate({ path: { threadId: thread.id } });
    void navigate({ to: '/t/$threadId', params: { threadId: thread.id } });
  };

  /**
   * Leaves an archived conversation, accounting for whole-tree archival.
   *
   * Archiving a root archives its hidden branches too, so the check cannot be
   * "am I on the row that was archived" — the user may be sitting on a branch
   * that has no row of its own.
   */
  const switchAfterArchive = (archivedId: string) => {
    const current = useTimelineStore.getState();
    const archivedTree = new Set([
      archivedId,
      ...(branchMemberIndex.get(archivedId) ?? []),
    ]);
    if (
      !current.threadId ||
      !archivedTree.has(current.threadId) ||
      current.threadMode !== 'live'
    ) {
      return;
    }
    const idx = activeThreads.findIndex((th) => th.id === archivedId);
    const next =
      activeThreads.slice(idx + 1).find((th) => !archivedTree.has(th.id)) ??
      activeThreads.slice(0, idx).find((th) => !archivedTree.has(th.id));
    if (next) openLiveThread(next);
    else { clearThread(); void navigate({ to: '/' }); }
  };

  // ── Mutations ───────────────────────────────────────────────────────
  const createThread = useMutation({
    ...threadsStartThreadMutation(),
    onSuccess: (res) => {
      setActiveThread(res.thread.id, res.cwd, threadLabel(res.thread));
      invalidateThreads();
      void navigate({ to: '/t/$threadId', params: { threadId: res.thread.id } });
    },
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });

  const archiveThread = useMutation({
    ...threadsArchiveThreadMutation(),
    onSuccess: (_res, vars) => {
      const treeIds = [
        vars.path.threadId,
        ...(branchMemberIndex.get(vars.path.threadId) ?? []),
      ];
      for (const id of treeIds) useTimelineStore.getState().unsubscribeThread(id);
      switchAfterArchive(vars.path.threadId);
    },
    // Whole-tree archival can fail partway through, leaving some members
    // archived; the list is stale either way, so refresh on settled.
    onSettled: () => invalidateThreads(),
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });

  const unarchiveThread = useMutation({
    ...threadsUnarchiveThreadMutation(),
    onSuccess: (res) => {
      if (threadId === res.thread.id && threadMode === 'readOnly') openLiveThread(res.thread);
    },
    onSettled: () => invalidateThreads(),
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });

  const compactThread = useMutation({
    ...threadsCompactThreadMutation(),
    onSuccess: () => invalidateThreads(),
  });

  const forkThread = useMutation({
    ...threadsForkThreadMutation(),
    onSuccess: (res) => {
      const tid = res.thread.id;
      setActiveThread(tid, res.cwd, threadLabel(res.thread));
      hydrateTimelineForThread(tid, res.thread.turns, res.cwd);
      void tokenUsageReadThreadTokenUsage({ path: { threadId: tid } })
        .then(({ data }) => data && hydrateTokenUsageForThread(tid, data.turns))
        .catch(() => undefined);
      void turnDiffReadThreadTurnDiffs({ path: { threadId: tid } })
        .then(({ data }) => data && hydrateTurnDiffsForThread(tid, data.turns))
        .catch(() => undefined);
      void turnErrorsReadThreadTurnErrors({ path: { threadId: tid } })
        .then(({ data }) => data && hydrateTurnErrorsForThread(tid, data.errors))
        .catch(() => undefined);
      invalidateThreads();
      void navigate({ to: '/t/$threadId', params: { threadId: tid } });
    },
  });

  const updateThreadName = useMutation({
    ...threadsSetThreadNameMutation(),
    onSuccess: (_res, vars) => {
      if (vars.path.threadId === threadId) setThreadTitle(vars.body.name.trim());
      setRenameThread(null);
      setRenameValue('');
      invalidateThreads();
    },
  });

  // ── View navigation helpers ─────────────────────────────────────────

  const resetDetailPagination = () => { setCursor(null); setCursorStack([]); };

  const openWorkspaceDetail = (cwd: string) => { resetDetailPagination(); setSidebarView({ type: 'workspaceDetail', cwd }); };
  const openArchivedDetail = () => { resetDetailPagination(); setSidebarView({ type: 'archivedDetail' }); };

  const goNext = () => {
    if (!detailQuery.data?.nextCursor) return;
    setCursorStack((s) => [...s, cursor]);
    setCursor(detailQuery.data.nextCursor);
  };
  const goPrevious = () => {
    setCursorStack((s) => { const ns = s.slice(0, -1); setCursor(s.at(-1) ?? null); return ns; });
  };

  // ── Rename / Confirm ────────────────────────────────────────────────
  const startRename = (thread: ThreadDto) => { setRenameThread(thread); setRenameValue(threadLabel(thread)); };
  const saveRename = () => {
    if (!renameThread) return;
    const name = renameValue.trim();
    if (!name) return;
    updateThreadName.mutate({ path: { threadId: renameThread.id }, body: { name } });
  };
  const confirmCurrentAction = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'archive') archiveThread.mutate({ path: { threadId: confirmAction.thread.id } });
    if (confirmAction.type === 'compact') compactThread.mutate({ path: { threadId: confirmAction.thread.id } });
    setConfirmAction(null);
  };

  // ── Shared thread-row renderer (passed to overview/detail) ──────────
  const renderThreadRow = (thread: ThreadDto, archived: boolean) => {
    const readRuntime = (id: string) =>
      id === threadId ? { loading, approvals, threadStatus } : threadsById[id];

    // A hidden branch has no row of its own, so anything that needs the user's
    // attention inside it has to surface on the tree's visible root row.
    const treeRuntimes = [
      readRuntime(thread.id),
      ...(branchMemberIndex.get(thread.id) ?? []).map(readRuntime),
    ].filter((runtime) => runtime !== undefined);

    const isRunning = treeRuntimes.some((runtime) => runtime.loading);
    const activeFlags = treeRuntimes.flatMap((runtime) =>
      runtime.threadStatus?.type === 'active' ? runtime.threadStatus.activeFlags : [],
    );
    // Count hydrated pending approvals (source of truth for badge).
    const pendingApprovalCount = treeRuntimes.reduce(
      (total, runtime) =>
        total +
        Object.values(runtime.approvals ?? {}).filter((a) => a.status === 'pending').length,
      0,
    );
    const waitingOnApproval =
      activeFlags.includes('waitingOnApproval') || pendingApprovalCount > 0;
    const waitingOnUserInput = activeFlags.includes('waitingOnUserInput');
    // "Generating" = thread active but not blocked on any user-facing request.
    const generating =
      treeRuntimes.some((runtime) => runtime.threadStatus?.type === 'active') &&
      !waitingOnApproval &&
      !waitingOnUserInput;

    return (
      <ThreadRow
        key={thread.id}
        thread={thread}
        archived={archived}
        isActive={thread.id === highlightedThreadId && activeView === 'chat'}
        destructiveDisabled={isRunning}
        actionPending={forkThread.isPending || unarchiveThread.isPending}
        running={generating || isRunning}
        pendingApproval={waitingOnApproval}
        pendingApprovalCount={pendingApprovalCount}
        waitingOnUserInput={waitingOnUserInput}
        hasBranchDescendants={branchMemberIndex.has(thread.id)}
        onOpen={() => { if (archived) void openArchivedThread(thread); else openLiveThread(thread); }}
        onRename={() => startRename(thread)}
        onArchive={() => setConfirmAction({ type: 'archive', thread })}
        onUnarchive={() => unarchiveThread.mutate({ path: { threadId: thread.id } })}
        onCompact={() => setConfirmAction({ type: 'compact', thread })}
        onFork={() => forkThread.mutate({ path: { threadId: thread.id } })}
        deleteBlockedReason={deleteBlockedReason}
        onDelete={() => setDeleteTargetId(thread.id)}
        onShowBranchGraph={() => setGraphTargetId(thread.id)}
      />
    );
  };

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col bg-card/80">
      {/* Global actions */}
      <div className="space-y-0.5 px-2 py-2">
        <button
          type="button"
          onClick={() => void navigate({ to: '/files' })}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
            activeView === 'files'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <FolderOpen className="h-4 w-4 shrink-0" />
          {t('Files')}
        </button>
        <button
          type="button"
          onClick={() => void navigate({ to: '/terminal' })}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
            activeView === 'terminal'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <Terminal className="h-4 w-4 shrink-0" />
          {t('Terminal')}
        </button>
        <button
          type="button"
          onClick={() => void navigate({ to: '/integrations', search: { tab: 'plugins' } })}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
            activeView === 'integrations'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <Puzzle className="h-4 w-4 shrink-0" />
          {t('Integrations')}
        </button>
        <button
          type="button"
          onClick={() => void navigate({ to: '/settings' })}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
            activeView === 'settings'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <Settings className="h-4 w-4 shrink-0" />
          {t('Settings')}
        </button>
      </div>

      <Separator />

      {/* Thread list header */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">{t('Threads')}</span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label={t('New workspace thread')}
          title={t('New workspace thread')}
          onClick={() => setDirPickerOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 [&_[data-slot=scroll-area-viewport]>div]:block!">
        {sidebarView.type === 'overview' ? (
          <WorkspaceOverview
            archivedThreads={archivedThreads}
            workspaceGroups={workspaceGroups}
            collapsedGroups={collapsedGroups}
            isLoading={overviewThreadsQuery.isLoading || overviewArchivedQuery.isLoading}
            onToggleCollapse={toggleCollapsedGroup}
            onOpenArchivedDetail={openArchivedDetail}
            onOpenWorkspaceDetail={openWorkspaceDetail}
            onCreateInWorkspace={(cwd) => createThread.mutate({ body: { cwd } })}
            renderThreadRow={renderThreadRow}
          />
        ) : (
          <WorkspaceDetail
            sidebarView={sidebarView}
            threads={detailThreads}
            isLoading={detailQuery.isLoading}
            hasPrevious={cursorStack.length > 0}
            hasNext={!!detailQuery.data?.nextCursor}
            onBack={() => setSidebarView({ type: 'overview' })}
            onPrevious={goPrevious}
            onNext={goNext}
            renderThreadRow={renderThreadRow}
          />
        )}
      </ScrollArea>

      {/* Desktop collapse toggle (hidden in mobile Sheet) */}
      <div className="hidden shrink-0 border-t border-border px-2 py-1.5 lg:block">
        <button
          type="button"
          onClick={toggleDesktopSidebarCollapsed}
          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4 shrink-0" />
          {t('Collapse sidebar')}
        </button>
      </div>

      <RenameDialog
        open={renameThread !== null}
        pending={updateThreadName.isPending}
        value={renameValue}
        onChange={setRenameValue}
        onSave={saveRename}
        onClose={() => setRenameThread(null)}
      />
      <ConfirmDialog
        action={confirmAction}
        pending={archiveThread.isPending || compactThread.isPending}
        onConfirm={confirmCurrentAction}
        onClose={() => setConfirmAction(null)}
      />
      <DirectoryPickerDialog
        open={dirPickerOpen}
        onClose={() => setDirPickerOpen(false)}
        onSelect={(cwd) => createThread.mutate({ body: { cwd } })}
      />
      <DeleteConversationDialog
        open={deleteTargetId !== null}
        preview={deletePreview.data ?? null}
        loading={deletePreview.isLoading}
        errorMessage={
          deletePreview.error ? getApiErrorMessage(deletePreview.error) : null
        }
        pending={deleteThread.isPending}
        currentThreadId={threadId}
        onConfirm={(preview) =>
          deleteThread.mutate({
            path: { threadId: preview.targetThreadId },
            body: { expectedThreadIds: preview.threadIds },
          })
        }
        onClose={() => setDeleteTargetId(null)}
      />
      <BranchGraphDialog
        threadId={graphTargetId}
        onClose={() => setGraphTargetId(null)}
      />
    </div>
  );
}
