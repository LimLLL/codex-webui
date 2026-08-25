/**
 * Confirmation dialogs for slash commands that need input before they act.
 *
 * These are the `ui` dispatch kind from the command catalog: opening one sends
 * nothing, so a mistyped `/review` costs the user nothing until they confirm.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  codexFeedbackUploadFeedbackMutation,
  threadCommandsReadGoalQueryKey,
  threadCommandsSetGoalMutation,
  threadCommandsStartReviewMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { getApiErrorMessage } from '@/lib/api-error';
import type { SlashDialog } from '@/hooks/use-slash-dispatch';
import { cn } from '@/lib/utils';

/** Matches the cap Codex enforces on goal text. */
const MAX_GOAL_LENGTH = 4000;

interface Props {
  dialog: SlashDialog;
  threadId: string | null;
  onClose: () => void;
  onError: (message: string) => void;
}

export function SlashDialogs({ dialog, threadId, onClose, onError }: Props) {
  return (
    <>
      <GoalDialog
        open={dialog === 'goal'}
        threadId={threadId}
        onClose={onClose}
        onError={onError}
      />
      <ReviewDialog
        open={dialog === 'review'}
        threadId={threadId}
        onClose={onClose}
        onError={onError}
      />
      <FeedbackDialog
        open={dialog === 'feedback'}
        threadId={threadId}
        onClose={onClose}
        onError={onError}
      />
    </>
  );
}

interface DialogProps {
  open: boolean;
  threadId: string | null;
  onClose: () => void;
  onError: (message: string) => void;
}

function GoalDialog({ open, threadId, onClose, onError }: DialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [objective, setObjective] = useState('');

  const setGoal = useMutation({
    ...threadCommandsSetGoalMutation(),
    onSuccess: () => {
      if (threadId) {
        void queryClient.invalidateQueries({
          queryKey: threadCommandsReadGoalQueryKey({ path: { threadId } }),
        });
      }
      setObjective('');
      onClose();
    },
    onError: (err) => onError(getApiErrorMessage(err)),
  });

  const trimmed = objective.trim();
  const tooLong = trimmed.length > MAX_GOAL_LENGTH;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Set a goal')}</DialogTitle>
          <DialogDescription>
            {t(
              'Codex keeps working toward this objective across turns until it finishes, pauses, or needs input.',
            )}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={4}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder={t('e.g. Keep refactoring until the suite passes')}
        />
        <p
          className={cn(
            'text-right text-xs',
            tooLong ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {trimmed.length} / {MAX_GOAL_LENGTH}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={!trimmed || tooLong || !threadId || setGoal.isPending}
            onClick={() =>
              threadId &&
              setGoal.mutate({
                path: { threadId },
                body: { objective: trimmed },
              })
            }
          >
            {setGoal.isPending && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            {t('Set goal')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The four inline review targets app-server accepts. */
type ReviewKind = 'uncommittedChanges' | 'baseBranch' | 'commit' | 'custom';

const REVIEW_KINDS: { kind: ReviewKind; label: string; hint?: string }[] = [
  { kind: 'uncommittedChanges', label: 'Uncommitted changes' },
  { kind: 'baseBranch', label: 'Against a base branch', hint: 'Branch name' },
  { kind: 'commit', label: 'A specific commit', hint: 'Commit SHA' },
  { kind: 'custom', label: 'Custom instructions', hint: 'What should Codex look for?' },
];

function ReviewDialog({ open, threadId, onClose, onError }: DialogProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ReviewKind>('uncommittedChanges');
  const [argument, setArgument] = useState('');

  const startReview = useMutation({
    ...threadCommandsStartReviewMutation(),
    onSuccess: () => {
      setArgument('');
      onClose();
    },
    onError: (err) => onError(getApiErrorMessage(err)),
  });

  const selected = REVIEW_KINDS.find((entry) => entry.kind === kind);
  const needsArgument = kind !== 'uncommittedChanges';
  const trimmed = argument.trim();
  const canSubmit =
    Boolean(threadId) && (!needsArgument || trimmed.length > 0);

  const buildTarget = () => {
    switch (kind) {
      case 'baseBranch':
        return { type: 'baseBranch' as const, branch: trimmed };
      case 'commit':
        return { type: 'commit' as const, sha: trimmed, title: null };
      case 'custom':
        return { type: 'custom' as const, instructions: trimmed };
      default:
        return { type: 'uncommittedChanges' as const };
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Start a code review')}</DialogTitle>
          <DialogDescription>
            {t('Codex reviews the checked-out project and reports findings in this thread.')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1">
          {REVIEW_KINDS.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              onClick={() => { setKind(entry.kind); setArgument(''); }}
              className={cn(
                'rounded-lg px-3 py-2 text-left text-sm',
                kind === entry.kind ? 'bg-accent' : 'hover:bg-accent/60',
              )}
            >
              {t(entry.label)}
            </button>
          ))}
        </div>

        {needsArgument && selected?.hint && (
          <Input
            autoFocus
            value={argument}
            onChange={(e) => setArgument(e.target.value)}
            placeholder={t(selected.hint)}
          />
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={!canSubmit || startReview.isPending}
            onClick={() =>
              threadId &&
              startReview.mutate({
                path: { threadId },
                body: { target: buildTarget() },
              })
            }
          >
            {startReview.isPending && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            {t('Start review')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FeedbackDialog({ open, threadId, onClose, onError }: DialogProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [includeLogs, setIncludeLogs] = useState(false);

  const upload = useMutation({
    ...codexFeedbackUploadFeedbackMutation(),
    onSuccess: () => {
      setReason('');
      setIncludeLogs(false);
      onClose();
    },
    onError: (err) => onError(getApiErrorMessage(err)),
  });

  const trimmed = reason.trim();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Send feedback')}</DialogTitle>
          <DialogDescription>
            {t('Your report goes to the Codex maintainers.')}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('What happened?')}
        />
        {/* Logs can contain file paths and command output, so this stays off
            until the user opts in explicitly. */}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeLogs}
            onChange={(e) => setIncludeLogs(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          {t('Attach Codex logs (may include file paths and command output)')}
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={!trimmed || upload.isPending}
            onClick={() =>
              upload.mutate({
                body: {
                  classification: 'general',
                  reason: trimmed,
                  includeLogs,
                  ...(threadId && { threadId }),
                },
              })
            }
          >
            {upload.isPending && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            {t('Send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
