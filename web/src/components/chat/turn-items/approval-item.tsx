/**
 * Self-contained approval card, used when no host item in this turn shows the
 * action being authorized.
 *
 * This is the exception, not the default. A command approval whose execution
 * item is in the same turn renders inside that item instead, so the command is
 * drawn once. Three cases still need a card of their own:
 *
 *  - A terminal-stdin approval references the item id of the command that
 *    opened the terminal, which may belong to an earlier turn. The request
 *    belongs to the current turn, so it has no host here.
 *  - A network-only approval carries no command or cwd at all; its host and
 *    protocol are the entire authorization subject.
 *  - A file approval for a conversation whose item stream this client never
 *    received. Attention is delivered to every authenticated browser, not only
 *    to the ones watching that transcript, so the host item may simply not
 *    exist here. The card then carries the backend's retained change set.
 */
import { AlertTriangle, FileCode, ShieldAlert, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ApprovalRequest } from '@/types/approval';
import { cn } from '@/lib/utils';
import {
  ApprovalControls,
  ApprovalDetails,
  ApprovalStatusBadge,
} from './approval-controls';
import { NetworkSubject } from './command-item';
import { summarizeChangeSet } from '@/lib/file-change-stats';
import { FileChangeSet } from './file-change-set';

interface Props {
  approval: ApprovalRequest;
}

export function ApprovalItem({ approval }: Props) {
  const { t } = useTranslation();

  const isPending = approval.status === 'pending';
  const isAccepted =
    approval.status === 'accepted' || approval.status === 'acceptedForSession';
  const isDeclined = approval.status === 'declined';
  const isCancelled = approval.status === 'cancelled';

  const Icon = approval.kind === 'fileChange' ? FileCode : Terminal;
  const label =
    approval.kind === 'command'
      ? t('Command Approval')
      : approval.kind === 'writeStdin'
        ? t('Terminal Input Approval')
        : t('File Change Approval');

  const changes = approval.reviewChanges;
  // `null` on a file approval is a distinct, actionable state, not "nothing to
  // draw": the backend is telling us the changes exist and could not be
  // retained. Saying so is the only honest card — the alternative is an Accept
  // button over a blank body.
  const subjectUnavailable = approval.kind === 'fileChange' && !changes?.length;
  const stats = changes ? summarizeChangeSet(changes) : null;

  return (
    <div
      className={cn(
        'rounded-lg border text-sm',
        isPending && 'border-yellow-500/50 bg-yellow-500/5',
        isAccepted && 'border-green-500/30 bg-green-500/5',
        isDeclined && 'border-red-500/30 bg-red-500/5',
        isCancelled && 'border-orange-500/30 bg-orange-500/5',
        approval.status === 'resolved' && 'border-muted bg-muted/5',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <ShieldAlert
          className={cn(
            'h-4 w-4',
            isPending && 'text-yellow-500',
            isAccepted && 'text-green-500',
            isDeclined && 'text-red-500',
            isCancelled && 'text-orange-500',
            approval.status === 'resolved' && 'text-muted-foreground',
          )}
        />
        <span className="font-medium">{label}</span>
        {changes && changes.length > 0 && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {changes.length > 1
              ? t('{{count}} files', { count: changes.length })
              : changes[0].path}
          </span>
        )}
        {stats?.hasDiff && (
          <>
            {stats.additions > 0 && (
              <span className="shrink-0 text-xs text-green-400">
                +{stats.additions}
              </span>
            )}
            {stats.deletions > 0 && (
              <span className="shrink-0 text-xs text-red-400">
                -{stats.deletions}
              </span>
            )}
          </>
        )}
        <span className="ml-auto">
          <ApprovalStatusBadge approval={approval} />
        </span>
      </div>

      <div className="space-y-2 px-3 py-2">
        {/* No host item is showing this command, so the card must. */}
        {approval.command && (
          <div className="flex items-start gap-2 rounded bg-muted/60 px-2 py-1.5 font-mono text-xs">
            <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
            {/* Whitespace is preserved: an approval body that collapses
                newlines misrepresents a multi-line script being authorized. */}
            <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-all font-mono">
              {approval.command}
            </pre>
          </div>
        )}

        <NetworkSubject approval={approval} />
        <ApprovalDetails approval={approval} />

        {subjectUnavailable && (
          <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span className="text-muted-foreground">
              {t(
                'The proposed changes could not be retrieved, so they cannot be shown here.',
              )}
              {/* The advice is only advice while there is still a decision to
                  make. Telling someone to decline a request they already
                  answered reads as though their answer had not registered. */}
              {isPending &&
                ` ${t('Declining is the only safe answer; the agent can propose them again.')}`}
            </span>
          </div>
        )}

        <ApprovalControls approval={approval} />
      </div>

      {/* The whole change set, drawn by the card because no item is doing it. */}
      {changes && changes.length > 0 && <FileChangeSet changes={changes} settled alwaysLabelPaths />}
    </div>
  );
}
