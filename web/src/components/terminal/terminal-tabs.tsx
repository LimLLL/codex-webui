/** Shared terminal tab strip controls for global and thread terminals. */
import { useState } from 'react';
import { Plus, Terminal as TerminalIcon, X } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { useTerminalStore } from '@/stores/terminal-store';
import { cn } from '@/lib/utils';
import type { TerminalMetadata } from '@/types/terminal';

interface Props {
  contextKey: string;
  cwd?: string;
  activeTerminalId: string | null;
  onSelectTerminal: (terminalId: string) => void;
  className?: string;
}

export function TerminalTabs({
  contextKey,
  cwd,
  activeTerminalId,
  onSelectTerminal,
  className,
}: Props) {
  const { t } = useTranslation();
  const [pendingClose, setPendingClose] = useState<TerminalMetadata | null>(null);
  const context = useTerminalStore((s) => s.contexts[contextKey]);
  const terminals = useTerminalStore((s) => s.terminals);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);

  const terminalIds = context?.terminalIds ?? [];

  const handleCreate = async () => {
    const terminal = await createTerminal(contextKey, cwd);
    if (terminal) onSelectTerminal(terminal.id);
  };

  const requestClose = (terminal: TerminalMetadata) => {
    if (terminal.attachedCount > 1) {
      setPendingClose(terminal);
      return;
    }
    void closeTerminal(contextKey, terminal.id);
  };

  return (
    <>
      <div className={cn('flex min-w-0 items-center gap-1', className)}>
        {terminalIds.map((terminalId) => {
          const terminal = terminals[terminalId];
          if (!terminal) return null;
          const active = terminalId === activeTerminalId;
          return (
            <div
              key={terminalId}
              className={cn(
                'group flex max-w-56 items-center border-b-2 text-xs transition-colors',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <button
                type="button"
                onClick={() => onSelectTerminal(terminalId)}
                className="flex min-w-0 items-center gap-1.5 px-2 py-1.5"
                title={`${terminal.cwd} · ${terminal.shell}`}
              >
                <TerminalIcon className="h-3 w-3 shrink-0" />
                <span className="truncate">{terminal.title}</span>
                {terminal.status === 'exited' && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t('exit')} {terminal.exitCode ?? '?'}
                  </span>
                )}
                {terminal.status === 'expired' && (
                  <span className="shrink-0 text-[10px] text-destructive">
                    {t('expired')}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  requestClose(terminal);
                }}
                className="hover-reveal mr-1 rounded p-0.5 hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
                title={t('Close terminal')}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          );
        })}

        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => void handleCreate()}
          title={t('New terminal')}
        >
          <Plus />
        </Button>
      </div>

      <AlertDialog open={pendingClose !== null} onOpenChange={(open) => !open && setPendingClose(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Close shared terminal?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'This terminal is attached in {{count}} clients. Closing it will kill the process for everyone.',
                { count: pendingClose?.attachedCount ?? 0 },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingClose) void closeTerminal(contextKey, pendingClose.id);
                setPendingClose(null);
              }}
            >
              {t('Close terminal')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
