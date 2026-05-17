/** Single thread row with context menu popover. */
import {
  Archive,
  ArchiveRestore,
  GitFork,
  Loader2,
  MessageCircleQuestion,
  MessageSquare,
  Minimize2,
  MoreHorizontal,
  Pencil,
  ShieldAlert,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ThreadDto } from '@/generated/api';
import { cn } from '@/lib/utils';
import { threadLabel } from './sidebar-types';

interface Props {
  thread: ThreadDto;
  archived: boolean;
  isActive: boolean;
  destructiveDisabled: boolean;
  /** True when any mutation (fork/unarchive) is in-flight for this thread. */
  actionPending: boolean;
  /** True while this thread has an active turn (generating). */
  running?: boolean;
  /** True while this thread has at least one pending approval. */
  pendingApproval?: boolean;
  /** Number of hydrated pending approvals for this thread. */
  pendingApprovalCount?: number;
  /** True while this thread is blocked on user input. */
  waitingOnUserInput?: boolean;
  onOpen: () => void;
  onRename: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onCompact: () => void;
  onFork: () => void;
}

export function ThreadRow({
  thread,
  archived,
  isActive,
  destructiveDisabled,
  actionPending,
  running = false,
  pendingApproval = false,
  pendingApprovalCount = 0,
  waitingOnUserInput = false,
  onOpen,
  onRename,
  onArchive,
  onUnarchive,
  onCompact,
  onFork,
}: Props) {
  const { t } = useTranslation();

  // Status icon priority: approval > userInput > generating > idle
  const statusIcon = pendingApproval ? (
    <ShieldAlert className="h-3 w-3 shrink-0 animate-pulse text-yellow-500" />
  ) : waitingOnUserInput ? (
    <MessageCircleQuestion className="h-3 w-3 shrink-0 animate-pulse text-blue-500" />
  ) : running ? (
    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
  ) : (
    <MessageSquare className="h-3 w-3 shrink-0" />
  );

  // Badge text: show count only when > 1 (single approval already indicated by icon)
  const badgeText = pendingApprovalCount > 9 ? '9+' : String(pendingApprovalCount);

  return (
    <div className="group flex items-center gap-0.5 pl-3">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
          isActive
            ? 'bg-accent text-accent-foreground'
            : archived
              ? 'text-muted-foreground/60 hover:bg-accent/40 hover:text-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
      >
        {statusIcon}
        <span className="truncate">{threadLabel(thread)}</span>
        {pendingApprovalCount > 1 && (
          <span className="ml-auto rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-yellow-600 dark:text-yellow-400">
            {badgeText}
          </span>
        )}
      </button>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-44 p-1">
          <Button variant="ghost" className="h-7 w-full justify-start gap-2 px-2 text-xs" disabled={actionPending} onClick={onRename}>
            <Pencil className="h-3.5 w-3.5" />
            {t('Rename')}
          </Button>
          {archived ? (
            <Button variant="ghost" className="h-7 w-full justify-start gap-2 px-2 text-xs" disabled={actionPending} onClick={onUnarchive}>
              {actionPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
              {t('Unarchive')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="h-7 w-full justify-start gap-2 px-2 text-xs"
              disabled={destructiveDisabled || actionPending}
              onClick={onArchive}
            >
              <Archive className="h-3.5 w-3.5" />
              {t('Archive')}
            </Button>
          )}
          {!archived && (
            <Button
              variant="ghost"
              className="h-7 w-full justify-start gap-2 px-2 text-xs"
              disabled={destructiveDisabled || actionPending}
              onClick={onCompact}
            >
              <Minimize2 className="h-3.5 w-3.5" />
              {t('Compact')}
            </Button>
          )}
          <Button
            variant="ghost"
            className="h-7 w-full justify-start gap-2 px-2 text-xs"
            disabled={destructiveDisabled || actionPending}
            onClick={onFork}
          >
            {actionPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitFork className="h-3.5 w-3.5" />}
            {t('Fork')}
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
