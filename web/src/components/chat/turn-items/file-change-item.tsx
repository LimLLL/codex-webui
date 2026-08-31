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
import { pendingApprovalsRespond } from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import type { TurnItem } from '@/types/timeline';
import type { ApprovalRequest, ResolvableApprovalDecision } from '@/types/approval';
import { cn } from '@/lib/utils';
import { GitDiffPanel } from './git-diff-panel';

interface Props {
  item: Extract<TurnItem, { type: 'fileChange' }>;
  /** Optional approval request associated with this file change. */
  approval?: ApprovalRequest;
}

/** Maps UI decision to Codex JSON-RPC decision value. */
function toRpcDecision(decision: ResolvableApprovalDecision): string {
  switch (decision) {
    case 'accepted': return 'accept';
    case 'acceptedForSession': return 'acceptForSession';
    case 'declined': return 'decline';
    case 'cancelled': return 'cancel';
  }
}

export function FileChangeItem({ item, approval }: Props) {
  const { t } = useTranslation();
  const resolveApproval = useTimelineStore((s) => s.resolveApproval);
  const [expanded, setExpanded] = useState(false);

  const fileName = item.filePath?.split('/').pop() ?? t('File change');
  const diff = item.fileDiff ?? '';
  const lines = diff ? diff.split('\n') : [];
  const additions = lines.filter(
    (l) => l.startsWith('+') && !l.startsWith('+++'),
  ).length;
  const deletions = lines.filter(
    (l) => l.startsWith('-') && !l.startsWith('---'),
  ).length;

  const isPending = approval?.status === 'pending';
  const isDeclined = approval?.status === 'declined';
  const isCancelled = approval?.status === 'cancelled';
  const isResolved = approval?.status === 'resolved';

  const handleDecision = (decision: ResolvableApprovalDecision) => {
    if (!approval) return;
    void pendingApprovalsRespond({
      path: { requestId: String(approval.requestId) },
      body: { result: { decision: toRpcDecision(decision) } },
    })
      .then(() => resolveApproval(approval.requestId, decision))
      .catch(() => undefined);
  };

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
          {item.filePath ?? fileName}
        </span>

        {/* +/- stats */}
        {diff && (
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
          <div className="ml-auto flex flex-wrap justify-end gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-6 border-green-500/50 px-2 text-xs text-green-500 hover:bg-green-500/10"
              onClick={(e) => { e.stopPropagation(); handleDecision('accepted'); }}
            >
              <Check className="mr-1 h-3 w-3" />
              {t('Accept')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 border-green-500/30 px-2 text-xs text-green-600 hover:bg-green-500/10"
              onClick={(e) => { e.stopPropagation(); handleDecision('acceptedForSession'); }}
            >
              <CheckCheck className="mr-1 h-3 w-3" />
              {t('Accept for session')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 border-red-500/50 px-2 text-xs text-red-500 hover:bg-red-500/10"
              onClick={(e) => { e.stopPropagation(); handleDecision('declined'); }}
            >
              <X className="mr-1 h-3 w-3" />
              {t('Decline')}
            </Button>
            <Button
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

      {/* Collapsible diff body */}
      {expanded && diff && (
        item.completed ? (
          <GitDiffPanel
            diff={diff}
            filePath={item.filePath ?? fileName}
            showToolbar={false}
            maxHeightClassName="max-h-64"
          />
        ) : (
          <pre
            className={cn(
              'max-h-64 overflow-auto border-t border-border p-3 font-mono text-xs leading-relaxed',
              'scrollbar-thin scrollbar-track-transparent scrollbar-thumb-muted-foreground/20',
            )}
          >
            {lines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  line.startsWith('+') && !line.startsWith('+++')
                    ? 'bg-green-500/10 text-green-400'
                    : line.startsWith('-') && !line.startsWith('---')
                      ? 'bg-red-500/10 text-red-400'
                      : line.startsWith('@@')
                        ? 'text-blue-400'
                        : 'text-muted-foreground',
                )}
              >
                {line}
              </div>
            ))}
          </pre>
        )
      )}
    </div>
  );
}
