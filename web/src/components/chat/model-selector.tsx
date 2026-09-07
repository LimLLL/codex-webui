/**
 * Model and reasoning effort selector for the chat input area.
 * Displays current model + effort as a compact badge, opens a popover to change.
 */
import { Bot, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { ModelDto } from '@/generated/api';
import { useActiveModel } from '@/hooks/use-active-model';
import { catalogCopy } from '@/lib/catalog-copy';
import { useModelStore, type ReasoningEffort } from '@/stores/model-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { OptionRow } from './option-row';

/**
 * Fallback effort options used only when no model resolves, so nothing
 * advertises a list. Deliberately carries no descriptions: inventing copy for
 * a model we cannot identify would be worse than showing none. Real models
 * declare their own set — the gpt-5.6 family offers neither `none` nor
 * `minimal` — so this must never win over `supportedReasoningEfforts`.
 */
const DEFAULT_EFFORTS: Array<{
  reasoningEffort: ReasoningEffort;
  description?: string;
}> = [
  { reasoningEffort: 'none' },
  { reasoningEffort: 'minimal' },
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' },
  { reasoningEffort: 'xhigh' },
  { reasoningEffort: 'max' },
  { reasoningEffort: 'ultra' },
];

/** Short display label for a model. */
function modelLabel(model: ModelDto): string {
  return model.displayName || model.model;
}

/** Displays model picker and reasoning effort selector. */
export function ModelSelector() {
  const { t } = useTranslation();
  const effortOverride = useModelStore((s) => s.effortOverride);
  const setModelOverride = useModelStore((s) => s.setModelOverride);
  const setEffortOverride = useModelStore((s) => s.setEffortOverride);
  const setServiceTierOverride = useModelStore((s) => s.setServiceTierOverride);
  const selectedThreadId = useTimelineStore((s) => s.threadId);
  const observedEffort = useModelStore((s) =>
    selectedThreadId ? s.observedEffortByThread[selectedThreadId] : null,
  );

  const { models, activeModelId, activeModel, configModel } = useActiveModel();
  // An explicit user choice wins; otherwise show what app-server reports for
  // this thread, which is how Plan mode's imposed effort becomes visible.
  const activeEffort =
    effortOverride ?? observedEffort ?? activeModel?.defaultReasoningEffort ?? null;

  const displayModel = activeModel
    ? modelLabel(activeModel)
    : activeModelId ?? t('Default');
  const displayEffort = activeEffort ?? '';

  const handleModelSelect = (model: ModelDto) => {
    if (model.model === configModel) {
      setModelOverride(null);
    } else {
      setModelOverride(model.model);
    }
    // Reset effort and speed tier to the new model's defaults. Both are
    // advertised per model, so carrying a previous choice across could select
    // an option the new model never offered.
    setEffortOverride(null);
    setServiceTierOverride(undefined);
  };

  const handleEffortSelect = (effort: ReasoningEffort) => {
    if (effort === activeModel?.defaultReasoningEffort) {
      setEffortOverride(null);
    } else {
      setEffortOverride(effort);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 rounded-lg px-2 text-xs"
          title={t('Model & reasoning effort')}
        >
          <Bot className="h-3.5 w-3.5" />
          <span className="hidden sm:inline max-w-[120px] truncate">
            {displayModel}
          </span>
          {displayEffort && (
            <span className="hidden sm:inline text-muted-foreground">
              · {displayEffort}
            </span>
          )}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="top"
        className="w-80 space-y-3 p-3 text-sm"
      >
        {/* Model list */}
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('Model')}
          </div>
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {models.map((model) => (
              <OptionRow
                key={model.id}
                active={model.model === activeModelId}
                badge={model.isDefault ? t('default') : undefined}
                description={catalogCopy(model.description)}
                label={modelLabel(model)}
                onSelect={() => handleModelSelect(model)}
              />
            ))}
            {models.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {t('No models available')}
              </p>
            )}
          </div>
        </div>

        {/* Reasoning effort — always shown, falls back to standard options */}
        <div className="space-y-1 border-t border-border pt-2">
          <div className="text-xs font-medium text-muted-foreground">
            {t('Reasoning effort')}
          </div>
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {(activeModel && activeModel.supportedReasoningEfforts.length > 0
              ? activeModel.supportedReasoningEfforts
              : DEFAULT_EFFORTS
            ).map((opt) => (
              <OptionRow
                key={opt.reasoningEffort}
                active={opt.reasoningEffort === activeEffort}
                badge={
                  opt.reasoningEffort === activeModel?.defaultReasoningEffort
                    ? t('default')
                    : undefined
                }
                description={
                  opt.description ? catalogCopy(opt.description) : undefined
                }
                label={opt.reasoningEffort}
                onSelect={() => handleEffortSelect(opt.reasoningEffort)}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
