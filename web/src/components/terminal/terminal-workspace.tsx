/** Multi-tab terminal workspace for global and thread contexts. */
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { TerminalSurface } from '@/components/terminal/terminal-host';
import { TerminalStatusBar } from '@/components/terminal/terminal-status-bar';
import { TerminalTabs } from '@/components/terminal/terminal-tabs';
import { useTerminalStore } from '@/stores/terminal-store';
import { cn } from '@/lib/utils';
import { useTerminalDiscovery } from '@/hooks/use-terminal-discovery';

interface Props {
  contextKey: string;
  cwd?: string;
  className?: string;
}

export function TerminalWorkspace({ contextKey, cwd, className }: Props) {
  const { t } = useTranslation();
  const context = useTerminalStore((s) => s.contexts[contextKey]);
  useTerminalDiscovery(contextKey);
  const selectTerminal = useTerminalStore((s) => s.selectTerminal);

  const terminalIds = useMemo(() => context?.terminalIds ?? [], [context?.terminalIds]);
  const activeTerminalId = context?.activeTerminalId ?? null;

  // Discovery must not move an existing selection, but this surface *is* the
  // terminal: with nothing selected at all there is no intent to preserve, and
  // landing on "Select a terminal" would be the standalone route's whole content.
  // Conversation tabs never reach here — they render `TerminalSurface` directly.
  useEffect(() => {
    if (!activeTerminalId && terminalIds[0])
      selectTerminal(contextKey, terminalIds[0]);
  }, [activeTerminalId, contextKey, selectTerminal, terminalIds]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-background', className)}>
      <div className="flex shrink-0 items-center border-b border-border bg-muted/20">
        <TerminalTabs
          contextKey={contextKey}
          cwd={cwd}
          activeTerminalId={activeTerminalId}
          onSelectTerminal={(terminalId) => selectTerminal(contextKey, terminalId)}
          className="min-w-0 flex-1"
        />
      </div>

      <div className="relative min-h-0 flex-1">
        {terminalIds.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('No terminals')}
          </div>
        )}
        {terminalIds.length > 0 && !activeTerminalId && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('Select a terminal')}</div>
        )}
        {activeTerminalId && <TerminalSurface terminalId={activeTerminalId} contextKey={contextKey} />}
      </div>

      <TerminalStatusBar contextKey={contextKey} activeTerminalId={activeTerminalId} />
    </div>
  );
}
