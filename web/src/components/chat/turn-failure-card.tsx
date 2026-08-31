/** Structured terminal-turn failure surface shared by live and hydrated errors. */
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TurnFailure } from '@/types/timeline';

/**
 * Renders a terminal failure without implying that continuation is available.
 * Legacy message-only rows naturally use the compact ordinary-failure layout.
 */
export function TurnFailureCard({ failure }: { failure: TurnFailure }) {
  const { t } = useTranslation();
  const hasMisalignment = Boolean(
    failure.misalignmentErrorType || failure.misalignmentExplanation,
  );

  return (
    <div className="ml-11 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium">{t('Turn failed')}</p>
          <p className="whitespace-pre-wrap wrap-break-word">
            {failure.message}
          </p>
          {failure.errorCategory && (
            <p className="font-mono text-[11px] opacity-75">
              {failure.errorCategory}
            </p>
          )}
          {failure.additionalDetails && (
            <p className="whitespace-pre-wrap text-xs opacity-85 wrap-break-word">
              {failure.additionalDetails}
            </p>
          )}
          {hasMisalignment && (
            <div className="mt-2 space-y-1 border-t border-destructive/20 pt-2">
              <p className="text-xs font-medium">
                {t('Request alignment explanation')}
              </p>
              {failure.misalignmentErrorType && (
                <p className="font-mono text-[11px] opacity-75">
                  {failure.misalignmentErrorType}
                </p>
              )}
              {failure.misalignmentExplanation && (
                <p className="whitespace-pre-wrap text-xs wrap-break-word">
                  {failure.misalignmentExplanation}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
