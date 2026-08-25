/**
 * Asks whether a fork should carry the source thread's active goal.
 *
 * Only rendered when the source thread has a live goal, so an ordinary fork
 * stays a single click. The checkbox starts unchecked to match native Codex,
 * where deferred goal continuation is opt-in.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { PendingForkPrompt } from '@/hooks/use-fork-with-goal';

interface Props {
  prompt: PendingForkPrompt | null;
  pending: boolean;
  onConfirm: (carryGoal: boolean) => void;
  onCancel: () => void;
}

/**
 * Callers must key this on the pending thread id so each fork starts from an
 * unchecked box; remounting is what resets the opt-in between prompts.
 */
export function ForkGoalDialog({ prompt, pending, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const [carryGoal, setCarryGoal] = useState(false);

  return (
    <AlertDialog open={prompt !== null} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('Fork this thread?')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('This thread has an active goal:')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          {prompt?.objective}
        </p>

        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={carryGoal}
            onChange={(e) => setCarryGoal(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5"
          />
          <span className="text-muted-foreground">
            {t(
              'Carry the goal into the fork. Codex defers continuing it until you send the first message there, after which the fork may keep spending tokens on this objective.',
            )}
          </span>
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={() => onConfirm(carryGoal)}
          >
            {t('Fork')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
