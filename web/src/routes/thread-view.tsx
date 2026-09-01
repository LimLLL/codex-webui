/**
 * Thread route component — the single owner of opening a thread by URL param.
 * Selecting a thread no longer clears other live thread state.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChatTimeline } from '@/components/chat/chat-timeline';
import { ChatInput, type ChatInputHandle } from '@/components/chat/chat-input';
import { SessionPanel } from '@/components/chat/session-panel';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from '@/components/ui/sheet';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import {
  applyReadOnlySnapshot,
  HISTORY_PAGE_SIZE,
  useOpenThread,
} from '@/hooks/use-thread-open';
import { useTimelineStore } from '@/stores/timeline-store';
import { showSnackbar } from '@/stores/snackbar-store';
import {
  threadsListTurnsOptions,
  threadsReadThreadOptions,
} from '@/generated/api/@tanstack/react-query.gen';

export function ThreadView() {
  const { threadId } = useParams({ strict: false }) as { threadId: string };
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);

  const threadCwd = useTimelineStore((s) => s.threadCwd);

  // Pending file open request from @mention click or image badge click.
  // Uses { path, seq } so re-clicking the same file still triggers a new open.
  const openSeqRef = useRef(0);
  const [pendingOpenFile, setPendingOpenFile] = useState<{ path: string; seq: number } | null>(null);

  // Listen for codex-webui:open-file events from chat message badges
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail?.path;
      if (!path) return;
      setSessionPanelOpen(true);
      setPendingOpenFile({ path, seq: ++openSeqRef.current });
    };
    window.addEventListener('codex-webui:open-file', handler);
    return () => window.removeEventListener('codex-webui:open-file', handler);
  }, []);

  const handleFileOpened = useCallback(() => {
    setPendingOpenFile(null);
  }, []);

  const openThread = useOpenThread();

  /** Fallback: read metadata plus the newest paged history as a snapshot. */
  const tryReadArchived = async (targetId: string) => {
    try {
      const [response, initialTurnsPage] = await Promise.all([
        queryClient.fetchQuery(
          threadsReadThreadOptions({ path: { threadId: targetId } }),
        ),
        queryClient.fetchQuery(
          threadsListTurnsOptions({
            path: { threadId: targetId },
            query: {
              limit: HISTORY_PAGE_SIZE,
              sortDirection: 'desc',
              itemsView: 'summary',
            },
          }),
        ),
      ]);
      // Guard: user may have navigated away during the fetch.
      if (useTimelineStore.getState().threadId !== targetId) return;
      applyReadOnlySnapshot(response, initialTurnsPage);
    } catch {
      if (useTimelineStore.getState().threadId !== targetId) return;
      showSnackbar(t('Thread not found or cannot be opened.'), 'error');
      void navigate({ to: '/' });
    }
  };

  // The route is the single owner of opening; every other surface navigates.
  // Selection and the loading decision live in the opener, which suppresses the
  // loading state when this client already holds the conversation hydrated.
  useEffect(() => {
    openThread.mutate(
      { path: { threadId } },
      {
        onError: () => {
          // Only fall back to an archived snapshot if this thread is still the
          // one on screen — the user may have navigated during the request.
          if (useTimelineStore.getState().threadId === threadId) {
            void tryReadArchived(threadId);
          }
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const breakpoint = useBreakpoint();
  const isDesktop = breakpoint === 'desktop';
  const showPanel = sessionPanelOpen && !!threadCwd;

  // The composer floats over the transcript so its glass surface has something
  // to show through, and so the transcript fades under it instead of being cut
  // off by an opaque band. It stays in flow once the session panel is open:
  // floating there would park it over the terminal, not over the transcript.
  const composerFloats = !(showPanel && isDesktop);
  const [composerHeight, setComposerHeight] = useState(0);

  const sessionPanelContent = showPanel ? (
    <SessionPanel
      threadId={threadId}
      cwd={threadCwd!}
      onClose={() => setSessionPanelOpen(false)}
      openFile={pendingOpenFile?.path ?? null}
      openFileSeq={pendingOpenFile?.seq ?? -1}
      onFileOpened={handleFileOpened}
    />
  ) : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {showPanel && isDesktop ? (
        /* Desktop: resizable vertical split */
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="65%" minSize="20%">
            <div className="flex h-full flex-col">
              <ChatTimeline onEditMessage={(v) => chatInputRef.current?.setInput(v)} />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="35%" minSize="15%">
            <div className="flex h-full flex-col">
              {sessionPanelContent}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <ChatTimeline
          onEditMessage={(v) => chatInputRef.current?.setInput(v)}
          bottomInset={composerFloats ? composerHeight : 0}
        />
      )}

      {/* Mobile/Tablet: session panel as bottom Sheet */}
      {!isDesktop && (
        <Sheet open={showPanel} onOpenChange={(open) => { if (!open) setSessionPanelOpen(false); }}>
          <SheetContent side="bottom" className="!h-[70dvh] p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">{t('Session panel')}</SheetTitle>
            <div className="flex h-full flex-col">
              {sessionPanelContent}
            </div>
          </SheetContent>
        </Sheet>
      )}

      <ChatInput
        ref={chatInputRef}
        panelOpen={sessionPanelOpen}
        onTogglePanel={() => setSessionPanelOpen((o) => !o)}
        className={composerFloats ? 'absolute inset-x-0 bottom-0' : 'shrink-0'}
        onHeightChange={setComposerHeight}
      />
    </div>
  );
}
