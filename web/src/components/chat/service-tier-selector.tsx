/**
 * Speed (service tier) selector for the chat input area.
 *
 * Kept separate from the model picker because tiers are an independent axis:
 * they change delivery speed and usage cost, not model behaviour, and a user
 * switching speed should not have to walk past the model and effort lists.
 */
import { ChevronDown, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useActiveModel } from '@/hooks/use-active-model';
import { catalogCopy } from '@/lib/catalog-copy';
import { useModelStore } from '@/stores/model-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { OptionRow } from './option-row';

/** Displays the active speed tier and lets the user change it. */
export function ServiceTierSelector() {
  const { t } = useTranslation();
  const serviceTierOverride = useModelStore((s) => s.serviceTierOverride);
  const setServiceTierOverride = useModelStore((s) => s.setServiceTierOverride);
  const selectedThreadId = useTimelineStore((s) => s.threadId);
  const observedTier = useModelStore((s) =>
    selectedThreadId ? s.observedServiceTierByThread[selectedThreadId] : null,
  );
  const { activeModel } = useActiveModel();

  const serviceTiers = activeModel?.serviceTiers ?? [];
  // An explicit user choice wins. Otherwise show the tier app-server reports
  // for this thread — falling straight through to the catalog default would
  // claim "Standard" for a thread already carrying a paid tier, which the
  // composer leaves in force because it omits an untouched `serviceTier`.
  const activeTierId =
    serviceTierOverride !== undefined
      ? serviceTierOverride
      : (observedTier ?? activeModel?.defaultServiceTier ?? null);
  const activeTier = serviceTiers.find((tier) => tier.id === activeTierId);

  // Nothing to choose between when the model advertises no tiers, and an
  // always-visible control would imply speed is configurable when it is not.
  if (serviceTiers.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-lg px-2 text-xs"
          title={t('Speed')}
        >
          <Zap className="h-3.5 w-3.5" />
          <span className="hidden sm:inline max-w-[90px] truncate">
            {activeTier ? catalogCopy(activeTier.name) : t('Standard')}
          </span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        side="top"
        className="w-72 space-y-1 p-3 text-sm"
      >
        <div className="text-xs font-medium text-muted-foreground">
          {t('Speed')}
        </div>
        <OptionRow
          active={activeTierId === null}
          badge={
            activeModel?.defaultServiceTier === null ? t('default') : undefined
          }
          description={t('Standard speed included with your plan.')}
          label={t('Standard')}
          // Explicit null, not undefined: this is what clears a tier the
          // thread already carries.
          onSelect={() => setServiceTierOverride(null)}
        />
        {serviceTiers.map((tier) => (
          <OptionRow
            key={tier.id}
            active={tier.id === activeTierId}
            badge={
              tier.id === activeModel?.defaultServiceTier
                ? t('default')
                : undefined
            }
            description={catalogCopy(tier.description)}
            label={catalogCopy(tier.name)}
            onSelect={() => setServiceTierOverride(tier.id)}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
