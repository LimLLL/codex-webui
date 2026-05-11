/**
 * Renders an approval request card for command execution or file change.
 * Shows the command/reason and Accept/Decline buttons when pending.
 */
import { ShieldAlert, Check, X, Terminal, FileCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSocket } from '@/socket';
import { useTimelineStore } from '@/stores/timeline-store';
import type { ApprovalRequest } from '@/types/approval';
import { cn } from '@/lib/utils';

interface Props {
  approval: ApprovalRequest;
}

export function ApprovalItem({ approval }: Props) {
  const resolveApproval = useTimelineStore((s) => s.resolveApproval);

  const handleDecision = (decision: 'accepted' | 'declined') => {
    const socket = getSocket();
    const responseDecision = decision === 'accepted' ? 'accept' : 'decline';
    socket.emit('codex.serverResponse', {
      id: approval.requestId,
      result: { decision: responseDecision },
    });
    resolveApproval(approval.itemId, decision);
  };

  const isPending = approval.status === 'pending';
  const isAccepted = approval.status === 'accepted';
  const isDeclined = approval.status === 'declined';

  const Icon = approval.kind === 'commandExecution' ? Terminal : FileCode;
  const label =
    approval.kind === 'commandExecution'
      ? 'Command Approval'
      : 'File Change Approval';

  return (
    <div
      className={cn(
        'rounded-lg border text-sm',
        isPending && 'border-yellow-500/50 bg-yellow-500/5',
        isAccepted && 'border-green-500/30 bg-green-500/5',
        isDeclined && 'border-red-500/30 bg-red-500/5',
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
          )}
        />
        <span className="font-medium">{label}</span>
        {isAccepted && (
          <span className="ml-auto flex items-center gap-1 text-xs text-green-500">
            <Check className="h-3 w-3" /> Accepted
          </span>
        )}
        {isDeclined && (
          <span className="ml-auto flex items-center gap-1 text-xs text-red-500">
            <X className="h-3 w-3" /> Declined
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
            Requesting write access to:{' '}
            <code className="rounded bg-muted px-1">{approval.grantRoot}</code>
          </p>
        )}

        {approval.cwd && (
          <p className="text-xs text-muted-foreground">
            cwd:{' '}
            <code className="rounded bg-muted px-1">{approval.cwd}</code>
          </p>
        )}

        {/* Action buttons */}
        {isPending && (
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-green-500/50 text-green-500 hover:bg-green-500/10"
              onClick={() => handleDecision('accepted')}
            >
              <Check className="mr-1 h-3 w-3" />
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-red-500/50 text-red-500 hover:bg-red-500/10"
              onClick={() => handleDecision('declined')}
            >
              <X className="mr-1 h-3 w-3" />
              Decline
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
