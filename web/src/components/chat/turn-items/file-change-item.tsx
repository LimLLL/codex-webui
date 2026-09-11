/**
 * Renders a file change item with collapsible diff and inline approval controls.
 * Default collapsed — header shows file path, approval status, and +/- stats.
 * When a pending approval exists, accept/acceptForSession/decline/cancel buttons appear.
 */
import { useState } from 'react';
import {
  FileCode,
  Loader2,
  ChevronDown,
  Check,
  CheckCheck,
  X,
  Ban,
  ShieldAlert,
  CheckCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { TurnItem } from '@/types/timeline';
import type { ApprovalRequest } from '@/types/approval';
import { cn } from '@/lib/utils';
import { summarizeChangeSet } from '@/lib/file-change-stats';
import { FileChangeSet } from './file-change-set';
import { useApprovalDecision } from '@/hooks/use-approval-decision';

interface Props {
  item: Extract<TurnItem, { type: 'fileChange' }>;
  /** Optional approval request associated with this file change. */
  approval?: ApprovalRequest;
}

export function FileChangeItem({ item, approval }: Props) {
  const { t } = useTranslation();
  const { decide: handleDecision, submitting } = useApprovalDecision(approval);
  const [expanded, setExpanded] = useState(false);

  // One approval can cover several files (measured). Fall back to the legacy
  // single-file fields so an item normalized before this existed still renders.
  const changes = approval?.reviewChanges?.length
    ? approval.reviewChanges
    : item.fileChanges?.length
      ? item.fileChanges
      : item.filePath
        ? [{ path: item.filePath, diff: item.fileDiff ?? '' }]
        : [];
  const fileName = changes[0]?.path.split('/').pop() ?? t('File change');
  const { additions, deletions, hasDiff } = summarizeChangeSet(changes);

  const isPending = approval?.status === 'pending';
  // The backend refuses to accept a file approval it could not retain the
  // change set for, even when this client happens to be showing the item. Its
  // rule is about what the *decision* is made against, not what one browser can
  // see, so the inline bar has to honour it too or offer a button that 409s.
  const canApprove = !(approval && !approval.reviewChanges?.length);
  const isDeclined = approval?.status === 'declined';
  const isCancelled = approval?.status === 'cancelled';
  const isResolved = approval?.status === 'resolved';


  return (
    <div
      className={cn(
        'rounded-lg border text-sm',
        isPending
          ? 'border-yellow-500/50 bg-yellow-500/5'
          : 'border-border bg-muted/30',
      )}
    >
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/30"
      >
        <FileCode className="h-3.5 w-3.5 shrink-0 text-orange-400" />
        <span className="min-w-0 truncate font-mono text-muted-foreground">
          {changes.length > 1
            ? t('{{count}} files', { count: changes.length })
            : (changes[0]?.path ?? fileName)}
        </span>

        {/* +/- stats */}
        {hasDiff && (
          <>
            {additions > 0 && (
              <span className="shrink-0 text-green-400">+{additions}</span>
            )}
            {deletions > 0 && (
              <span className="shrink-0 text-red-400">-{deletions}</span>
            )}
          </>
        )}

        {/* Loading spinner */}
        {!item.completed && (
          <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        )}

        {/* Approval status badges (non-pending) */}
        {approval?.status === 'accepted' && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-green-500">
            <Check className="h-3 w-3" /> {t('Accepted')}
          </span>
        )}
        {approval?.status === 'acceptedForSession' && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-green-500">
            <CheckCheck className="h-3 w-3" /> {t('Accepted for session')}
          </span>
        )}
        {isDeclined && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-red-500">
            <X className="h-3 w-3" /> {t('Declined')}
          </span>
        )}
        {isCancelled && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-orange-500">
            <Ban className="h-3 w-3" /> {t('Cancelled')}
          </span>
        )}
        {isResolved && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
            <CheckCircle className="h-3 w-3" /> {t('Resolved')}
          </span>
        )}

        {/* Completed badge (no approval) */}
        {item.completed && !approval && (
          <span className="ml-auto shrink-0 text-green-400">{t('Applied')}</span>
        )}

        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {/* Pending approval bar */}
      {isPending && (
        <div className="flex flex-wrap items-center gap-2 border-t border-yellow-500/30 px-3 py-1.5">
          <ShieldAlert className="h-3.5 w-3.5 text-yellow-500" />
          <span className="text-xs font-medium text-yellow-500">
            {t('File Change Approval')}
          </span>
          {approval.reason && (
            <span className="truncate text-xs text-muted-foreground">
              — {approval.reason}
            </span>
          )}
          {approval.grantRoot && (
            <span className="truncate text-xs text-muted-foreground">
              {t('Requesting write access to:')}{' '}
              <code className="rounded bg-muted px-1">{approval.grantRoot}</code>
            </span>
          )}
          {!canApprove && (
            <span className="text-xs text-amber-500">
              {t('Changes unavailable — decline only')}
            </span>
          )}
          <div className="ml-auto flex flex-wrap justify-end gap-1.5">
            {canApprove && (
              <>
                <Button
                  disabled={submitting}
                  size="sm"
                  variant="outline"
                  className="h-6 border-green-500/50 px-2 text-xs text-green-500 hover:bg-green-500/10"
                  onClick={(e) => { e.stopPropagation(); handleDecision('accepted'); }}
                >
                  <Check className="mr-1 h-3 w-3" />
                  {t('Accept')}
                </Button>
                <Button
                  disabled={submitting}
                  size="sm"
                  variant="outline"
                  className="h-6 border-green-500/30 px-2 text-xs text-green-600 hover:bg-green-500/10"
                  onClick={(e) => { e.stopPropagation(); handleDecision('acceptedForSession'); }}
                >
                  <CheckCheck className="mr-1 h-3 w-3" />
                  {t('Accept for session')}
                </Button>
              </>
            )}
            <Button
              disabled={submitting}
              size="sm"
              variant="outline"
              className="h-6 border-red-500/50 px-2 text-xs text-red-500 hover:bg-red-500/10"
              onClick={(e) => { e.stopPropagation(); handleDecision('declined'); }}
            >
              <X className="mr-1 h-3 w-3" />
              {t('Decline')}
            </Button>
            <Button
              disabled={submitting}
              size="sm"
              variant="outline"
              className="h-6 border-orange-500/50 px-2 text-xs text-orange-500 hover:bg-orange-500/10"
              onClick={(e) => { e.stopPropagation(); handleDecision('cancelled'); }}
            >
              <Ban className="mr-1 h-3 w-3" />
              {t('Cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* Collapsible diff body — every proposed file, not just the first */}
      {expanded && <FileChangeSet changes={changes} settled={Boolean(approval?.reviewChanges?.length) || item.completed} alwaysLabelPaths />}
    </div>
  );
}
