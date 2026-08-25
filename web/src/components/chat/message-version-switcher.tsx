/** `< n/m >` switcher for sibling versions of an edited user message. */
import { useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { MessageVersions } from '@/hooks/use-message-branches';
import { cn } from '@/lib/utils';

interface Props {
  versions: MessageVersions;
  /** Reason deletion is unavailable, or null when it is allowed. */
  deleteBlockedReason?: string | null;
  /**
   * Threads in a cascade that has been confirmed and is still in flight.
   *
   * The switcher used to stay fully live throughout: it kept reporting the
   * pre-delete count and let the user page into a version that was at that
   * moment being destroyed. Nothing on screen said anything was happening until
   * the success toast arrived.
   */
  deletingThreadIds?: ReadonlySet<string>;
  /**
   * Requests deletion of one version.
   *
   * `siblingThreadIds` is this group in switcher order, so the caller can land
   * the user on the neighbouring version instead of the empty state.
   */
  onDeleteVersion?: (threadId: string, siblingThreadIds: string[]) => void;
}

const NO_DELETIONS: ReadonlySet<string> = new Set<string>();

/**
 * Navigates between sibling versions of one message.
 *
 * Each version lives in its own thread, so switching is ordinary thread
 * navigation — the route is already driven entirely by the URL thread id.
 */
export function MessageVersionSwitcher({
  versions,
  deleteBlockedReason = null,
  deletingThreadIds = NO_DELETIONS,
  onDeleteVersion,
}: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { position, total } = versions;
  const list = versions.versions;
  // Feedback only — deliberately not an optimistic count. The versions are
  // still there until the server says otherwise, and a counter that decrements
  // on click would be asserting an outcome that can still fail. What the round
  // trip needs is evidence that something is happening, and a guarantee the
  // user cannot page into a version that is at that moment being destroyed.
  const isDeleting = list.some((version) =>
    deletingThreadIds.has(version.threadId),
  );

  const current = list[position - 1];
  // A group's `original` cannot be dropped on its own: every other version in
  // the group is a fork of it, so destroying it destroys the whole group — and
  // the thread it lives in, which the user knows by a different message
  // entirely. Offering the button here produced a confirmation naming two
  // conversations the user never mentioned.
  //
  // The test is per group, not per thread. One thread is the `original` of the
  // group created from its own later turns while remaining a deletable `branch`
  // of the outer group it was forked into — the same trash icon is therefore
  // correct on one switcher and wrong on another. This also subsumes the tree
  // root, which is simply the `original` of the outermost group.
  const isGroupOriginal = current?.kind === 'original';
  const blockedReason = isGroupOriginal
    ? t(
        'This is the original version. Deleting it would remove every other version of this message along with it — delete the whole branch from the outer version switcher or the sidebar instead.',
      )
    : deleteBlockedReason;
  const showDeleteVersion = Boolean(onDeleteVersion) && Boolean(current);

  const goTo = (nextPosition: number) => {
    const target = list[nextPosition - 1];
    if (!target) return;
    void navigate({
      to: '/t/$threadId',
      params: { threadId: target.threadId },
    });
  };

  return (
    <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('Previous version')}
            disabled={position <= 1 || isDeleting}
            className="flex cursor-pointer items-center rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            onClick={() => goTo(position - 1)}
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('Previous version')}</TooltipContent>
      </Tooltip>

      <span className="tabular-nums">
        {position}/{total}
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('Next version')}
            disabled={position >= total || isDeleting}
            className="flex cursor-pointer items-center rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            onClick={() => goTo(position + 1)}
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('Next version')}</TooltipContent>
      </Tooltip>

      {showDeleteVersion && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={
                isDeleting ? t('Deleting…') : t('Delete this version')
              }
              disabled={Boolean(blockedReason) || isDeleting}
              title={blockedReason ?? undefined}
              // Dimmed when unavailable, but not while deleting: a 30%-opacity
              // spinner is the same "nothing is happening" signal being fixed.
              className={cn(
                'flex cursor-pointer items-center rounded p-0.5 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:hover:bg-transparent',
                !isDeleting && 'disabled:opacity-30',
              )}
              onClick={() =>
                onDeleteVersion?.(
                  current.threadId,
                  list.map((version) => version.threadId),
                )
              }
            >
              {/* The control that was activated is the one that reports
                  progress. A separate indicator elsewhere would leave the bin
                  looking idle and clickable, which is what it did before. */}
              {isDeleting ? (
                <Loader2 className="h-3 w-3 animate-spin text-destructive" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {isDeleting
              ? t('Deleting…')
              : (blockedReason ?? t('Delete this version and its branches'))}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
