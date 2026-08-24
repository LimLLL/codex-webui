/** `< n/m >` switcher for sibling versions of an edited user message. */
import { useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { MessageVersions } from '@/hooks/use-message-branches';

interface Props {
  versions: MessageVersions;
}

/**
 * Navigates between sibling versions of one message.
 *
 * Each version lives in its own thread, so switching is ordinary thread
 * navigation — the route is already driven entirely by the URL thread id.
 */
export function MessageVersionSwitcher({ versions }: Props) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { position, total } = versions;

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
    </div>
  );
}
