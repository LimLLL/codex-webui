/** Desktop tabs and phone view chooser share descriptors and explicit activation. */
import { useState } from 'react';
import {
  FileCode,
  FolderTree,
  MessageSquare,
  TerminalSquare,
  X,
  ChevronDown,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import type { WorkspaceContext, WorkspaceTab } from '@/stores/workspace-store';
import { useTerminalStore } from '@/stores/terminal-store';
import { cn } from '@/lib/utils';

interface Props {
  workspace: WorkspaceContext;
  running: boolean;
  pending: number;
  onSelect: (id: string) => void;
  onClose: (tab: WorkspaceTab) => void;
  onExplorer: () => void;
  onNewTerminal: () => void;
}

/** Provides a pinned conversation destination without mounting another content tree on phones. */
export function WorkspaceControls({
  workspace,
  running,
  pending,
  onSelect,
  onClose,
  onExplorer,
  onNewTerminal,
}: Props) {
  const { t } = useTranslation();
  const desktop = useBreakpoint() === 'desktop';
  const terminals = useTerminalStore((s) => s.terminals);
  const [chooser, setChooser] = useState(false);
  const label = (tab: WorkspaceTab) =>
    tab.kind === 'file'
      ? (tab.path.split('/').pop() ?? tab.path)
      : (terminals[tab.terminalId]?.title ?? t('Terminal'));
  const selected = workspace.tabs.find((tab) => tab.id === workspace.activeId);
  const choose = (id: string) => {
    onSelect(id);
    setChooser(false);
  };
  const conversation = (
    <button
      type="button"
      role={desktop ? 'tab' : undefined}
      aria-selected={
        desktop ? workspace.activeId === 'conversation' : undefined
      }
      // Roving tabindex: a tablist is one stop, and the arrow-key handler moves
      // focus within it. Leaving this at its default made the pinned tab a
      // second stop whenever a file or terminal tab was the selected one.
      tabIndex={
        !desktop || workspace.activeId === 'conversation' ? 0 : -1
      }
      onClick={() => choose('conversation')}
      className={cn(
        'flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-xs',
        workspace.activeId === 'conversation'
          ? 'border-primary'
          : 'border-transparent',
      )}
    >
      <MessageSquare className="h-4 w-4" />
      <span className="hidden sm:inline">{t('Conversation')}</span>
      <span className="sr-only sm:hidden">{t('Conversation')}</span>
      {pending > 0 ? (
        <span
          aria-label={t('Pending decisions')}
          className="rounded bg-amber-500/20 px-1.5 text-amber-600"
        >
          {pending}
        </span>
      ) : (
        running && (
          <span
            aria-label={t('Running')}
            className="h-2 w-2 animate-pulse rounded-full bg-primary"
          />
        )
      )}
    </button>
  );

  return (
    <div className="flex h-10 min-w-0 shrink-0 items-center border-b bg-background">
      <div
        role={desktop ? 'tablist' : undefined}
        aria-label={t('Workspace views')}
        className="flex min-w-0 flex-1 items-center"
        onKeyDown={(event) => {
          if (
            !desktop ||
            !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
          )
            return;
          const tabs = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="tab"]',
            ),
          ];
          const current = tabs.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (current +
                    (event.key === 'ArrowRight' ? 1 : -1) +
                    tabs.length) %
                  tabs.length;
          event.preventDefault();
          tabs[index]?.focus();
        }}
      >
        {conversation}
        {desktop ? (
          <div className="flex min-w-0 flex-1 flex-nowrap overflow-x-auto">
            {workspace.tabs.map((tab) => (
              <div
                key={tab.id}
                className={cn(
                  'flex h-10 max-w-60 shrink-0 items-center border-b-2',
                  workspace.activeId === tab.id
                    ? 'border-primary'
                    : 'border-transparent',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={workspace.activeId === tab.id}
                  tabIndex={workspace.activeId === tab.id ? 0 : -1}
                  title={tab.kind === 'file' ? tab.path : label(tab)}
                  onClick={() => choose(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Delete') { event.preventDefault(); onClose(tab); }
                  }}
                  className="flex min-w-0 items-center gap-2 px-3 text-xs"
                >
                  {tab.kind === 'file' ? (
                    <FileCode className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="truncate">{label(tab)}</span>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => onClose(tab)}
                  aria-label={t(
                    tab.kind === 'terminal' ? 'Close terminal' : 'Close file',
                  )}
                  className="mr-1 rounded p-1 hover:bg-accent"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setChooser(true)}
            className="flex min-w-0 flex-1 items-center gap-1 px-2 text-xs"
            aria-label={t('Switch view')}
          >
            <span className="truncate">
              {selected ? label(selected) : t('Conversation')}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0" />
          </button>
        )}
      </div>
      <button
        type="button"
        className="h-10 shrink-0 px-3 hover:bg-accent"
        title={t('New terminal')}
        aria-label={t('New terminal')}
        onClick={onNewTerminal}
      >
        <TerminalSquare className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="h-10 shrink-0 px-3 hover:bg-accent"
        title={t('Explorer')}
        aria-label={t('Explorer')}
        onClick={onExplorer}
      >
        <FolderTree className="h-4 w-4" />
      </button>
      {!desktop && (
        <Sheet open={chooser} onOpenChange={setChooser}>
          <SheetContent
            side="bottom"
            className="max-h-[calc(var(--app-vh)*0.7)] overflow-y-auto"
          >
            <SheetTitle>{t('Workspace views')}</SheetTitle>
            <button
              type="button"
              className="w-full px-3 py-3 text-left"
              onClick={() => choose('conversation')}
            >
              {t('Conversation')}
            </button>
            {workspace.tabs.map((tab) => (
              <div key={tab.id} className="flex min-w-0 items-center">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate px-3 py-3 text-left"
                  onClick={() => choose(tab.id)}
                >
                  {label(tab)}
                </button>
                <button
                  type="button"
                  className="p-3"
                  aria-label={t(
                    tab.kind === 'terminal' ? 'Close terminal' : 'Close file',
                  )}
                  onClick={() => onClose(tab)}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
