/** `< n/m >` switcher for sibling versions of an edited user message. */
import { useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { MessageVersions } from '@/hooks/use-message-branches';

interface Props {
  versions: MessageVersions;
  /** Reason deletion is unavailable, or null when it is allowed. */
  deleteBlockedReason?: string | null;
  /**
   * Requests deletion of one version.
   *
   * `siblingThreadIds` is this group in switcher order, so the caller can land
   * the user on the neighbouring version instead of the empty state.
   */
  onDeleteVersion?: (threadId: string, siblingThreadIds: string[]) => void;
}

/**
 * Navigates between sibling versions of one message.
 *
 * Each version lives in its own thread, so switching is ordinary thread
 * navigation — the route is already driven entirely by the URL thread id.
 */
export function MessageVersionSwitcher({
  versions,
  deleteBlockedReason = null,
  onDeleteVersion,
}: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { position, total } = versions;

  const current = versions.versions[position - 1];
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
    const target = versions.versions[nextPosition - 1];
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
            disabled={position <= 1}
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
            disabled={position >= total}
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
              aria-label={t('Delete this version')}
              disabled={Boolean(blockedReason)}
              title={blockedReason ?? undefined}
              className="flex cursor-pointer items-center rounded p-0.5 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
              onClick={() =>
                onDeleteVersion?.(
                  current.threadId,
                  versions.versions.map((version) => version.threadId),
                )
              }
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {blockedReason ?? t('Delete this version and its branches')}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
