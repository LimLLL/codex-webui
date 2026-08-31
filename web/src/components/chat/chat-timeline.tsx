/**
 * Virtualized scrollable message timeline.
 * Uses TanStack Virtual for efficient rendering of long conversations.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bot, Loader2, Lock, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useCreateMessageBranch,
  useMessageVersions,
  type MessageVersions,
} from '@/hooks/use-message-branches';
import {
  adoptionBlockReason,
  buildDeleteRequestBody,
  pickSurvivingVersion,
  useBranchAdoptionStatus,
  useDeletePreview,
  useDeleteThread,
} from '@/hooks/use-thread-deletion';
import { useLoadOlderHistory } from '@/hooks/use-thread-open';
import { DeleteConversationDialog } from '@/components/branches/delete-conversation-dialog';
import { getApiErrorMessage } from '@/lib/api-error';
import { useTimelineStore } from '@/stores/timeline-store';
import type { TimelineEntry } from '@/types/timeline';
import { MessageVersionSwitcher } from './message-version-switcher';
import { TurnBlock } from './turn-block';
import { UserMessageBubble } from './user-message-bubble';
import { TurnFailureCard } from './turn-failure-card';

/** Stable empty set, so "nothing is being deleted" is referentially constant. */
const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set<string>();

/** Returns true if the scroll container is near the bottom. */
function isNearBottom(el: HTMLElement, threshold = 120): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

/**
 * States that this conversation is held open for writing elsewhere.
 *
 * Only one process may hold a paginated conversation open for writing. Losing
 * that race leaves the history perfectly readable, so the conversation is shown
 * rather than refused — but silently showing a conversation that rejects every
 * message would read as the app being broken.
 */
function ReadOnlyBanner({ reason }: { reason: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 sm:px-4 lg:px-6 dark:text-amber-300">
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <p className="font-medium">
          {t('Read-only: this conversation is open in another client.')}
        </p>
        <p className="opacity-80">
          {reason ||
            t('Close it there, then reopen this conversation to continue it.')}
        </p>
      </div>
    </div>
  );
}

interface Props {
  onEditMessage?: (message: string) => void;
  /**
   * Space in px reserved at the end of the transcript for a composer floating
   * over it. Zero when the composer sits in flow below the timeline.
   */
  bottomInset?: number;
}

export function ChatTimeline({ onEditMessage, bottomInset = 0 }: Props) {
  'use no memo'; // TanStack Virtual is incompatible with React Compiler memoization
  const { t } = useTranslation();
  const timeline = useTimelineStore((s) => s.timeline);
  const threadId = useTimelineStore((s) => s.threadId);
  const threadCwd = useTimelineStore((s) => s.threadCwd);
  const threadMode = useTimelineStore((s) => s.threadMode);
  const loading = useTimelineStore((s) => s.loading);
  const historyCursor = useTimelineStore((s) => s.historyCursor);
  const historyLoading = useTimelineStore((s) => s.historyLoading);
  const readOnlyReason = useTimelineStore((s) => s.readOnlyReason);
  const deletedRemotely = useTimelineStore((s) => s.deletedRemotely);
  const loadOlderHistory = useLoadOlderHistory(threadId);
  const [editTarget, setEditTarget] = useState<{
    turnId: string;
    content: string;
  } | null>(null);

  const { versionsByTurnId } = useMessageVersions(threadId);
  const adoptionStatus = useBranchAdoptionStatus();
  const deleteBlockedReason = adoptionBlockReason(adoptionStatus.data, t);
  // The sibling ordering is captured when the dialog opens rather than looked
  // up on confirm: the group is about to change underneath us, and the whole
  // point is to land on the neighbour the switcher was showing at that moment.
  const [deleteTarget, setDeleteTarget] = useState<{
    threadId: string;
    siblingThreadIds: string[];
  } | null>(null);
  const deletePreview = useDeletePreview(deleteTarget?.threadId ?? null);
  const deleteVersion = useDeleteThread({
    onFinished: () => setDeleteTarget(null),
    resolveSurvivor: (doomed) =>
      deleteTarget
        ? pickSurvivingVersion(
            deleteTarget.threadId,
            deleteTarget.siblingThreadIds,
            doomed,
          )
        : null,
  });
  const createBranch = useCreateMessageBranch((text) => {
    setEditTarget(null);
    if (text) onEditMessage?.(text);
  });

  // The confirmed cascade, for as long as the request is in flight. Taken from
  // the mutation's own variables rather than tracked separately so it can never
  // disagree with what was actually sent. The dialog closes and the route moves
  // to the surviving sibling the moment the request is issued, so without this
  // the switcher on that sibling is the only thing on screen — and it was
  // showing the pre-delete count, fully interactive, for the whole round trip.
  const deletingThreadIds = useMemo<ReadonlySet<string>>(
    () =>
      deleteVersion.isPending
        ? new Set(deleteVersion.variables?.body?.expectedThreadIds ?? [])
        : EMPTY_THREAD_IDS,
    [deleteVersion.isPending, deleteVersion.variables],
  );

  // A turn cannot be branched while the conversation is busy, and the newest
  // user message has no turn id until `turn/started` arrives.
  const canBranch =
    threadMode === 'live' &&
    readOnlyReason === null &&
    !deletedRemotely &&
    !loading &&
    !createBranch.isPending;

  // ── Virtualizer ─────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(timeline.length);
  const shouldAutoScroll = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);

  // `paddingEnd` grows the scrollable range so the last entry can clear the
  // floating composer; `scrollPaddingEnd` keeps auto-scroll from parking that
  // entry underneath it. Both are needed — the first alone lets the list scroll
  // far enough, the second decides where "scrolled to the end" stops.
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual known limitation
  const virtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 5,
    paddingEnd: bottomInset,
    scrollPaddingEnd: bottomInset,
  });

  // Track whether user is near bottom for auto-scroll decisions
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      shouldAutoScroll.current = isNearBottom(el);
    }
  }, []);

  // Cleanup pending animation frames
  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    };
  }, []);

  // Keep bottom pinned during streaming (content changes) and new entries.
  // Smooth scroll for appended entries; instant jump for hydration (0→many).
  useEffect(() => {
    const previousCount = prevCountRef.current;
    const appended = timeline.length > previousCount;
    prevCountRef.current = timeline.length;

    if (timeline.length === 0 || !shouldAutoScroll.current) return;

    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);

    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      virtualizer.scrollToIndex(timeline.length - 1, {
        align: 'end',
        behavior: previousCount > 0 && appended ? 'smooth' : 'auto',
      });
    });
  }, [timeline, virtualizer]);

  // Scroll to bottom on initial load / thread switch
  useEffect(() => {
    if (timeline.length > 0) {
      shouldAutoScroll.current = true;
      virtualizer.scrollToIndex(timeline.length - 1, { align: 'end' });
    }
    // Only on threadId change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const virtualItems = virtualizer.getVirtualItems();

  // ── Empty states ────────────────────────────────────────────────────
  // Uses the same scroll container as the populated list: switching versions
  // passes through this state, and a gutter that appears and disappears with it
  // would shift the whole message column sideways.
  if (timeline.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto [scrollbar-gutter:stable]"
        style={{ paddingBottom: bottomInset }}
      >
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Loader2 className="mb-3 h-8 w-8 animate-spin opacity-40" />
            <p className="text-sm">{t('Loading...')}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
            <Bot className="mb-4 h-12 w-12 opacity-30" />
            <p className="text-sm">
              {threadId
                ? t('Send a message to start the conversation.')
                : t('Create a new thread to begin.')}
            </p>
          </div>
        )}
      </div>
    );
  }

  // ── Virtualized list ────────────────────────────────────────────────
  return (
    <>
      {readOnlyReason !== null && <ReadOnlyBanner reason={readOnlyReason} />}
      {/* `scrollbar-gutter` keeps the gutter reserved: switching versions swaps
          the timeline through an empty state, and letting the scrollbar come and
          go with it visibly shifts every message sideways. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
        {/* Deliberately a button rather than infinite scroll. Opening a
            conversation now fetches only its most recent page, so older turns
            are inserted *above* what is rendered — and prepending into a
            virtualized list with estimated row heights moves the content the
            user is reading. An explicit control keeps that motion something
            they asked for. */}
        {historyCursor !== null && (
          <div className="flex justify-center px-3 pt-3 sm:px-4 lg:px-6">
            <button
              type="button"
              disabled={historyLoading}
              onClick={() => void loadOlderHistory()}
              className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-60"
            >
              {historyLoading && <Loader2 className="h-3 w-3 animate-spin" />}
              {historyLoading
                ? t('Loading earlier messages…')
                : t('Load earlier messages')}
            </button>
          </div>
        )}
        <div
          className="relative px-3 sm:px-4 lg:px-6"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          <div
            className="absolute left-0 top-0 w-full px-3 sm:px-4 lg:px-6"
            style={{ transform: `translateY(${virtualItems[0]?.start ?? 0}px)` }}
          >
            {virtualItems.map((virtualItem) => {
              const entry = timeline[virtualItem.index];
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className="py-2"
                >
                  <TimelineEntryRow
                    entry={entry}
                    threadCwd={threadCwd}
                    canBranch={canBranch}
                    versionsByTurnId={versionsByTurnId}
                    deleteBlockedReason={deleteBlockedReason}
                    deletingThreadIds={deletingThreadIds}
                    onDeleteVersion={(threadId, siblingThreadIds) =>
                      setDeleteTarget({ threadId, siblingThreadIds })
                    }
                    onEdit={setEditTarget}
                    t={t}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <AlertDialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Edit this message?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('This creates a new version of the message. The current conversation is kept as a sibling version you can switch back to. File changes will NOT be reverted.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={createBranch.isPending}
              onClick={() => {
                if (!threadId || !editTarget) return;
                createBranch.mutate({
                  path: { threadId },
                  body: {
                    editedTurnId: editTarget.turnId,
                    previewText: editTarget.content,
                  },
                });
              }}
            >
              {t('Confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DeleteConversationDialog
        open={deleteTarget !== null}
        preview={deletePreview.data ?? null}
        loading={deletePreview.isLoading}
        errorMessage={
          deletePreview.error ? getApiErrorMessage(deletePreview.error) : null
        }
        pending={deleteVersion.isPending}
        currentThreadId={threadId}
        onConfirm={(preview) =>
          deleteVersion.mutate({
            path: { threadId: preview.targetThreadId },
            body: buildDeleteRequestBody(preview),
          })
        }
        onClose={() => setDeleteTarget(null)}
      />
    </>
  );
}

/** Renders a single timeline entry (user message, system message, or turn block). */
function TimelineEntryRow({
  entry,
  threadCwd,
  canBranch,
  versionsByTurnId,
  deleteBlockedReason,
  deletingThreadIds,
  onDeleteVersion,
  onEdit,
  t,
}: {
  entry: TimelineEntry;
  threadCwd: string | null;
  canBranch: boolean;
  versionsByTurnId: Map<string, MessageVersions>;
  deleteBlockedReason: string | null;
  deletingThreadIds: ReadonlySet<string>;
  onDeleteVersion: (threadId: string, siblingThreadIds: string[]) => void;
  onEdit: (target: { turnId: string; content: string }) => void;
  t: (key: string) => string;
}) {
  if (entry.kind === 'user') {
    const turnId = entry.turnId;
    const versions = turnId ? versionsByTurnId.get(turnId) : undefined;
    return (
      <div className="group/user flex flex-col items-end">
        {/* A neutral tint, not an accent colour: the user's own message is the
            one thing on screen they never need drawing to, and a saturated block
            was the only high-chroma surface in an otherwise neutral palette.
            Side and alignment already say who wrote it. */}
        <div className="max-w-2xl overflow-hidden rounded-2xl border border-border/60 bg-muted px-4 py-3 text-foreground [&_a]:underline">
          <UserMessageBubble content={entry.content} threadCwd={threadCwd} images={entry.images} />
        </div>
        {/* Reserved even when empty so revealing the controls cannot shift layout. */}
        <div className="mt-1 flex h-6 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/user:opacity-100">
          {versions && (
            <MessageVersionSwitcher
              versions={versions}
              deleteBlockedReason={deleteBlockedReason}
              deletingThreadIds={deletingThreadIds}
              onDeleteVersion={onDeleteVersion}
            />
          )}
          {/* Rendered whenever the message has a turn, disabled rather than
              removed — dropping it mid-switch would move the version switcher. */}
          {turnId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t('Edit this message')}
                  disabled={!canBranch}
                  className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  onClick={() => onEdit({ turnId, content: entry.content })}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('Edit this message')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    );
  }

  if (entry.kind === 'system') {
    const severity = entry.severity ?? 'error';
    const colorMap = {
      info: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
      warning: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
      error: 'bg-destructive/10 text-destructive',
    } as const;
    return (
      <div className="text-center">
        <span className={`inline-block rounded-lg px-3 py-1.5 text-sm ${colorMap[severity]}`}>
          {entry.content}
        </span>
      </div>
    );
  }

  if (entry.kind === 'turnFailure') {
    return <TurnFailureCard failure={entry.failure} />;
  }

  return <TurnBlock entry={entry} />;
}
