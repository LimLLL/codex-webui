/**
 * Model and reasoning effort selector for the chat input area.
 * Displays current model + effort as a compact badge, opens a popover to change.
 */
import { Bot, ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  codexStatusGetStatusOptions,
  modelsListModelsOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import type { ModelDto } from '@/generated/api';
import { useModelStore } from '@/stores/model-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { cn } from '@/lib/utils';

type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Fallback effort options when a model doesn't declare its own. */
const DEFAULT_EFFORTS: Array<{ reasoningEffort: ReasoningEffort }> = [
  { reasoningEffort: 'none' },
  { reasoningEffort: 'minimal' },
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' },
  { reasoningEffort: 'xhigh' },
];

/** Short display label for a model. */
function modelLabel(model: ModelDto): string {
  return model.displayName || model.model;
}

/** Displays model picker and reasoning effort selector. */
export function ModelSelector() {
  const { t } = useTranslation();
  const modelOverride = useModelStore((s) => s.modelOverride);
  const effortOverride = useModelStore((s) => s.effortOverride);
  const setModelOverride = useModelStore((s) => s.setModelOverride);
  const setEffortOverride = useModelStore((s) => s.setEffortOverride);
  const selectedThreadId = useTimelineStore((s) => s.threadId);
  const observedEffort = useModelStore((s) =>
    selectedThreadId ? s.observedEffortByThread[selectedThreadId] : null,
  );

  // Config model from status (lightweight, cached)
  const { data: statusData } = useQuery({
    ...codexStatusGetStatusOptions(),
    refetchOnWindowFocus: true,
  });
  // Full model list from dedicated endpoint (longer staleTime)
  const { data: modelsData } = useQuery({
    ...modelsListModelsOptions(),
    staleTime: 60_000,
  });

  const configModel = (statusData?.config.data as { model?: string } | undefined)?.model;
  const models = modelsData?.data?.filter((m) => !m.hidden) ?? [];
  const activeModelId = modelOverride ?? configModel ?? null;
  const activeModel = models.find((m) => m.model === activeModelId);
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
    // Reset effort to model default when switching models
    setEffortOverride(null);
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
        className="w-64 space-y-3 p-3 text-sm"
      >
        {/* Model list */}
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">
            {t('Model')}
          </div>
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {models.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => handleModelSelect(model)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  model.model === activeModelId
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50',
                )}
              >
                <span className="truncate">{modelLabel(model)}</span>
                {model.isDefault && (
                  <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
                    {t('default')}
                  </span>
                )}
              </button>
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
          {(activeModel && activeModel.supportedReasoningEfforts.length > 0
            ? activeModel.supportedReasoningEfforts
            : DEFAULT_EFFORTS
          ).map((opt) => (
            <button
              key={opt.reasoningEffort}
              type="button"
              onClick={() => handleEffortSelect(opt.reasoningEffort)}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                opt.reasoningEffort === activeEffort
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50',
              )}
            >
              <span>{opt.reasoningEffort}</span>
              {activeModel && opt.reasoningEffort === activeModel.defaultReasoningEffort && (
                <span className="text-[10px] text-muted-foreground">
                  {t('default')}
                </span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
