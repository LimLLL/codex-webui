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
import { OPEN_FILE_EVENT, type OpenFileRequestDetail } from '@/lib/open-file-request';
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

  // Pending file open request from a message mention, image badge or agent
  // file reference. Uses { path, line, seq } so re-clicking the same file — or
  // the same file at the same line — still triggers a new open.
  const openSeqRef = useRef(0);
  const [pendingOpenFile, setPendingOpenFile] = useState<{
    path: string;
    line: number | null;
    seq: number;
    threadId: string;
  } | null>(null);

  // Listen for open-file requests raised by chat messages.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenFileRequestDetail>).detail;
      if (!detail?.path) return;
      // A request raised in another conversation must not open here. Opening is
      // asynchronous, so one raised just before a thread switch can still be in
      // flight; requests without an origin are legacy callers and are accepted.
      if (detail.sourceThreadId && detail.sourceThreadId !== threadId) return;
      setSessionPanelOpen(true);
      setPendingOpenFile({
        path: detail.path,
        line: detail.line ?? null,
        seq: ++openSeqRef.current,
        threadId,
      });
    };
    window.addEventListener(OPEN_FILE_EVENT, handler);
    return () => window.removeEventListener(OPEN_FILE_EVENT, handler);
  }, [threadId]);

  // An unfulfilled request is scoped to the conversation that raised it: it
  // names a file in that conversation's directory, so switching away discards
  // it. Discarded during render rather than merely filtered — filtering alone
  // would leave it dormant and let it fire again on returning to that
  // conversation, long after the click that raised it.
  if (pendingOpenFile && pendingOpenFile.threadId !== threadId) {
    setPendingOpenFile(null);
  }
  const activeOpenFile =
    pendingOpenFile?.threadId === threadId ? pendingOpenFile : null;

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

  // Counts accepted sends and steers. The transcript resumes following on the
  // change, so an explicit send is the only thing that can pull a reader who
  // scrolled away back to the latest output.
  const [sendSignal, setSendSignal] = useState(0);
  const handleSubmitted = useCallback(() => setSendSignal((n) => n + 1), []);

  const sessionPanelContent = showPanel ? (
    <SessionPanel
      threadId={threadId}
      cwd={threadCwd!}
      onClose={() => setSessionPanelOpen(false)}
      openFile={activeOpenFile?.path ?? null}
      openFileLine={activeOpenFile?.line ?? null}
      openFileSeq={activeOpenFile?.seq ?? -1}
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
              <ChatTimeline
                onEditMessage={(v) => chatInputRef.current?.setInput(v)}
                scrollToLatestSignal={sendSignal}
              />
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
          scrollToLatestSignal={sendSignal}
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
        onSubmitted={handleSubmitted}
      />
    </div>
  );
}
