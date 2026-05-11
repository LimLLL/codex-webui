import { ChevronDown, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useTimelineStore } from '@/stores/timeline-store';
import type { TurnItem } from '@/types/timeline';

interface Props {
  item: TurnItem;
}

export function ReasoningItem({ item }: Props) {
  const { t } = useTranslation();
  const expanded = useTimelineStore((s) => s.expandedReasoning.has(item.itemId));
  const toggleReasoning = useTimelineStore((s) => s.toggleReasoning);

  if (!item.content) return null;

  return (
    <div
      className="cursor-pointer select-none"
      onClick={() => toggleReasoning(item.itemId)}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ChevronDown
          className={`h-3 w-3 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`}
        />
        <span>{t('Thinking')}</span>
        {!expanded && item.completed && (
          <span className="opacity-50">{t('(click to expand)')}</span>
        )}
        {!item.completed && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      {expanded && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="mt-1 overflow-hidden rounded-lg border border-border/50 bg-muted/30 px-3 py-2"
        >
          <pre className="m-0 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground wrap-break-word">
            {item.content}
          </pre>
        </motion.div>
      )}
    </div>
  );
}
