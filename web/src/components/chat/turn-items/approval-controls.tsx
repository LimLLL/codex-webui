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
import { pendingApprovalsRespond } from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import type {
  ApprovalRequest,
  RawCommandDecision,
  RequestedFileSystemAccess,
  ResolvableApprovalDecision,
} from '@/types/approval';
import { cn } from '@/lib/utils';

/** Maps UI decision to Codex JSON-RPC decision value. */
function toRpcDecision(decision: ResolvableApprovalDecision): string {
  switch (decision) {
    case 'accepted': return 'accept';
    case 'acceptedForSession': return 'acceptForSession';
    case 'declined': return 'decline';
    case 'cancelled': return 'cancel';
  }
}

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
 * Sends decisions for one approval request.
 *
 * The thread and request identity are captured here rather than read at
 * completion time: answering can outlive the conversation staying selected, and
 * resolving against whichever thread happens to be on screen later would mark
 * the wrong card answered.
 */
function useApprovalDecision(approval: ApprovalRequest) {
  const resolveApprovalForThread = useTimelineStore(
    (s) => s.resolveApprovalForThread,
  );
  const { threadId, requestId } = approval;

  const send = (body: { result: { decision: unknown } }, settled: ResolvableApprovalDecision) => {
    // `throwOnError` is required, not decorative. The generated client resolves
    // with `{ data, error }` by default and the app's error interceptor returns
    // the error rather than throwing it, so a rejected write — a 409 from
    // another device answering first, a 503 while the app-server restarts —
    // reached `.then` and marked the card Accepted while the server had done
    // nothing of the sort. A request whose response failed stays unresolved
    // until authoritative evidence arrives.
    void pendingApprovalsRespond({
      path: { requestId: String(requestId) },
      body: body as never,
      throwOnError: true,
    })
      .then(() => resolveApprovalForThread(threadId, requestId, settled))
      .catch(() => undefined);
  };

  return {
    decide: (decision: ResolvableApprovalDecision) =>
      send({ result: { decision: toRpcDecision(decision) } }, decision),
    acceptWithExecPolicy: () => {
      const patterns = approval.proposedExecpolicyAmendment;
      if (!patterns?.length) return;
      send(
        { result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: patterns } } } },
        'accepted',
      );
    },
    applyNetworkAmendment: (index: number) => {
      const amendment = approval.proposedNetworkPolicyAmendments?.[index];
      if (!amendment) return;
      send(
        { result: { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } } } },
        'accepted',
      );
    },
  };
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
  const { decide, acceptWithExecPolicy, applyNetworkAmendment } =
    useApprovalDecision(approval);

  if (approval.status !== 'pending') return null;

  const avail = approval.availableDecisions;
  // `availableDecisions` is optional. Without it, expose only accept/decline;
  // session-level decisions and amendments require explicit server permission.
  const explicit = Array.isArray(avail);
  const showAccept = !explicit || hasSimpleDecision(avail, 'accept');
  const showAcceptForSession = hasSimpleDecision(avail, 'acceptForSession');
  const showDecline = !explicit || hasSimpleDecision(avail, 'decline');
  const showCancel = hasSimpleDecision(avail, 'cancel');
  const showExec =
    hasAmendment(avail, 'acceptWithExecpolicyAmendment') &&
    Boolean(approval.proposedExecpolicyAmendment?.length);
  const showNetwork =
    hasAmendment(avail, 'applyNetworkPolicyAmendment') &&
    Boolean(approval.proposedNetworkPolicyAmendments?.length);

  return (
    <div className="space-y-2 pt-1">
      <div className="flex flex-wrap gap-2">
        {showAccept && (
          <Button
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
 * not mean the user accepted anything.
 */
export function ApprovalStatusBadge({ approval }: { approval: ApprovalRequest }) {
  const { t } = useTranslation();
  switch (approval.status) {
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
