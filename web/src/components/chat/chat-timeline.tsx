/**
 * Renders the scrollable message timeline.
 */
import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTimelineStore } from '@/stores/timeline-store';
import { TurnBlock } from './turn-block';

const entryVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 400, damping: 30 },
  },
};

export function ChatTimeline() {
  const timeline = useTimelineStore((s) => s.timeline);
  const threadId = useTimelineStore((s) => s.threadId);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [timeline]);

  return (
    <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
      <div className="px-4 py-6 md:px-6">
        {timeline.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-24 text-muted-foreground"
          >
            <Bot className="mb-4 h-12 w-12 opacity-30" />
            <p className="text-sm">
              {threadId
                ? 'Send a message to start the conversation.'
                : 'Create a new thread to begin.'}
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
                  <div className="max-w-2xl rounded-2xl bg-blue-600 px-4 py-3 text-white shadow-md">
                    <pre className="m-0 whitespace-pre-wrap font-sans text-sm leading-relaxed wrap-break-word">
                      {entry.content}
                    </pre>
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
