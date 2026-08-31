/**
 * Renders a command, terminal-input, or file-change approval request card.
 * Buttons are dynamically rendered from server-provided availableDecisions.
 * Proposed exec/network amendments are shown when the server includes them.
 */
import {
  ShieldAlert, Check, CheckCheck, X, Ban, Terminal, FileCode,
  CheckCircle, Shield, Globe,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { pendingApprovalsRespond } from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import type {
  ApprovalRequest,
  ResolvableApprovalDecision,
  RawCommandDecision,
} from '@/types/approval';
import { cn } from '@/lib/utils';

interface Props {
  approval: ApprovalRequest;
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

/** Checks if a raw decision string matches a simple decision type. */
function hasSimpleDecision(decisions: RawCommandDecision[] | null | undefined, key: string): boolean {
  return decisions?.some((d) => d === key) ?? false;
}

/** Checks if the available decisions include an exec policy amendment option. */
function hasExecAmendment(decisions: RawCommandDecision[] | null | undefined): boolean {
  return decisions?.some((d) => typeof d === 'object' && 'acceptWithExecpolicyAmendment' in d) ?? false;
}

/** Checks if the available decisions include a network policy amendment option. */
function hasNetworkAmendment(decisions: RawCommandDecision[] | null | undefined): boolean {
  return decisions?.some((d) => typeof d === 'object' && 'applyNetworkPolicyAmendment' in d) ?? false;
}

export function ApprovalItem({ approval }: Props) {
  const { t } = useTranslation();
  const resolveApproval = useTimelineStore((s) => s.resolveApproval);
  const avail = approval.availableDecisions;

  const handleDecision = (decision: ResolvableApprovalDecision) => {
    void pendingApprovalsRespond({
      path: { requestId: String(approval.requestId) },
      body: { result: { decision: toRpcDecision(decision) } },
    })
      .then(() => resolveApproval(approval.requestId, decision))
      .catch(() => undefined);
  };

  const handleExecAmendment = () => {
    const patterns = approval.proposedExecpolicyAmendment;
    if (!patterns?.length) return;
    void pendingApprovalsRespond({
      path: { requestId: String(approval.requestId) },
      body: { result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: patterns } } } },
    })
      .then(() => resolveApproval(approval.requestId, 'accepted'))
      .catch(() => undefined);
  };

  const handleNetworkAmendment = (index: number) => {
    const amendment = approval.proposedNetworkPolicyAmendments?.[index];
    if (!amendment) return;
    void pendingApprovalsRespond({
      path: { requestId: String(approval.requestId) },
      body: { result: { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } } } },
    })
      .then(() => resolveApproval(approval.requestId, 'accepted'))
      .catch(() => undefined);
  };

  const isPending = approval.status === 'pending';
  const isAccepted = approval.status === 'accepted' || approval.status === 'acceptedForSession';
  const isDeclined = approval.status === 'declined';
  const isCancelled = approval.status === 'cancelled';
  const isResolved = approval.status === 'resolved';

  const Icon = approval.kind === 'fileChange' ? FileCode : Terminal;
  const label =
    approval.kind === 'command'
      ? t('Command Approval')
      : approval.kind === 'writeStdin'
        ? t('Terminal Input Approval')
        : t('File Change Approval');

  // `availableDecisions` is optional. Without it, expose only accept/decline;
  // session-level decisions and amendments require explicit server permission.
  const hasExplicitList = Array.isArray(avail);
  const showAccept = !hasExplicitList || hasSimpleDecision(avail, 'accept');
  const showAcceptForSession = hasSimpleDecision(avail, 'acceptForSession');
  const showDecline = !hasExplicitList || hasSimpleDecision(avail, 'decline');
  const showCancel = hasSimpleDecision(avail, 'cancel');
  const showExec = hasExecAmendment(avail) && Boolean(approval.proposedExecpolicyAmendment?.length);
  const showNetwork = hasNetworkAmendment(avail) && Boolean(approval.proposedNetworkPolicyAmendments?.length);

  return (
    <div
      className={cn(
        'rounded-lg border text-sm',
        isPending && 'border-yellow-500/50 bg-yellow-500/5',
        isAccepted && 'border-green-500/30 bg-green-500/5',
        isDeclined && 'border-red-500/30 bg-red-500/5',
        isCancelled && 'border-orange-500/30 bg-orange-500/5',
        isResolved && 'border-muted bg-muted/5',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <ShieldAlert
          className={cn(
            'h-4 w-4',
            isPending && 'text-yellow-500',
            isAccepted && 'text-green-500',
            isDeclined && 'text-red-500',
            isCancelled && 'text-orange-500',
            isResolved && 'text-muted-foreground',
          )}
        />
        <span className="font-medium">{label}</span>
        {approval.status === 'accepted' && (
          <span className="ml-auto flex items-center gap-1 text-xs text-green-500">
            <Check className="h-3 w-3" /> {t('Accepted')}
          </span>
        )}
        {approval.status === 'acceptedForSession' && (
          <span className="ml-auto flex items-center gap-1 text-xs text-green-500">
            <CheckCheck className="h-3 w-3" /> {t('Accepted for session')}
          </span>
        )}
        {isDeclined && (
          <span className="ml-auto flex items-center gap-1 text-xs text-red-500">
            <X className="h-3 w-3" /> {t('Declined')}
          </span>
        )}
        {isCancelled && (
          <span className="ml-auto flex items-center gap-1 text-xs text-orange-500">
            <Ban className="h-3 w-3" /> {t('Cancelled')}
          </span>
        )}
        {isResolved && (
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            <CheckCircle className="h-3 w-3" /> {t('Resolved')}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="space-y-2 px-3 py-2">
        {approval.command && (
          <div className="flex items-start gap-2 rounded bg-muted/60 px-2 py-1.5 font-mono text-xs">
            <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="break-all">{approval.command}</span>
          </div>
        )}

        {approval.reason && (
          <p className="text-xs text-muted-foreground">{approval.reason}</p>
        )}

        {approval.grantRoot && (
          <p className="text-xs text-muted-foreground">
            {t('Requesting write access to:')}{' '}
            <code className="rounded bg-muted px-1">{approval.grantRoot}</code>
          </p>
        )}

        {approval.cwd && (
          <p className="text-xs text-muted-foreground">
            {t('cwd:')}{' '}
            <code className="rounded bg-muted px-1">{approval.cwd}</code>
          </p>
        )}

        {/* Action buttons */}
        {isPending && (
          <div className="space-y-2 pt-1">
            <div className="flex flex-wrap gap-2">
              {showAccept && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-green-500/50 text-green-500 hover:bg-green-500/10"
                  onClick={() => handleDecision('accepted')}
                >
                  <Check className="mr-1 h-3 w-3" />
                  {t('Accept')}
                </Button>
              )}
              {showAcceptForSession && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-green-500/30 text-green-600 hover:bg-green-500/10"
                  onClick={() => handleDecision('acceptedForSession')}
                >
                  <CheckCheck className="mr-1 h-3 w-3" />
                  {t('Accept for session')}
                </Button>
              )}
              {showDecline && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-red-500/50 text-red-500 hover:bg-red-500/10"
                  onClick={() => handleDecision('declined')}
                >
                  <X className="mr-1 h-3 w-3" />
                  {t('Decline')}
                </Button>
              )}
              {showCancel && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 border-orange-500/50 text-orange-500 hover:bg-orange-500/10"
                  onClick={() => handleDecision('cancelled')}
                >
                  <Ban className="mr-1 h-3 w-3" />
                  {t('Cancel')}
                </Button>
              )}
            </div>

            {/* Server-proposed exec policy amendment */}
            {showExec && (
              <div className="space-y-1 rounded border border-border bg-muted/30 p-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Shield className="h-3 w-3" />
                  {t('Allow similar commands:')}
                </div>
                <div className="space-y-0.5">
                  {approval.proposedExecpolicyAmendment!.map((pattern, i) => (
                    <code key={i} className="block rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {pattern}
                    </code>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 border-green-500/30 text-xs text-green-600 hover:bg-green-500/10"
                  onClick={handleExecAmendment}
                >
                  <Shield className="mr-1 h-3 w-3" />
                  {t('Accept with exec policy')}
                </Button>
              </div>
            )}

            {/* Server-proposed network policy amendments */}
            {showNetwork && (
              <div className="space-y-1 rounded border border-border bg-muted/30 p-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Globe className="h-3 w-3" />
                  {t('Network access rules:')}
                </div>
                {approval.proposedNetworkPolicyAmendments!.map((amendment, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <code className="flex-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {amendment.action === 'allow' ? '✓' : '✗'} {amendment.host}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      onClick={() => handleNetworkAmendment(i)}
                    >
                      {t('Apply')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
