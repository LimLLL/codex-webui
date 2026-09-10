/**
 * Self-contained approval card, used when no host item in this turn shows the
 * action being authorized.
 *
 * This is the exception, not the default. A command approval whose execution
 * item is in the same turn renders inside that item instead, so the command is
 * drawn once. Two cases still need a card of their own:
 *
 *  - A terminal-stdin approval references the item id of the command that
 *    opened the terminal, which may belong to an earlier turn. The request
 *    belongs to the current turn, so it has no host here.
 *  - A network-only approval carries no command or cwd at all; its host and
 *    protocol are the entire authorization subject.
 */
import { FileCode, ShieldAlert, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ApprovalRequest } from '@/types/approval';
import { cn } from '@/lib/utils';
import {
  ApprovalControls,
  ApprovalDetails,
  ApprovalStatusBadge,
} from './approval-controls';
import { NetworkSubject } from './command-item';

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
        <ApprovalControls approval={approval} />
      </div>
    </div>
  );
}
