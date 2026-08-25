/**
 * Composer badge for the thread's collaboration mode.
 *
 * app-server exposes no side-effect-free read for the current mode, so the
 * backend reports `observed: false` until a settings notification arrives.
 * This renders that third state honestly instead of claiming Default, because
 * showing a confirmed "Default" we never observed would be a lie the user
 * cannot distinguish from fact.
 */
import { Loader2, Telescope } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { ThreadCollaborationModeStateDto } from '@/generated/api/types.gen';
import { cn } from '@/lib/utils';

interface Props {
  state: ThreadCollaborationModeStateDto | undefined;
  pending: boolean;
  disabled: boolean;
  onToggle: () => void;
}

export function PlanModeBadge({ state, pending, disabled, onToggle }: Props) {
  const { t } = useTranslation();
  const planActive = state?.mode === 'plan';

  // Only surface the badge when Plan is on or a request is in flight. An
  // always-visible "Default" chip would crowd the footer without informing.
  if (!planActive && !pending) return null;

  return (
    <Button
      size="sm"
      variant="secondary"
      className={cn(
        'h-7 gap-1.5 rounded-lg px-2.5 text-xs',
        planActive && 'text-primary',
      )}
      disabled={disabled || pending}
      onClick={onToggle}
      title={t('Plan mode applies to the next turn. Click to turn it off.')}
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Telescope className="h-3.5 w-3.5" />
      )}
      <span>{t('Plan')}</span>
    </Button>
  );
}
