/** Renders an app-server item/tool/requestUserInput card for structured user input. */
import { useMemo, useState } from 'react';
import { CheckCircle, Loader2, MessageCircleQuestion } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { pendingApprovalsRespond } from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import type { UserInputQuestion, UserInputRequest } from '@/types/approval';
import { cn } from '@/lib/utils';

interface Props {
  request: UserInputRequest;
}

/** Per-question draft state. */
interface QuestionDraft {
  selected: string[];
  text: string;
}

type DraftState = Record<string, QuestionDraft>;

function createDraft(questions: UserInputQuestion[]): DraftState {
  return Object.fromEntries(
    questions.map((q) => [q.id, { selected: [], text: '' }]),
  );
}

/**
 * Builds the ToolRequestUserInputResponse wire format:
 * { answers: { [questionId]: { answers: string[] } } }
 */
function buildAnswers(
  questions: UserInputQuestion[],
  draft: DraftState,
): Record<string, { answers: string[] }> {
  return Object.fromEntries(
    questions.map((q) => {
      const d = draft[q.id] ?? { selected: [], text: '' };
      const values = [
        ...d.selected,
        ...(d.text.trim() ? [d.text.trim()] : []),
      ];
      return [q.id, { answers: values }];
    }),
  );
}

/** Every question must have at least one answer. */
function isComplete(questions: UserInputQuestion[], draft: DraftState): boolean {
  return questions.every((q) => {
    const d = draft[q.id];
    if (!d) return false;
    return d.selected.length > 0 || d.text.trim().length > 0;
  });
}

export function UserInputCard({ request }: Props) {
  const { t } = useTranslation();
  const resolveUserInputRequest = useTimelineStore((s) => s.resolveUserInputRequest);
  const [draft, setDraft] = useState<DraftState>(() => createDraft(request.questions));
  const [submitting, setSubmitting] = useState(false);

  const isPending = request.status === 'pending';
  const answers = useMemo(
    () => buildAnswers(request.questions, draft),
    [draft, request.questions],
  );
  const canSubmit = isPending && isComplete(request.questions, draft) && !submitting;

  const setSingle = (qId: string, value: string) => {
    setDraft((prev) => ({
      ...prev,
      [qId]: { ...(prev[qId] ?? { selected: [], text: '' }), selected: [value] },
    }));
  };

  const toggle = (qId: string, value: string) => {
    setDraft((prev) => {
      const existing = prev[qId] ?? { selected: [], text: '' };
      const selected = existing.selected.includes(value)
        ? existing.selected.filter((v) => v !== value)
        : [...existing.selected, value];
      return { ...prev, [qId]: { ...existing, selected } };
    });
  };

  const setText = (qId: string, value: string) => {
    setDraft((prev) => ({
      ...prev,
      [qId]: { ...(prev[qId] ?? { selected: [], text: '' }), text: value },
    }));
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    void pendingApprovalsRespond({
      path: { requestId: String(request.requestId) },
      body: { result: { answers } },
    })
      .then(() => resolveUserInputRequest(request.requestId))
      .catch(() => undefined)
      .finally(() => setSubmitting(false));
  };

  return (
    <div
      className={cn(
        'rounded-lg border text-sm',
        isPending
          ? 'border-blue-500/50 bg-blue-500/5'
          : 'border-muted bg-muted/5',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <MessageCircleQuestion
          className={cn(
            'h-4 w-4',
            isPending ? 'text-blue-500' : 'text-muted-foreground',
          )}
        />
        <span className="font-medium">{t('Input Requested')}</span>
        {!isPending && (
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            <CheckCircle className="h-3 w-3" /> {t('Resolved')}
          </span>
        )}
      </div>

      {/* Questions */}
      <div className="space-y-3 px-3 py-2">
        {request.questions.map((question) => {
          const d = draft[question.id] ?? { selected: [], text: '' };
          const options = question.options ?? [];
          // isOther + options = multi-select (checkboxes); otherwise radio
          const useCheckboxes = question.isOther && options.length > 0;

          return (
            <div key={question.id} className="space-y-2">
              <div>
                <div className="text-xs font-medium">{question.header}</div>
                <div className="text-xs text-muted-foreground">{question.question}</div>
              </div>

              {options.length > 0 && (
                <div className="space-y-1.5">
                  {options.map((opt) => (
                    <label
                      key={opt.label}
                      className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 px-2 py-1.5 hover:bg-accent/30"
                    >
                      <input
                        type={useCheckboxes ? 'checkbox' : 'radio'}
                        name={`${request.requestId}-${question.id}`}
                        className="mt-0.5 h-3.5 w-3.5 accent-primary"
                        checked={d.selected.includes(opt.label)}
                        disabled={!isPending || submitting}
                        onChange={() => {
                          if (useCheckboxes) toggle(question.id, opt.label);
                          else setSingle(question.id, opt.label);
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block text-xs">{opt.label}</span>
                        {opt.description && (
                          <span className="block text-xs text-muted-foreground">
                            {opt.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {/* Free-text input (shown if no options, or isOther allows extra text) */}
              {(!question.options || question.isOther) && (
                <Input
                  type={question.isSecret ? 'password' : 'text'}
                  value={d.text}
                  disabled={!isPending || submitting}
                  placeholder={question.isOther ? t('Other answer') : t('Answer')}
                  onChange={(e) => setText(question.id, e.target.value)}
                />
              )}
            </div>
          );
        })}

        {isPending && (
          <div className="flex justify-end pt-1">
            <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
              {submitting && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {t('Submit')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
