/**
 * Renders a file change item showing the diff output from codex agent.
 */
import { FileCode, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnItem } from '@/types/timeline';
import { cn } from '@/lib/utils';

interface Props {
  item: TurnItem;
}

export function FileChangeItem({ item }: Props) {
  const { t } = useTranslation();
  const fileName = item.filePath?.split('/').pop() ?? t('File change');

  return (
    <div className="rounded-lg border border-border bg-muted/30 text-sm">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <FileCode className="h-3.5 w-3.5 text-orange-400" />
        <span className="font-mono text-xs text-muted-foreground">
          {item.filePath ?? fileName}
        </span>
        {!item.completed && (
          <Loader2 className="ml-auto h-3 w-3 animate-spin text-muted-foreground" />
        )}
        {item.completed && (
          <span className="ml-auto text-xs text-green-400">{t('Applied')}</span>
        )}
      </div>

      {item.content && (
        <pre
          className={cn(
            'max-h-64 overflow-auto p-3 font-mono text-xs leading-relaxed',
            'scrollbar-thin scrollbar-track-transparent scrollbar-thumb-muted-foreground/20',
          )}
        >
          {item.content.split('\n').map((line, i) => (
            <div
              key={i}
              className={cn(
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'text-green-400'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'text-red-400'
                    : line.startsWith('@@')
                      ? 'text-blue-400'
                      : 'text-muted-foreground',
              )}
            >
              {line}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
