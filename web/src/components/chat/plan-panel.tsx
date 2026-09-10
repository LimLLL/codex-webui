/** Collapsible turn-level plan panel rendered inside an assistant turn. */
import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  ListChecks,
  Loader2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnPlanState, TurnPlanStepStatus } from '@/types/timeline';
import { cn } from '@/lib/utils';

interface Props {
  plan: TurnPlanState;
  completed: boolean;
}

function statusIcon(status: TurnPlanStepStatus) {
  if (status === 'completed') {
    return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
  }
  if (status === 'inProgress') {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/60" />;
}

/** Shows structured plan steps, plus provisional plan text deltas when present. */
export function PlanPanel({ plan, completed }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!completed);
  // One body of prose, whether it arrived as deltas or was read back from
  // history. Keeping them in separate blocks made the same plan look different
  // before and after a refresh, now that persisted plan text is stored per item
  // so a fragment lost to a disconnect can be replaced by its whole value.
  const planText = [
    plan.explanation,
    ...Object.values(plan.planTextByItemId ?? {}),
  ]
    .map((text) => text?.trim())
    .filter(Boolean)
    .join('\n\n');
  const hasStructuredPlan = plan.steps.length > 0;
  const hasContent = Boolean(planText || hasStructuredPlan);

  if (!hasContent) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/25">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/30"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 transition-transform duration-200',
            !open && '-rotate-90',
          )}
        />
        <ListChecks className="h-3.5 w-3.5" />
        <span className="font-medium text-foreground/80">{t('Plan')}</span>
        {hasStructuredPlan && (
          <span className="ml-auto tabular-nums">
            {completedCount(plan.steps)} / {plan.steps.length}
          </span>
        )}
        {!completed && <Loader2 className="h-3 w-3 animate-spin" />}
      </button>

      {open && (
        <div className="space-y-3 border-t border-border/40 px-3 py-2">
          {planText && (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {planText}
            </p>
          )}

          {hasStructuredPlan && (
            <ol className="space-y-1.5">
              {plan.steps.map((step, index) => (
                <li key={`${step.step}-${index}`} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 shrink-0">{statusIcon(step.status)}</span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 leading-relaxed',
                      step.status === 'completed' && 'text-muted-foreground line-through decoration-muted-foreground/40',
                      step.status === 'pending' && 'text-muted-foreground',
                    )}
                  >
                    {step.step}
                  </span>
                </li>
              ))}
            </ol>
          )}

        </div>
      )}
    </div>
  );
}

function completedCount(steps: TurnPlanState['steps']): number {
  return steps.filter((step) => step.status === 'completed').length;
}
