/**
 * Renders a command execution item showing the command and its output.
 * Long commands are collapsible — never truncated for safety.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnItem } from '@/types/timeline';
import { cn } from '@/lib/utils';

interface Props {
  item: TurnItem;
}

/** Threshold (in chars) above which the command is collapsed by default. */
const COLLAPSE_THRESHOLD = 200;

export function CommandItem({ item }: Props) {
  const { t } = useTranslation();
  const fullCommand = item.command ? stripShellWrapper(item.command) : undefined;
  const isLong = (fullCommand?.length ?? 0) > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);

  /** First logical line for the collapsed preview. */
  const previewLine = fullCommand?.split('\n')[0] ?? '';

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/40 font-mono">
      <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
        <Terminal className="h-3 w-3" />
        <span>{t('Terminal')}</span>
        {item.exitCode !== undefined && item.completed && (
          <span
            className={cn(
              'ml-auto',
              item.exitCode === 0 ? 'text-green-400' : 'text-red-400',
            )}
          >
            {t('exit')} {item.exitCode}
          </span>
        )}
        {!item.completed && (
          <Loader2 className="ml-auto h-3 w-3 animate-spin" />
        )}
      </div>

      {fullCommand && (
        <div className="border-b border-border/30 bg-muted/60 px-3 py-1.5 text-xs text-foreground/80">
          {isLong ? (
            <button
              type="button"
              className="flex w-full items-start gap-1 text-left"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="mr-1.5 text-green-400">$</span>
                {expanded ? (
                  <span className="whitespace-pre-wrap break-all">
                    {fullCommand}
                  </span>
                ) : (
                  <span className="break-all">
                    {previewLine}
                    <span className="ml-1 text-muted-foreground">...</span>
                  </span>
                )}
              </span>
            </button>
          ) : (
            <>
              <span className="mr-1.5 text-green-400">$</span>
              {fullCommand}
            </>
          )}
        </div>
      )}

      {item.content && (
        <pre className="m-0 max-h-64 overflow-auto p-3 text-xs leading-relaxed text-muted-foreground">
          {item.content}
        </pre>
      )}
    </div>
  );
}

/**
 * Strips the shell invocation wrapper added by Codex.
 * e.g. `/bin/zsh -lc "mkdir -p .claude && ..."` → `mkdir -p .claude && ...`
 * Never truncates — returns the full inner command.
 */
function stripShellWrapper(cmd: string): string {
  const match = cmd.match(/^\/bin\/(?:zsh|bash)\s+-\w+\s+"([\s\S]+)"$/);
  return match ? match[1] : cmd;
}
