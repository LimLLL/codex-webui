/**
 * Turn-level unified diff viewer.
 * Shows the aggregated diff across all file changes in a turn,
 * rendered as a syntax-highlighted diff block.
 */
import { useState } from 'react';
import { ChevronDown, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface Props {
  diff: string;
}

export function DiffViewer({ diff }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const lines = diff.split('\n');
  const fileCount = lines.filter((l) => l.startsWith('diff --git')).length;
  const additions = lines.filter(
    (l) => l.startsWith('+') && !l.startsWith('+++'),
  ).length;
  const deletions = lines.filter(
    (l) => l.startsWith('-') && !l.startsWith('---'),
  ).length;

  return (
    <div className="mt-2 rounded-lg border border-border bg-muted/30 text-sm">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/30"
      >
        <GitBranch className="h-3.5 w-3.5 text-purple-400" />
        <span className="font-medium">
          {fileCount === 1 ? t('{{count}} file changed', { count: fileCount }) : t('{{count}} files changed', { count: fileCount })}
        </span>
        <span className="text-green-400">+{additions}</span>
        <span className="text-red-400">-{deletions}</span>
        <ChevronDown
          className={cn(
            'ml-auto h-3 w-3 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded && (
        <pre className="max-h-96 overflow-auto border-t border-border p-3 font-mono text-xs leading-relaxed">
          {lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'bg-green-500/10 text-green-400'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'bg-red-500/10 text-red-400'
                    : line.startsWith('@@')
                      ? 'text-blue-400'
                      : line.startsWith('diff --git')
                        ? 'mt-2 font-semibold text-foreground first:mt-0'
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
