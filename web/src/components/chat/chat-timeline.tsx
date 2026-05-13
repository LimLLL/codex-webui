/**
 * Renders the scrollable message timeline.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  threadsListThreadsQueryKey,
  threadsRollbackThreadMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { tokenUsageReadThreadTokenUsage } from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import type { TimelineEntry } from '@/types/timeline';
import { TurnBlock } from './turn-block';
import { MarkdownRenderer } from './markdown-renderer';

const entryVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 400, damping: 30 },
  },
};

/** Counts how many turns need to be rolled back when editing this user message. */
function computeRollbackTurns(timeline: TimelineEntry[], userIndex: number): number {
  const turnEntries = timeline
    .slice(userIndex)
    .filter((e): e is Extract<TimelineEntry, { kind: 'turn' }> => e.kind === 'turn');
  return turnEntries.length;
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const [rollbackTarget, setRollbackTarget] = useState<{
    numTurns: number;
    content: string;
  } | null>(null);
  const queryClient = useQueryClient();

  const rollbackThread = useMutation({
    ...threadsRollbackThreadMutation(),
    onSuccess: (res) => {
      const content = rollbackTarget?.content;
      hydrateTimeline(res.thread.turns, res.thread.cwd);
      void tokenUsageReadThreadTokenUsage({ path: { threadId: res.thread.id } })
        .then(({ data }) => data && hydrateTokenUsage(data.turns))
        .catch(() => undefined);
      setRollbackTarget(null);
      void queryClient.invalidateQueries({ queryKey: threadsListThreadsQueryKey() });
      if (content) onEditMessage?.(content);
    },
  });

  const canRollback = threadMode === 'live' && !loading && !rollbackThread.isPending;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [timeline]);

  return (
    <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
      <div className="px-4 py-6 md:px-6">
        {timeline.length === 0 && loading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center py-24 text-muted-foreground"
          >
            <Loader2 className="mb-3 h-8 w-8 animate-spin opacity-40" />
            <p className="text-sm">{t('Loading...')}</p>
          </motion.div>
        )}

        {timeline.length === 0 && !loading && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-24 text-muted-foreground"
          >
            <Bot className="mb-4 h-12 w-12 opacity-30" />
            <p className="text-sm">
              {threadId
                ? t('Send a message to start the conversation.')
                : t('Create a new thread to begin.')}
            </p>
          </motion.div>
        )}

        <AnimatePresence initial={false}>
          {timeline.map((entry, i) => {
            if (entry.kind === 'user') {
              const numTurns = computeRollbackTurns(timeline, i);
              return (
                <motion.div
                  key={i}
                  variants={entryVariants}
                  initial="hidden"
                  animate="visible"
                  className="group/user mb-4 flex flex-col items-end"
                >
                  <div className="max-w-2xl rounded-2xl bg-blue-600 px-4 py-3 text-white shadow-md [&_a]:text-blue-200 [&_a]:underline [&_code]:bg-white/15">
                    <MarkdownRenderer content={entry.content} completed={true} />
                  </div>
                  {canRollback && numTurns > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={t('Edit this message')}
                          className="mt-1 flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover/user:opacity-100"
                          onClick={() => setRollbackTarget({ numTurns, content: entry.content })}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {t('Edit this message')}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </motion.div>
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
                <motion.div
                  key={i}
                  variants={entryVariants}
                  initial="hidden"
                  animate="visible"
                  className="mb-4 text-center"
                >
                  <span className={`inline-block rounded-lg px-3 py-1.5 text-sm ${colorMap[severity]}`}>
                    {entry.content}
                  </span>
                </motion.div>
              );
            }

            return <TurnBlock key={entry.turnId} entry={entry} />;
          })}
        </AnimatePresence>

        <div ref={bottomRef} />
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
    </ScrollArea>
  );
}
