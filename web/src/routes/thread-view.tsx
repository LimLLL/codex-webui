/**
 * Thread route component — resumes/reads a thread by URL param.
 * Selecting a thread no longer clears other live thread state.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChatTimeline } from '@/components/chat/chat-timeline';
import { ChatInput, type ChatInputHandle } from '@/components/chat/chat-input';
import { SessionPanel } from '@/components/chat/session-panel';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { useTimelineStore } from '@/stores/timeline-store';
import { showSnackbar } from '@/stores/snackbar-store';
import {
  threadsResumeThreadMutation,
  threadsReadThreadOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import { tokenUsageReadThreadTokenUsage, turnDiffReadThreadTurnDiffs } from '@/generated/api/sdk.gen';

/** Extracts a display label from a thread DTO. */
function threadLabel(thread: { name?: string | null; preview?: string | null }): string {
  return thread.name ?? thread.preview ?? '';
}

export function ThreadView() {
  const { threadId } = useParams({ strict: false }) as { threadId: string };
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const chatInputRef = useRef<ChatInputHandle>(null);
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);

  const threadCwd = useTimelineStore((s) => s.threadCwd);
  const setActiveThread = useTimelineStore((s) => s.setActiveThread);
  const setReadOnlyThread = useTimelineStore((s) => s.setReadOnlyThread);
  const hydrateTimelineForThread = useTimelineStore((s) => s.hydrateTimelineForThread);
  const hydrateTokenUsageForThread = useTimelineStore((s) => s.hydrateTokenUsageForThread);
  const hydrateTurnDiffsForThread = useTimelineStore((s) => s.hydrateTurnDiffsForThread);
  const setThreadTitleForThread = useTimelineStore((s) => s.setThreadTitleForThread);
  const setThreadStatusForThread = useTimelineStore((s) => s.setThreadStatusForThread);
  const setActiveTurnIdForThread = useTimelineStore((s) => s.setActiveTurnIdForThread);
  const setLoadingForThread = useTimelineStore((s) => s.setLoadingForThread);

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

  const resumeThread = useMutation({
    ...threadsResumeThreadMutation(),
    onSuccess: (res) => {
      const tid = res.thread.id;
      const title = threadLabel(res.thread);
      setThreadTitleForThread(tid, title);
      hydrateTimelineForThread(tid, res.thread.turns, res.cwd);
      // Restore active turn state so sidebar shows loading and input stays in steer mode.
      setThreadStatusForThread(tid, res.thread.status);
      const activeTurn = res.thread.turns.find((t) => t.status === 'inProgress');
      if (activeTurn) {
        setActiveTurnIdForThread(tid, activeTurn.id);
        setLoadingForThread(tid, true);
      } else {
        setLoadingForThread(tid, false);
      }
      void tokenUsageReadThreadTokenUsage({ path: { threadId: tid } })
        .then(({ data }) => data && hydrateTokenUsageForThread(tid, data.turns))
        .catch(() => undefined);
      void turnDiffReadThreadTurnDiffs({ path: { threadId: tid } })
        .then(({ data }) => data && hydrateTurnDiffsForThread(tid, data.turns))
        .catch(() => undefined);
    },
    onError: (_err, vars) => {
      const failedId = vars.path.threadId;
      setLoadingForThread(failedId, false);
      // Only attempt archived read if this thread is still selected.
      if (useTimelineStore.getState().threadId === failedId) {
        void tryReadArchived(failedId);
      }
    },
  });

  /** Fallback: try to read the thread as an archived snapshot. */
  const tryReadArchived = async (targetId: string) => {
    try {
      const res = await queryClient.fetchQuery(
        threadsReadThreadOptions({
          path: { threadId: targetId },
          query: { includeTurns: true },
        }),
      );
      // Guard: user may have navigated away during the fetch.
      if (useTimelineStore.getState().threadId !== targetId) return;
      setReadOnlyThread(res.thread);
      void tokenUsageReadThreadTokenUsage({ path: { threadId: targetId } })
        .then(({ data }) => data && hydrateTokenUsageForThread(targetId, data.turns))
        .catch(() => undefined);
      void turnDiffReadThreadTurnDiffs({ path: { threadId: targetId } })
        .then(({ data }) => data && hydrateTurnDiffsForThread(targetId, data.turns))
        .catch(() => undefined);
    } catch {
      if (useTimelineStore.getState().threadId !== targetId) return;
      showSnackbar(t('Thread not found or cannot be opened.'), 'error');
      void navigate({ to: '/' });
    }
  };

  // Load or select thread when URL param changes. Backend ensures resume is deduped.
  useEffect(() => {
    setActiveThread(threadId);
    setLoadingForThread(threadId, true);
    resumeThread.mutate({ path: { threadId } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const showPanel = sessionPanelOpen && !!threadCwd;

  return (
    <>
      {showPanel ? (
        <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="65%" minSize="20%">
            <div className="flex h-full flex-col">
              <ChatTimeline onEditMessage={(v) => chatInputRef.current?.setInput(v)} />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="35%" minSize="15%">
            <div className="flex h-full flex-col">
              <SessionPanel
                threadId={threadId}
                cwd={threadCwd!}
                onClose={() => setSessionPanelOpen(false)}
                openFile={pendingOpenFile?.path ?? null}
                openFileSeq={pendingOpenFile?.seq ?? -1}
                onFileOpened={handleFileOpened}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <ChatTimeline onEditMessage={(v) => chatInputRef.current?.setInput(v)} />
      )}

      <ChatInput
        ref={chatInputRef}
        panelOpen={sessionPanelOpen}
        onTogglePanel={() => setSessionPanelOpen((o) => !o)}
      />
    </>
  );
}
