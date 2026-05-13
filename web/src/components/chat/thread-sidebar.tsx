/**
 * Left sidebar: global actions (top) + workspace-grouped thread navigation.
 * Rendering is split into sidebar/ sub-components; this file orchestrates
 * state, queries, mutations, and view routing.
 */
import { useMemo, useState } from 'react';
import { FolderOpen, Plus, Terminal } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  threadsArchiveThreadMutation,
  threadsCompactThreadMutation,
  threadsForkThreadMutation,
  threadsListThreadsOptions,
  threadsListThreadsQueryKey,
  threadsReadThreadOptions,
  threadsResumeThreadMutation,
  threadsSetThreadNameMutation,
  threadsStartThreadMutation,
  threadsUnarchiveThreadMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { tokenUsageReadThreadTokenUsage } from '@/generated/api/sdk.gen';
import type { ThreadDto } from '@/generated/api';
import { useTimelineStore } from '@/stores/timeline-store';
import { showSnackbar } from '@/stores/snackbar-store';
import { cn } from '@/lib/utils';
import type { GlobalView } from '@/types/views';
import type { ConfirmAction, SidebarView } from './sidebar/sidebar-types';
import { threadLabel, groupByWorkspace } from './sidebar/sidebar-types';
import { ThreadRow } from './sidebar/thread-row';
import { WorkspaceOverview } from './sidebar/workspace-overview';
import { WorkspaceDetail } from './sidebar/workspace-detail';
import { RenameDialog, ConfirmDialog } from './sidebar/sidebar-dialogs';
import { DirectoryPickerDialog } from './sidebar/directory-picker-dialog';

interface Props {
  activeView: GlobalView;
  onViewChange: (view: GlobalView) => void;
}

export function ThreadSidebar({ activeView, onViewChange }: Props) {
  const { t } = useTranslation();
  const threadId = useTimelineStore((s) => s.threadId);
  const threadMode = useTimelineStore((s) => s.threadMode);
  const loading = useTimelineStore((s) => s.loading);
  const setActiveThread = useTimelineStore((s) => s.setActiveThread);
  const setReadOnlyThread = useTimelineStore((s) => s.setReadOnlyThread);
  const clearThread = useTimelineStore((s) => s.clearThread);
  const hydrateTimeline = useTimelineStore((s) => s.hydrateTimeline);
  const hydrateTokenUsage = useTimelineStore((s) => s.hydrateTokenUsage);
  const setThreadTitle = useTimelineStore((s) => s.setThreadTitle);
  const addSystemError = useTimelineStore((s) => s.addSystemError);
  const setLoading = useTimelineStore((s) => s.setLoading);
  const queryClient = useQueryClient();

  // ── Local UI state ──────────────────────────────────────────────────
  const [sidebarView, setSidebarView] = useState<SidebarView>({ type: 'overview' });
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [renameThread, setRenameThread] = useState<ThreadDto | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [dirPickerOpen, setDirPickerOpen] = useState(false);

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

  const activeThreads = useMemo(() => overviewThreadsQuery.data?.data ?? [], [overviewThreadsQuery.data]);
  const archivedThreads = useMemo(() => overviewArchivedQuery.data?.data ?? [], [overviewArchivedQuery.data]);
  const workspaceGroups = useMemo(() => groupByWorkspace(activeThreads), [activeThreads]);
  const detailThreads = detailQuery.data?.data ?? [];

  const invalidateThreads = () => {
    void queryClient.invalidateQueries({ queryKey: threadsListThreadsQueryKey() });
  };

  // ── Thread open helpers ─────────────────────────────────────────────
  const resumeThread = useMutation({
    ...threadsResumeThreadMutation(),
    onSuccess: (res) => {
      setThreadTitle(threadLabel(res.thread));
      hydrateTimeline(res.thread.turns, res.cwd);
      void tokenUsageReadThreadTokenUsage({ path: { threadId: res.thread.id } })
        .then(({ data }) => data && hydrateTokenUsage(data.turns))
        .catch(() => undefined);
    },
    onError: () => setLoading(false),
  });

  const openArchivedThread = async (thread: ThreadDto) => {
    if (thread.id === threadId && threadMode === 'readOnly') return;
    setLoading(true);
    try {
      const res = await queryClient.fetchQuery(
        threadsReadThreadOptions({
          path: { threadId: thread.id },
          query: { includeTurns: true },
        }),
      );
      setReadOnlyThread(res.thread);
      void tokenUsageReadThreadTokenUsage({ path: { threadId: res.thread.id } })
        .then(({ data }) => data && hydrateTokenUsage(data.turns))
        .catch(() => undefined);
      onViewChange('chat');
    } catch {
      setLoading(false);
      showSnackbar(t('Cannot read archived thread. Try unarchive or fork.'), 'warning');
    }
  };

  const openLiveThread = (thread: ThreadDto) => {
    if (thread.id === threadId && threadMode === 'live') return;
    setActiveThread(thread.id, thread.cwd, threadLabel(thread));
    setLoading(true);
    resumeThread.mutate({ path: { threadId: thread.id } });
    onViewChange('chat');
  };

  const switchAfterArchive = (archivedId: string) => {
    const current = useTimelineStore.getState();
    if (current.threadId !== archivedId || current.threadMode !== 'live') return;
    const idx = activeThreads.findIndex((th) => th.id === archivedId);
    const next =
      activeThreads.slice(idx + 1).find((th) => th.id !== archivedId) ??
      activeThreads.slice(0, idx).find((th) => th.id !== archivedId);
    if (next) openLiveThread(next);
    else clearThread();
  };

  // ── Mutations ───────────────────────────────────────────────────────
  const createThread = useMutation({
    ...threadsStartThreadMutation(),
    onSuccess: (res) => {
      setActiveThread(res.thread.id, res.cwd, threadLabel(res.thread));
      invalidateThreads();
    },
    onError: (err) => addSystemError(String(err.message)),
  });

  const archiveThread = useMutation({
    ...threadsArchiveThreadMutation(),
    onSuccess: (_res, vars) => { invalidateThreads(); switchAfterArchive(vars.path.threadId); },
  });

  const unarchiveThread = useMutation({
    ...threadsUnarchiveThreadMutation(),
    onSuccess: (res) => {
      invalidateThreads();
      if (threadId === res.thread.id && threadMode === 'readOnly') openLiveThread(res.thread);
    },
  });

  const compactThread = useMutation({
    ...threadsCompactThreadMutation(),
    onSuccess: () => invalidateThreads(),
  });

  const forkThread = useMutation({
    ...threadsForkThreadMutation(),
    onSuccess: (res) => {
      setActiveThread(res.thread.id, res.cwd, threadLabel(res.thread));
      hydrateTimeline(res.thread.turns, res.cwd);
      void tokenUsageReadThreadTokenUsage({ path: { threadId: res.thread.id } })
        .then(({ data }) => data && hydrateTokenUsage(data.turns))
        .catch(() => undefined);
      invalidateThreads();
      onViewChange('chat');
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
  const toggleCollapse = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

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
  const renderThreadRow = (thread: ThreadDto, archived: boolean) => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      archived={archived}
      isActive={thread.id === threadId && activeView === 'chat'}
      destructiveDisabled={loading && thread.id === threadId}
      actionPending={forkThread.isPending || unarchiveThread.isPending}
      onOpen={() => { if (archived) void openArchivedThread(thread); else openLiveThread(thread); }}
      onRename={() => startRename(thread)}
      onArchive={() => setConfirmAction({ type: 'archive', thread })}
      onUnarchive={() => unarchiveThread.mutate({ path: { threadId: thread.id } })}
      onCompact={() => setConfirmAction({ type: 'compact', thread })}
      onFork={() => forkThread.mutate({ path: { threadId: thread.id } })}
    />
  );

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/30">
      {/* Global actions */}
      <div className="space-y-0.5 px-2 py-2">
        <button
          type="button"
          onClick={() => onViewChange('files')}
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
          onClick={() => onViewChange('terminal')}
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

      <ScrollArea className="min-h-0 flex-1 px-2 [&_[data-slot=scroll-area-viewport]>div]:!block">
        {sidebarView.type === 'overview' ? (
          <WorkspaceOverview
            archivedThreads={archivedThreads}
            workspaceGroups={workspaceGroups}
            collapsedGroups={collapsedGroups}
            isLoading={overviewThreadsQuery.isLoading || overviewArchivedQuery.isLoading}
            onToggleCollapse={toggleCollapse}
            onOpenArchivedDetail={openArchivedDetail}
            onOpenWorkspaceDetail={openWorkspaceDetail}
            onCreateInWorkspace={(cwd) => { createThread.mutate({ body: { cwd } }); onViewChange('chat'); }}
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
        onSelect={(cwd) => { createThread.mutate({ body: { cwd } }); onViewChange('chat'); }}
      />
    </aside>
  );
}
