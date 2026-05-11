/**
 * Renders the scrollable message timeline.
 */
import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTimelineStore } from '@/stores/timeline-store';
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

export function ChatTimeline() {
  const { t } = useTranslation();
  const timeline = useTimelineStore((s) => s.timeline);
  const threadId = useTimelineStore((s) => s.threadId);
  const loading = useTimelineStore((s) => s.loading);
  const bottomRef = useRef<HTMLDivElement>(null);

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
              return (
                <motion.div
                  key={i}
                  variants={entryVariants}
                  initial="hidden"
                  animate="visible"
                  className="mb-4 flex justify-end"
                >
                  <div className="max-w-2xl rounded-2xl bg-blue-600 px-4 py-3 text-white shadow-md [&_a]:text-blue-200 [&_a]:underline [&_code]:bg-white/15">
                    <MarkdownRenderer content={entry.content} completed={true} />
                  </div>
                </motion.div>
              );
            }

            if (entry.kind === 'system') {
              return (
                <motion.div
                  key={i}
                  variants={entryVariants}
                  initial="hidden"
                  animate="visible"
                  className="mb-4 text-center"
                >
                  <span className="inline-block rounded-lg bg-destructive/10 px-3 py-1.5 text-sm text-destructive">
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
    </ScrollArea>
  );
}
