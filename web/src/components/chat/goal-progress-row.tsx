/**
 * Persistent goal row shown above the composer while a thread has a goal.
 *
 * A goal is a durable objective that outlives any single turn, so it is thread
 * state rendered as a fixed row rather than a timeline entry. Pause stops
 * future continuation only — it does not interrupt a turn that is already
 * running, and the copy says so instead of implying a hard stop.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, Loader2, Pause, Pencil, Play, Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  threadCommandsClearGoalMutation,
  threadCommandsReadGoalOptions,
  threadCommandsReadGoalQueryKey,
  threadCommandsSetGoalMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { getApiErrorMessage } from '@/lib/api-error';
import { useTimelineStore } from '@/stores/timeline-store';
import { cn } from '@/lib/utils';

/** Statuses where the goal is no longer driving work forward. */
const TERMINAL_STATUSES = new Set(['complete', 'usageLimited', 'budgetLimited']);

interface Props {
  threadId: string | null;
  readOnly: boolean;
}

export function GoalProgressRow({ threadId, readOnly }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const addSystemError = useTimelineStore((s) => s.addSystemError);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const { data } = useQuery({
    ...threadCommandsReadGoalOptions({ path: { threadId: threadId ?? '' } }),
    enabled: Boolean(threadId),
  });

  const invalidate = () => {
    if (!threadId) return;
    void queryClient.invalidateQueries({
      queryKey: threadCommandsReadGoalQueryKey({ path: { threadId } }),
    });
  };

  const setGoal = useMutation({
    ...threadCommandsSetGoalMutation(),
    onSuccess: invalidate,
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });
  const clearGoal = useMutation({
    ...threadCommandsClearGoalMutation(),
    onSuccess: invalidate,
    onError: (err) => addSystemError(getApiErrorMessage(err)),
  });

  const goal = data?.goal;
  if (!threadId || !goal) return null;

  const busy = setGoal.isPending || clearGoal.isPending;
  const paused = goal.status === 'paused';
  const terminal = TERMINAL_STATUSES.has(goal.status);

  const submitEdit = () => {
    const objective = draft.trim();
    if (!objective || objective === goal.objective) {
      setEditing(false);
      return;
    }
    setGoal.mutate({ path: { threadId }, body: { objective } });
    setEditing(false);
  };

  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/40 px-3 py-1.5 text-xs">
      <Target
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          terminal ? 'text-muted-foreground' : 'text-primary',
        )}
      />

      {editing ? (
        <Input
          autoFocus
          value={draft}
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitEdit(); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          }}
          className="h-6 flex-1 border-none bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
        />
      ) : (
        <span className="flex-1 truncate" title={goal.objective}>
          {goal.objective}
        </span>
      )}

      <GoalStatusLabel status={goal.status} />

      {!readOnly && !editing && (
        <div className="flex shrink-0 items-center gap-0.5">
          {!terminal && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              disabled={busy}
              onClick={() =>
                setGoal.mutate({
                  path: { threadId },
                  body: { status: paused ? 'active' : 'paused' },
                })
              }
              title={
                paused
                  ? t('Resume working toward this goal')
                  : t('Pause the goal. The current turn keeps running.')
              }
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : paused ? (
                <Play className="h-3 w-3" />
              ) : (
                <Pause className="h-3 w-3" />
              )}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            disabled={busy}
            onClick={() => { setDraft(goal.objective); setEditing(true); }}
            title={t('Edit goal')}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            disabled={busy}
            onClick={() => clearGoal.mutate({ path: { threadId } })}
            title={t('Clear goal')}
          >
            <Ban className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** Renders the goal status, omitting the unremarkable active case. */
function GoalStatusLabel({ status }: { status: string }) {
  const { t } = useTranslation();
  if (status === 'active') return null;

  const labels: Record<string, string> = {
    paused: t('Paused'),
    blocked: t('Blocked'),
    usageLimited: t('Usage limit reached'),
    budgetLimited: t('Token budget reached'),
    complete: t('Complete'),
  };

  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      {status === 'complete' && <Check className="h-3 w-3" />}
      {labels[status] ?? status}
    </span>
  );
}
