/**
 * Virtualized scrollable message timeline.
 * Uses TanStack Virtual for efficient rendering of long conversations.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bot, Loader2, Pencil } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
  threadsListThreadsQueryKey,
  threadsRollbackThreadMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { tokenUsageReadThreadTokenUsage, turnDiffReadThreadTurnDiffs } from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import type { TimelineEntry } from '@/types/timeline';
import { TurnBlock } from './turn-block';
import { MarkdownRenderer } from './markdown-renderer';

/** Counts how many turns need to be rolled back when editing this user message. */
function computeRollbackTurns(timeline: TimelineEntry[], userIndex: number): number {
  const turnEntries = timeline
    .slice(userIndex)
    .filter((e): e is Extract<TimelineEntry, { kind: 'turn' }> => e.kind === 'turn');
  return turnEntries.length;
}

/** Returns true if the scroll container is near the bottom. */
function isNearBottom(el: HTMLElement, threshold = 120): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

interface Props {
  onEditMessage?: (message: string) => void;
}

export function ChatTimeline({ onEditMessage }: Props) {
  const { t } = useTranslation();
  const timeline = useTimelineStore((s) => s.timeline);
  const threadId = useTimelineStore((s) => s.threadId);
  const threadMode = useTimelineStore((s) => s.threadMode);
  const loading = useTimelineStore((s) => s.loading);
  const hydrateTimeline = useTimelineStore((s) => s.hydrateTimeline);
  const hydrateTokenUsage = useTimelineStore((s) => s.hydrateTokenUsage);
  const hydrateTurnDiffs = useTimelineStore((s) => s.hydrateTurnDiffs);
  const [rollbackTarget, setRollbackTarget] = useState<{
    numTurns: number;
    content: string;
  } | null>(null);
  const queryClient = useQueryClient();

  const rollbackThread = useMutation({
    ...threadsRollbackThreadMutation(),
    onSuccess: (res) => {
      const content = rollbackTarget?.content;
      const tid = res.thread.id;
      hydrateTimeline(res.thread.turns, res.thread.cwd);
      void tokenUsageReadThreadTokenUsage({ path: { threadId: tid } })
        .then(({ data }) => data && hydrateTokenUsage(data.turns))
        .catch(() => undefined);
      void turnDiffReadThreadTurnDiffs({ path: { threadId: tid } })
        .then(({ data }) => data && hydrateTurnDiffs(data.turns))
        .catch(() => undefined);
      setRollbackTarget(null);
      void queryClient.invalidateQueries({ queryKey: threadsListThreadsQueryKey() });
      if (content) onEditMessage?.(content);
    },
  });

  const canRollback = threadMode === 'live' && !loading && !rollbackThread.isPending;

  // ── Virtualizer ─────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(timeline.length);
  const shouldAutoScroll = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);

  const virtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 5,
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
  if (timeline.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
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
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div
          className="relative px-4 md:px-6"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          <div
            className="absolute left-0 top-0 w-full px-4 md:px-6"
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
                    index={virtualItem.index}
                    timeline={timeline}
                    canRollback={canRollback}
                    onRollback={setRollbackTarget}
                    t={t}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <AlertDialog open={rollbackTarget !== null} onOpenChange={(open) => !open && setRollbackTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Edit this message?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('This will remove this turn and all subsequent turns. File changes will NOT be reverted.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={rollbackThread.isPending}
              onClick={() => {
                if (!threadId || !rollbackTarget || rollbackTarget.numTurns < 1) return;
                rollbackThread.mutate({
                  path: { threadId },
                  body: { numTurns: rollbackTarget.numTurns },
                });
              }}
            >
              {t('Confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Renders a single timeline entry (user message, system message, or turn block). */
function TimelineEntryRow({
  entry,
  index,
  timeline,
  canRollback,
  onRollback,
  t,
}: {
  entry: TimelineEntry;
  index: number;
  timeline: TimelineEntry[];
  canRollback: boolean;
  onRollback: (target: { numTurns: number; content: string }) => void;
  t: (key: string) => string;
}) {
  if (entry.kind === 'user') {
    const numTurns = computeRollbackTurns(timeline, index);
    return (
      <div className="group/user flex flex-col items-end">
        <div
          className="max-w-2xl rounded-2xl bg-blue-600 px-4 py-3 text-white [&_a]:text-blue-200 [&_a]:underline [&_code]:bg-white/15"
          style={{
            boxShadow:
              '0 8px 24px rgba(59, 130, 246, 0.20), inset 0 1px 0 rgba(255, 255, 255, 0.18), inset 0 -1px 0 rgba(0, 0, 0, 0.12)',
          }}
        >
          <MarkdownRenderer content={entry.content} completed={true} />
        </div>
        {canRollback && numTurns > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('Edit this message')}
                className="mt-1 flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover/user:opacity-100"
                onClick={() => onRollback({ numTurns, content: entry.content })}
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

  return <TurnBlock entry={entry} />;
}
