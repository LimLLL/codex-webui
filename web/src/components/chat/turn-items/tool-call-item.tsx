import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnItem } from '@/types/timeline';

interface Props {
  item: TurnItem;
}

export function ToolCallItem({ item }: Props) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/30">
      <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium">
          {item.toolServer}/{item.toolName}
        </span>
        {!item.completed && <Loader2 className="h-3 w-3 animate-spin" />}
        {item.completed && <span className="text-green-500">{t('done')}</span>}
      </div>
      {item.toolArgs && (
        <pre className="m-0 border-b border-border/30 bg-muted/20 px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {item.toolArgs}
        </pre>
      )}
      {item.content && (
        <pre className="m-0 max-h-40 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {item.content}
        </pre>
      )}
    </div>
  );
}
