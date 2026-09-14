/** Conversation workspace: one permanent transcript with sibling file and terminal views. */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ChatHeader } from '@/components/chat/chat-header';
import { useThemeStore } from '@/stores/theme-store';
import { ConversationFrame } from '@/components/chat/conversation-frame';
import { WorkspaceControls } from '@/components/chat/workspace-controls';
import { WorkspaceTree } from '@/components/chat/workspace-tree';
import { useWorkspaceClose } from '@/components/chat/workspace-close-dialog';
import { FileViewer } from '@/components/files/file-viewer';
import { TerminalSurface } from '@/components/terminal/terminal-host';
import { TerminalStatusBar } from '@/components/terminal/terminal-status-bar';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import {
  applyReadOnlySnapshot,
  HISTORY_PAGE_SIZE,
  useOpenThread,
} from '@/hooks/use-thread-open';
import {
  OPEN_FILE_EVENT,
  type OpenFileRequestDetail,
} from '@/lib/open-file-request';
import { SurfaceActivityContext } from '@/lib/surface-activity';
import { currentThreadEpoch } from '@/lib/thread-recovery-epoch';
import { getApiErrorMessage } from '@/lib/api-error';
import { useTimelineStore } from '@/stores/timeline-store';
import {
  useWorkspaceStore,
  EMPTY_WORKSPACE,
  fileViewId,
} from '@/stores/workspace-store';
import { useLayoutStore } from '@/stores/layout-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { useTerminalViewStore } from '@/stores/terminal-view-store';
import { useTerminalDiscovery } from '@/hooks/use-terminal-discovery';
import { threadsListTurns, threadsReadThread } from '@/generated/api/sdk.gen';

/** URL identity owns opening; tab identity controls only presentation and never subscription. */
export function ThreadView() {
  const { threadId } = useParams({ strict: false }) as { threadId: string };
  return <ConversationWorkspace key={threadId} threadId={threadId} />;
}

/** Keeps every surface at a fixed tree position throughout a conversation's tab switches. */
function ConversationWorkspace({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const context = `thread:${threadId}`;
  useTerminalDiscovery(context);
  const navigate = useNavigate();
  const dark = useThemeStore((s) => s.dark);
  const toggleDark = useThemeStore((s) => s.toggleDark);
  const workspace = useWorkspaceStore(
    (s) => s.contexts[context] ?? EMPTY_WORKSPACE,
  );
  const openFile = useWorkspaceStore((s) => s.openFile);
  const select = useWorkspaceStore((s) => s.select);
  const cwd = useTimelineStore((s) =>
    s.threadId === threadId ? s.threadCwd : s.threadsById[threadId]?.threadCwd,
  );
  const running = useTimelineStore(
    (s) =>
      s.threadId === threadId &&
      (s.turnStartPending ||
        Boolean(s.activeTurnId) ||
        s.threadStatus?.type === 'active'),
  );
  const pending = useTimelineStore((s) => {
    if (s.threadId !== threadId) return 0;
    const count =
      Object.values(s.approvals).filter((a) => a.status === 'pending').length +
      Object.values(s.userInputRequests).filter((a) => a.status === 'pending')
        .length;
    const flags =
      s.threadStatus?.type === 'active' ? s.threadStatus.activeFlags : [];
    return Math.max(
      count,
      flags.some(
        (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
      )
        ? 1
        : 0,
    );
  });
  const desktop = useBreakpoint() === 'desktop';
  const [mobileTree, setMobileTree] = useState(false);
  const [creatingTerminal, setCreatingTerminal] = useState(false);
  const { requestClose, dialog } = useWorkspaceClose(context);
  const { mutate: openThread } = useOpenThread();

  const open = useCallback(() => {
    openThread(
      { path: { threadId } },
      {
        onError: () => {
          if (useTimelineStore.getState().getThreadRuntime(threadId)?.hydrated)
            return;
          const epoch = currentThreadEpoch(threadId);
          // Archived/read-only fallback uses the same full-page display contract.
          void Promise.all([
            threadsReadThread({ path: { threadId }, throwOnError: true }),
            threadsListTurns({
              path: { threadId },
              query: {
                limit: HISTORY_PAGE_SIZE,
                sortDirection: 'desc',
                itemsView: 'full',
              },
              throwOnError: true,
            }),
          ])
            .then(([metadata, page]) => {
              if (
                epoch === currentThreadEpoch(threadId) &&
                useTimelineStore.getState().threadId === threadId
              )
                return applyReadOnlySnapshot(metadata.data, page.data);
            })
            .catch((error: unknown) => {
              if (epoch !== currentThreadEpoch(threadId)) return;
              useTimelineStore.getState().setOpenStateForThread(threadId, {
                openState: 'error',
                historyRequest: 'error',
                historyError: getApiErrorMessage(error),
              });
            });
        },
      },
    );
  }, [openThread, threadId]);

  useEffect(() => {
    open();
    return () => {
      useTimelineStore.getState().unsubscribeThread(threadId);
      const current = useWorkspaceStore.getState().contexts[context];
      const tab = current?.tabs.find((entry) => entry.id === current.activeId);
      if (tab?.kind === 'file')
        useWorkspaceStore
          .getState()
          .cancelReveal(fileViewId(context, tab.path));
    };
  }, [threadId, context, open]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OpenFileRequestDetail>).detail;
      if (
        !detail?.path ||
        (detail.sourceThreadId && detail.sourceThreadId !== threadId)
      )
        return;
      openFile(context, detail.path, detail.line);
    };
    window.addEventListener(OPEN_FILE_EVENT, handler);
    return () => window.removeEventListener(OPEN_FILE_EVENT, handler);
  }, [context, threadId, openFile]);

  const newTerminal = async () => {
    if (creatingTerminal) return;
    if (!cwd) return;
    setCreatingTerminal(true);
    const terminal = await useTerminalStore
      .getState()
      .createTerminal(context, cwd ?? undefined);
    setCreatingTerminal(false);
    if (!terminal) return;
    const runtime = useTimelineStore.getState().getThreadRuntime(threadId);
    if (!runtime || runtime.deletedRemotely) {
      useTerminalStore.getState().detachTerminal(terminal.id);
      return;
    }
    useTerminalViewStore.getState().retain(terminal.id, context);
    useWorkspaceStore.getState().openTerminal(context, terminal.id);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader
          dark={dark}
          onToggleDark={toggleDark}
          onToggleDiagnostics={() => void navigate({ to: '/diagnostics' })}
        />
        <WorkspaceControls
          key={desktop ? 'desktop' : 'mobile'}
          workspace={workspace}
          running={running}
          pending={pending}
          onSelect={(id) => select(context, id)}
          onClose={requestClose}
          onNewTerminal={() => void newTerminal()}
          terminalCreationDisabled={creatingTerminal || !cwd}
          onExplorer={() =>
            desktop
              ? useLayoutStore
                  .getState()
                  .setWorkspaceTreeCollapsed(
                    !useLayoutStore.getState().workspaceTreeCollapsed,
                  )
              : setMobileTree(true)
          }
        />
        <div
          className="relative min-h-0 flex-1"
          aria-label={t('Workspace content')}
        >
          <div
            role="tabpanel"
            aria-label={t('Conversation')}
            className="absolute inset-0"
            inert={workspace.activeId !== 'conversation'}
            style={{
              visibility:
                workspace.activeId === 'conversation' ? 'visible' : 'hidden',
            }}
          >
            <ConversationFrame
              threadId={threadId}
              active={workspace.activeId === 'conversation'}
              onRetry={open}
            />
          </div>
          {workspace.tabs.map((tab) => {
            const active = workspace.activeId === tab.id;
            return (
              <SurfaceActivityContext key={tab.id} value={active}>
                <div
                  role="tabpanel"
                  aria-label={tab.kind === 'file' ? tab.path : t('Terminal')}
                  className="absolute inset-0 flex min-h-0 flex-col"
                  inert={!active}
                  style={{ visibility: active ? 'visible' : 'hidden' }}
                >
                  {tab.kind === 'file' ? (
                    active && (
                      <FileViewer
                        filePath={tab.path}
                        viewId={fileViewId(context, tab.path)}
                        active={active}
                      />
                    )
                  ) : (
                    <>
                      <div className="min-h-0 flex-1">
                        <TerminalSurface
                          terminalId={tab.terminalId}
                          contextKey={context}
                          active={active}
                        />
                      </div>
                      <TerminalStatusBar
                        contextKey={context}
                        activeTerminalId={tab.terminalId}
                      />
                    </>
                  )}
                </div>
              </SurfaceActivityContext>
            );
          })}
        </div>
      </div>
      <WorkspaceTree
        cwd={cwd ?? null}
        desktop={desktop}
        mobileOpen={mobileTree}
        onMobileClose={() => setMobileTree(false)}
        onFile={(path) => openFile(context, path)}
      />
      {dialog}
    </div>
  );
}
