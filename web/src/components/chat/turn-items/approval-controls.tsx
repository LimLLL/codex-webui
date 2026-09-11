/**
 * The parts of an approval that are not its command text.
 *
 * Split out because a command approval attached to an execution item must not
 * reprint the command that item already shows, while a standalone approval —
 * one with no host item in this turn — still has to. Sharing everything except
 * the command keeps one implementation of the decision controls, the requested
 * permissions and the policy amendments.
 */
import {
  Ban,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  FolderTree,
  Globe,
  Shield,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type {
  ApprovalRequest,
  RawCommandDecision,
  RequestedFileSystemAccess,
  ResolvableApprovalDecision,
} from '@/types/approval';
import { cn } from '@/lib/utils';
import { useApprovalDecision } from '@/hooks/use-approval-decision';

/** Natural-language keys for the choice this browser submitted. */
const DECISION_LABELS: Record<ResolvableApprovalDecision, string> = {
  accepted: 'Accepted',
  acceptedForSession: 'Accepted for session',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

function hasSimpleDecision(
  decisions: RawCommandDecision[] | null | undefined,
  key: string,
): boolean {
  return decisions?.some((d) => d === key) ?? false;
}

function hasAmendment(
  decisions: RawCommandDecision[] | null | undefined,
  key: string,
): boolean {
  return decisions?.some((d) => typeof d === 'object' && key in d) ?? false;
}

/**
 * Human label for how a requested filesystem path was expressed.
 *
 * A special scope shows its protocol tag rather than the generic word: `root`
 * and `tmpdir` authorize very different things, and collapsing both to
 * "special" would hide the difference behind an identical badge.
 */
function accessLabel(entry: RequestedFileSystemAccess, t: (key: string) => string): string {
  const scope =
    entry.kind === 'glob'
      ? t('pattern')
      : entry.kind === 'special'
        ? (entry.scope ?? t('special'))
        : t('path');
  return `${t(entry.access)} · ${scope}`;
}

/**
 * Text shown for one requested scope.
 *
 * Most special scopes name a location by themselves and carry no sub-path, so
 * an empty cell would read as though the request named nothing at all.
 */
function accessValue(entry: RequestedFileSystemAccess): string {
  if (entry.value) return entry.value;
  return entry.kind === 'special' ? `(${entry.scope ?? 'special'})` : '';
}

/**
 * Non-command context: why, where, and what extra access is being requested.
 *
 * Rendered for both attached and standalone approvals. Requested permissions
 * are the one thing the execution item structurally cannot show — it reports
 * what will run, not what the run is asking to be allowed to reach.
 */
export function ApprovalDetails({ approval }: { approval: ApprovalRequest }) {
  const { t } = useTranslation();
  const permissions = approval.requestedPermissions;

  return (
    <>
      {approval.negativeOnlyReason && <p role="alert" className="text-xs text-amber-600">{t(approval.negativeOnlyReason)}</p>}
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
          {t('cwd:')} <code className="rounded bg-muted px-1">{approval.cwd}</code>
        </p>
      )}

      {permissions && (
        <div className="space-y-1 rounded border border-amber-500/30 bg-amber-500/5 p-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-500">
            <Shield className="h-3 w-3" />
            {t('Requesting additional access:')}
          </div>
          {/* Tri-state on purpose: an omitted value means the request said
              nothing about network access, which is not the same as "no
              network" and must not be shown as though it were. */}
          {permissions.networkEnabled !== null && (
            <div className="flex items-center gap-1.5 text-xs">
              <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
              {permissions.networkEnabled
                ? t('Network access')
                : t('No network access')}
            </div>
          )}
          {permissions.fileSystem.map((entry, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs">
              <FolderTree className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <code className="min-w-0 flex-1 break-all">{accessValue(entry)}</code>
              <span
                className={cn(
                  'shrink-0 rounded px-1 text-[10px]',
                  entry.access === 'deny'
                    ? 'bg-red-500/15 text-red-500'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {accessLabel(entry, t)}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Decision buttons plus the server's proposed policy amendments.
 *
 * Renders nothing once the request is answered: a resolved approval keeps its
 * context but must not keep offering choices.
 */
export function ApprovalControls({ approval }: { approval: ApprovalRequest }) {
  const { t } = useTranslation();
  const [amendmentsOpen, setAmendmentsOpen] = useState(false);
  const { decide, acceptWithExecPolicy, applyNetworkAmendment, submitting } =
    useApprovalDecision(approval);

  if (approval.status !== 'pending') return null;

  const avail = approval.availableDecisions;
  // `availableDecisions` is optional. Without it, expose only accept/decline;
  // session-level decisions and amendments require explicit server permission.
  const explicit = Array.isArray(avail);
  // A file approval whose change set could not be retained is answerable but
  // not approvable. The backend refuses anything but decline/cancel with a 409,
  // so offering Accept here would only produce a button that always fails —
  // and, worse, one that reads as though approving unseen writes were allowed.
  const canApprove = !approval.negativeOnlyReason && !(
    approval.kind === 'fileChange' && !approval.reviewChanges?.length
  );
  const showAccept = canApprove && (!explicit || hasSimpleDecision(avail, 'accept'));
  const showAcceptForSession =
    canApprove && hasSimpleDecision(avail, 'acceptForSession');
  const showDecline = !canApprove || !explicit || hasSimpleDecision(avail, 'decline');
  // Cancel is normally opt-in, but with no subject it is the other half of the
  // only answer left; without it a request the server permits only to cancel
  // could have no button at all.
  const showCancel = hasSimpleDecision(avail, 'cancel') || !canApprove;
  const showExec =
    canApprove &&
    hasAmendment(avail, 'acceptWithExecpolicyAmendment') &&
    Boolean(approval.proposedExecpolicyAmendment?.length);
  const showNetwork =
    canApprove &&
    hasAmendment(avail, 'applyNetworkPolicyAmendment') &&
    Boolean(approval.proposedNetworkPolicyAmendments?.length);

  return (
    <div className="space-y-2 pt-1">
      <div className="flex flex-wrap gap-2">
        {showAccept && (
          <Button
            disabled={submitting}
            size="sm"
            variant="outline"
            className="h-7 border-green-500/50 text-green-500 hover:bg-green-500/10"
            onClick={() => decide('accepted')}
          >
            <Check className="mr-1 h-3 w-3" />
            {t('Accept')}
          </Button>
        )}
        {showAcceptForSession && (
          <Button
            disabled={submitting}
            size="sm"
            variant="outline"
            className="h-7 border-green-500/30 text-green-600 hover:bg-green-500/10"
            onClick={() => decide('acceptedForSession')}
          >
            <CheckCheck className="mr-1 h-3 w-3" />
            {t('Accept for session')}
          </Button>
        )}
        {showDecline && (
          <Button
            disabled={submitting}
            size="sm"
            variant="outline"
            className="h-7 border-red-500/50 text-red-500 hover:bg-red-500/10"
            onClick={() => decide('declined')}
          >
            <X className="mr-1 h-3 w-3" />
            {t('Decline')}
          </Button>
        )}
        {showCancel && (
          <Button
            disabled={submitting}
            size="sm"
            variant="outline"
            className="h-7 border-orange-500/50 text-orange-500 hover:bg-orange-500/10"
            onClick={() => decide('cancelled')}
          >
            <Ban className="mr-1 h-3 w-3" />
            {t('Cancel')}
          </Button>
        )}
      </div>

      {/* An amendment authorizes FUTURE matching commands, so it is a wider
          decision than this one request. It sits behind a disclosure to stop it
          competing with the immediate choice — but the exact proposed scope is
          always visible before the button that accepts it. */}
      {(showExec || showNetwork) && (
        <div className="rounded border border-border bg-muted/30">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs text-muted-foreground"
            onClick={() => setAmendmentsOpen((v) => !v)}
          >
            {amendmentsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <Shield className="h-3 w-3" />
            {t('Also change policy for future commands')}
          </button>

          {amendmentsOpen && (
            <div className="space-y-2 border-t border-border/50 p-2">
              {showExec && (
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">
                    {t('Allow similar commands:')}
                  </div>
                  {approval.proposedExecpolicyAmendment!.map((pattern, i) => (
                    <code
                      key={i}
                      className="block rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                    >
                      {pattern}
                    </code>
                  ))}
                  <Button
                    disabled={submitting}
                    size="sm"
                    variant="outline"
                    className="h-6 border-green-500/30 text-xs text-green-600 hover:bg-green-500/10"
                    onClick={acceptWithExecPolicy}
                  >
                    <Shield className="mr-1 h-3 w-3" />
                    {t('Accept with exec policy')}
                  </Button>
                </div>
              )}

              {showNetwork && (
                <div className="space-y-1">
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
                        disabled={submitting}
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        onClick={() => applyNetworkAmendment(i)}
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
      )}
    </div>
  );
}

/**
 * Compact outcome badge for an answered request.
 *
 * `resolved` stays deliberately neutral: app-server also resolves requests
 * during lifecycle cleanup on turn start, completion and interrupt, so it does
 * not mean the user accepted anything. `approval.decision` is the separate,
 * certain half — what this browser submitted — so an answered card still says
 * which choice was made without claiming the action was carried out.
 */
export function ApprovalStatusBadge({ approval }: { approval: ApprovalRequest }) {
  const { t } = useTranslation();
  const submitting = approval.status === 'submitted';
  const failed = approval.status === 'failed';
  if (approval.decision && (submitting || failed || approval.status === 'resolved'))
    return (
      <span className={cn('flex items-center gap-1 text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}>
        {t(DECISION_LABELS[approval.decision])}
        {submitting && ` · ${t('Decision submitted')}`}
        {failed && ` · ${t('Delivery unconfirmed')}`}
      </span>
    );
  switch (approval.status) {
    case 'submitted':
      return <span className="text-xs text-muted-foreground">{t('Decision submitted')}</span>;
    case 'failed':
      return <span className="text-xs text-destructive">{t('Delivery unconfirmed')}</span>;
    case 'accepted':
      return (
        <span className="flex items-center gap-1 text-xs text-green-500">
          <Check className="h-3 w-3" /> {t('Accepted')}
        </span>
      );
    case 'acceptedForSession':
      return (
        <span className="flex items-center gap-1 text-xs text-green-500">
          <CheckCheck className="h-3 w-3" /> {t('Accepted for session')}
        </span>
      );
    case 'declined':
      return (
        <span className="flex items-center gap-1 text-xs text-red-500">
          <X className="h-3 w-3" /> {t('Declined')}
        </span>
      );
    case 'cancelled':
      return (
        <span className="flex items-center gap-1 text-xs text-orange-500">
          <Ban className="h-3 w-3" /> {t('Cancelled')}
        </span>
      );
    case 'resolved':
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {t('No longer awaiting a decision')}
        </span>
      );
    case 'pending':
      return (
        <span className="flex items-center gap-1 text-xs text-yellow-500">
          {t('Awaiting approval')}
        </span>
      );
  }
}
