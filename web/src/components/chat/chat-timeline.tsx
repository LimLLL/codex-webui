/**
 * Virtualized scrollable message timeline.
 * Uses TanStack Virtual for efficient rendering of long conversations.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Bot, Loader2, Lock } from 'lucide-react';
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
  useCreateMessageBranch,
  useMessageVersions,
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
import {
  AT_END_THRESHOLD_PX,
  useTranscriptFollow,
} from '@/hooks/use-transcript-follow';
import { DeleteConversationDialog } from '@/components/branches/delete-conversation-dialog';
import { getApiErrorMessage } from '@/lib/api-error';
import { shouldPrefetchOlder } from '@/lib/history-prefetch';
import { useTimelineStore } from '@/stores/timeline-store';
import type { TimelineEntry } from '@/types/timeline';
import { TimelineEntryRow } from './timeline-entry-row';

/** Stable empty set, so "nothing is being deleted" is referentially constant. */
const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Leading space reserved for the "load earlier" control, in px.
 *
 * A constant rather than the control's measured height, and reserved whether or
 * not the control is showing. `paddingStart` shifts every row's computed start,
 * but changing it is not one of the changes the virtualizer restores scroll
 * position across — that restoration is keyed to the item count and the edge
 * item keys. So a padding change moves the content under the reader by its own
 * delta: once when the control is first measured, and again when exhausting the
 * cursor removes it. Reserving a fixed amount forever costs a strip of leading
 * whitespace and removes the shift entirely.
 */
const HISTORY_HEADER_PX = 48;

/** Joins entry keys into a comparable signature; cannot occur inside a key. */
const KEY_SEPARATOR = '\u0000';

/**
 * Derives a stable virtualizer key for every timeline entry.
 *
 * Index keys cannot survive `Load earlier messages`: prepending shifts every
 * existing entry by the page size, so cached row heights — and the end anchor
 * the virtualizer restores position from — would be attributed to the wrong
 * entries. Turn ids are the natural identity, but a user message has none until
 * `turn/started` arrives, and several system messages can share one turn. Both
 * are disambiguated by their ordinal within their own group, which prepending
 * cannot disturb: prepended history is always persisted turns, so it never
 * lands in the group an as-yet unidentified live entry is counted in.
 */
function deriveEntryKeys(timeline: TimelineEntry[]): string[] {
  const counts = new Map<string, number>();
  return timeline.map((entry) => {
    const turnId = 'turnId' in entry ? entry.turnId : undefined;
    const group = `${entry.kind}:${turnId ?? 'pending'}`;
    const ordinal = counts.get(group) ?? 0;
    counts.set(group, ordinal + 1);
    return `${group}:${ordinal}`;
  });
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
  /**
   * Increments when the composer dispatches a send or steer. Following resumes
   * on the change, not on the value, so the route only has to count sends.
   */
  scrollToLatestSignal?: number;
}

export function ChatTimeline({
  onEditMessage,
  bottomInset = 0,
  scrollToLatestSignal = 0,
}: Props) {
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

  // Derived through its own joined form so the array keeps its identity across
  // renders that did not change the key sequence — which is most of them, since
  // a streaming delta replaces one entry without renaming anything. The
  // extractor is part of the virtualizer's measurement options, and a fresh one
  // rebuilds every measurement; it also cannot be made mutably stable, because
  // the library compares the previous options' extractor against the new one to
  // detect that the first or last entry changed.
  const keySignature = useMemo(
    () => deriveEntryKeys(timeline).join(KEY_SEPARATOR),
    [timeline],
  );
  const entryKeys = useMemo(
    () => (keySignature === '' ? [] : keySignature.split(KEY_SEPARATOR)),
    [keySignature],
  );
  const getItemKey = useCallback(
    (index: number) => entryKeys[index] ?? index,
    [entryKeys],
  );

  const showHistoryHeader = historyCursor !== null;

  // `anchorTo: 'end'` makes the tail the edge the virtualizer preserves: it
  // holds the reader's position when older history prepends, and it declines to
  // shift the viewport when the streaming turn grows *below* the fold rather
  // than above it. It also holds the end itself as the last row grows, which is
  // what following a stream actually consists of.
  //
  // `followOnAppend` is deliberately left off. Its implementation follows
  // through `scrollToIndex`, which installs a target the library re-derives
  // every frame for up to five seconds and re-applies whenever it moves — and
  // during streaming it moves constantly, so a reader who scrolls up inside
  // that window is dragged back down. Appends are followed in
  // `useTranscriptFollow` with a fixed-offset write instead.
  //
  // `paddingEnd` grows the scrollable range so the last entry can clear the
  // floating composer; `scrollPaddingEnd` keeps auto-scroll from parking that
  // entry underneath it. Both are needed — the first alone lets the list scroll
  // far enough, the second decides where "scrolled to the end" stops.
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual known limitation
  const virtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 80,
    overscan: 5,
    anchorTo: 'end',
    scrollEndThreshold: AT_END_THRESHOLD_PX,
    paddingStart: HISTORY_HEADER_PX,
    paddingEnd: bottomInset,
    scrollPaddingEnd: bottomInset,
  });

  const { atEnd, handleScroll, returnToLatest } =
    useTranscriptFollow({
      virtualizer,
      scrollRef,
      timeline,
      threadId,
      bottomInset,
      scrollToLatestSignal,
    });

  // Older history loads on approach instead of only on demand. It was a manual
  // control because prepending into a virtualized list with estimated row
  // heights moved the content being read; end anchoring plus stable item keys
  // is exactly what removes that, so the reason no longer holds.
  //
  // The control stays: it is the affordance when the transcript is too short to
  // scroll, and it is where the in-flight state is shown. `loadOlderHistory`
  // reads the store and claims the loading flag synchronously, so the repeated
  // calls a scroll burst produces collapse into one request.
  // Keyed by conversation: the first scroll event after a switch has no
  // meaningful predecessor, and comparing against the previous conversation's
  // offset could read as an upward move and fetch a page nobody asked for.
  const lastScrollRef = useRef({ threadId, scrollTop: 0 });
  const handleTranscriptScroll = useCallback(() => {
    handleScroll();
    const el = scrollRef.current;
    if (!el) return;
    const last = lastScrollRef.current;
    const previousScrollTop =
      last.threadId === threadId ? last.scrollTop : el.scrollTop;
    lastScrollRef.current = { threadId, scrollTop: el.scrollTop };
    if (
      shouldPrefetchOlder({
        scrollTop: el.scrollTop,
        previousScrollTop,
        hasCursor: historyCursor !== null,
        loading: historyLoading,
      })
    ) {
      void loadOlderHistory();
    }
  }, [handleScroll, historyCursor, historyLoading, loadOlderHistory, threadId]);

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
      {/* Positions the return control against the viewport rather than the
          scrolling content, so offering it never changes the scroll height. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* `scrollbar-gutter` keeps the gutter reserved: switching versions
            swaps the timeline through an empty state, and letting the scrollbar
            come and go with it visibly shifts every message sideways. */}
        <div
          ref={scrollRef}
          onScroll={handleTranscriptScroll}
          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          <div
            className="relative px-3 sm:px-4 lg:px-6"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {/* Older pages load on approach; this control is what makes the
                fetch reachable when the transcript is too short to scroll, and
                where the in-flight state is shown.

                Positioned inside the leading space the virtualizer reserves for
                it, so the scroller holds nothing the virtualizer has not
                measured — otherwise `scrollHeight` and `getTotalSize()` would
                differ by its height, and the end-distance the return control
                reads would disagree with the one the library follows by. Its
                height must stay within `HISTORY_HEADER_PX`, so the label is
                kept on one line. */}
            {showHistoryHeader && (
              <div
                className="absolute left-0 top-0 flex w-full items-center justify-center px-3 sm:px-4 lg:px-6"
                style={{ height: HISTORY_HEADER_PX }}
              >
                <button
                  type="button"
                  disabled={historyLoading}
                  onClick={() => void loadOlderHistory()}
                  className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-60"
                >
                  {historyLoading && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                  {historyLoading
                    ? t('Loading earlier messages…')
                    : t('Load earlier messages')}
                </button>
              </div>
            )}
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
                      threadId={threadId}
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

        {/* Offered whenever the transcript is away from the end, whether or not
            anything new arrived. Deliberately one state, not two: telling
            "output landed" apart from "the reader expanded an older turn in
            place" needs live-vs-hydration provenance the timeline does not
            carry, and returning to the latest message is the affordance either
            way. The row is click-through so it cannot swallow taps on the
            transcript beside the button. */}
        {!atEnd && (
          <div
            className="pointer-events-none absolute inset-x-0 z-20 flex justify-end px-3 sm:px-4 lg:px-6"
            style={{ bottom: bottomInset + 12 }}
          >
            <button
              type="button"
              onClick={returnToLatest}
              aria-label={t('Jump to latest')}
              className="pointer-events-auto flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              {t('Jump to latest')}
            </button>
          </div>
        )}
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
