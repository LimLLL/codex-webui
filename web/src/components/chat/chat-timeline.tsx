/**
 * Virtualized scrollable message timeline.
 * Uses TanStack Virtual for efficient rendering of long conversations.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bot, Loader2, Pencil } from 'lucide-react';
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
import { useTimelineStore } from '@/stores/timeline-store';
import type { TimelineEntry } from '@/types/timeline';
import { MessageVersionSwitcher } from './message-version-switcher';
import { TurnBlock } from './turn-block';
import { UserMessageBubble } from './user-message-bubble';

/** Returns true if the scroll container is near the bottom. */
function isNearBottom(el: HTMLElement, threshold = 120): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

interface Props {
  onEditMessage?: (message: string) => void;
}

export function ChatTimeline({ onEditMessage }: Props) {
  'use no memo'; // TanStack Virtual is incompatible with React Compiler memoization
  const { t } = useTranslation();
  const timeline = useTimelineStore((s) => s.timeline);
  const threadId = useTimelineStore((s) => s.threadId);
  const threadCwd = useTimelineStore((s) => s.threadCwd);
  const threadMode = useTimelineStore((s) => s.threadMode);
  const loading = useTimelineStore((s) => s.loading);
  const [editTarget, setEditTarget] = useState<{
    turnId: string;
    content: string;
  } | null>(null);

  const { versionsByTurnId } = useMessageVersions(threadId);
  const createBranch = useCreateMessageBranch((text) => {
    setEditTarget(null);
    if (text) onEditMessage?.(text);
  });

  // A turn cannot be branched while the conversation is busy, and the newest
  // user message has no turn id until `turn/started` arrives.
  const canBranch = threadMode === 'live' && !loading && !createBranch.isPending;

  // ── Virtualizer ─────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(timeline.length);
  const shouldAutoScroll = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual known limitation
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
  // Uses the same scroll container as the populated list: switching versions
  // passes through this state, and a gutter that appears and disappears with it
  // would shift the whole message column sideways.
  if (timeline.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto [scrollbar-gutter:stable]">
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
      {/* `scrollbar-gutter` keeps the gutter reserved: switching versions swaps
          the timeline through an empty state, and letting the scrollbar come and
          go with it visibly shifts every message sideways. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
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
    </>
  );
}

/** Renders a single timeline entry (user message, system message, or turn block). */
function TimelineEntryRow({
  entry,
  threadCwd,
  canBranch,
  versionsByTurnId,
  onEdit,
  t,
}: {
  entry: TimelineEntry;
  threadCwd: string | null;
  canBranch: boolean;
  versionsByTurnId: Map<string, MessageVersions>;
  onEdit: (target: { turnId: string; content: string }) => void;
  t: (key: string) => string;
}) {
  if (entry.kind === 'user') {
    const turnId = entry.turnId;
    const versions = turnId ? versionsByTurnId.get(turnId) : undefined;
    return (
      <div className="group/user flex flex-col items-end">
        <div
          className="max-w-2xl overflow-hidden rounded-2xl bg-blue-600 px-4 py-3 text-white [&_a]:text-blue-200 [&_a]:underline [&_blockquote]:text-white/70 [&_code]:bg-white/15 [&_del]:text-white/70"
          style={{
            boxShadow:
              '0 8px 24px rgba(59, 130, 246, 0.20), inset 0 1px 0 rgba(255, 255, 255, 0.18), inset 0 -1px 0 rgba(0, 0, 0, 0.12)',
          }}
        >
          <UserMessageBubble content={entry.content} threadCwd={threadCwd} images={entry.images} />
        </div>
        {/* Reserved even when empty so revealing the controls cannot shift layout. */}
        <div className="mt-1 flex h-6 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/user:opacity-100">
          {versions && <MessageVersionSwitcher versions={versions} />}
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

  return <TurnBlock entry={entry} />;
}
