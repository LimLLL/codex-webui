/**
 * Collapsible container for consecutive MCP tool calls.
 * When 2+ tool calls appear consecutively, they are grouped under a
 * single summary header that the user can expand/collapse.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnItem } from '@/types/timeline';
import { cn } from '@/lib/utils';

interface Props {
  items: TurnItem[];
  children: ReactNode;
}

export function ToolCallGroup({ items, children }: Props) {
  const { t } = useTranslation();
  const allCompleted = items.every((i) => i.completed);
  const [open, setOpen] = useState(!allCompleted);

  // Auto-collapse once all tool calls finish (only on the transition)
  const prevCompleted = useRef(allCompleted);
  useEffect(() => {
    if (allCompleted && !prevCompleted.current) {
      setOpen(false);
    }
    prevCompleted.current = allCompleted;
  }, [allCompleted]);

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/30">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
        <Wrench className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          {t('{{count}} tool calls', { count: items.length })}
        </span>
        {allCompleted ? (
          <span className="text-green-500">{t('done')}</span>
        ) : (
          <Loader2 className="h-3 w-3 animate-spin" />
        )}
      </button>
      {open && <div className="space-y-2 px-3 pb-2 pt-1">{children}</div>}
    </div>
  );
}
