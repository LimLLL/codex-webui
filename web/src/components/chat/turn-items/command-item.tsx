/**
 * Renders a command execution item and any approvals attached to it.
 *
 * Approvals are drawn inside this card rather than beside it. A sibling card
 * reprinted the whole command a second time, and its policy-amendment section a
 * third, which is noise — but the rule is narrower than "the approval region
 * never shows a command". It shows one when what it authorizes differs from
 * what this card displays: a shell-bridge subcommand and a terminal-stdin write
 * are different actions, and the user must be shown the thing they are actually
 * approving.
 *
 * Long commands are collapsible — never truncated for safety.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ApprovalRequest } from '@/types/approval';
import type { TurnItem } from '@/types/timeline';
import { cn } from '@/lib/utils';
import {
  ApprovalControls,
  ApprovalDetails,
  ApprovalStatusBadge,
} from './approval-controls';

interface Props {
  item: Extract<TurnItem, { type: 'commandExecution' }>;
  /**
   * Approvals whose item id is this command's.
   *
   * A list rather than one: shell-bridge subcommands and stdin callbacks can
   * share an item id, and each request is answered independently.
   */
  approvals?: ApprovalRequest[];
}

/** Threshold (in chars) above which the command is collapsed by default. */
const COLLAPSE_THRESHOLD = 200;

export function CommandItem({ item, approvals = [] }: Props) {
  const { t } = useTranslation();
  const fullCommand = item.command ? stripShellWrapper(item.command) : undefined;
  const isLong = (fullCommand?.length ?? 0) > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);

  const pending = approvals.filter((a) => a.status === 'pending');
  // Never ask someone to authorize a command they cannot see. A long command
  // collapses by default, and an approval can arrive after that state settled.
  const forceExpanded = expanded || pending.length > 0;

  /** First logical line for the collapsed preview. */
  const previewLine = fullCommand?.split('\n')[0] ?? '';

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border font-mono',
        pending.length > 0
          ? 'border-yellow-500/50 bg-yellow-500/5'
          : 'border-border/50 bg-muted/40',
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
        <Terminal className="h-3 w-3" />
        <span>{t('Terminal')}</span>
        <span className="ml-auto flex items-center gap-2">
          {approvals.length > 0 && (
            <ApprovalStatusBadge approval={pending[0] ?? approvals[0]} />
          )}
          {item.exitCode !== undefined && item.completed && (
            <span className={item.exitCode === 0 ? 'text-green-400' : 'text-red-400'}>
              {t('exit')} {item.exitCode}
            </span>
          )}
          {!item.completed && <Loader2 className="h-3 w-3 animate-spin" />}
        </span>
      </div>

      {fullCommand && (
        <div className="border-b border-border/30 bg-muted/60 px-3 py-1.5 text-xs text-foreground/80">
          {isLong && pending.length === 0 ? (
            <button
              type="button"
              className="flex w-full items-start gap-1 text-left"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="mr-1.5 text-green-400">$</span>
                {expanded ? (
                  <span className="whitespace-pre-wrap break-all">{fullCommand}</span>
                ) : (
                  <span className="break-all">
                    {previewLine}
                    <span className="ml-1 text-muted-foreground">...</span>
                  </span>
                )}
              </span>
            </button>
          ) : (
            <>
              <span className="mr-1.5 text-green-400">$</span>
              <span className={forceExpanded ? 'whitespace-pre-wrap break-all' : 'break-all'}>
                {fullCommand}
              </span>
            </>
          )}
        </div>
      )}

      {item.content && (
        <pre className="m-0 max-h-64 overflow-auto p-3 text-xs leading-relaxed text-muted-foreground">
          {item.content}
        </pre>
      )}

      {approvals.map((approval) => (
        <AttachedApproval key={String(approval.requestId)} approval={approval} hostCommand={item.command} />
      ))}
    </div>
  );
}

/**
 * One request's section inside the command card.
 *
 * @param hostCommand - The card's RAW command, before display rewriting. The
 *   comparison must use it: the card strips the shell wrapper for readability,
 *   and comparing against that rewritten form would call two different commands
 *   identical.
 */
function AttachedApproval({
  approval,
  hostCommand,
}: {
  approval: ApprovalRequest;
  hostCommand?: string;
}) {
  const { t } = useTranslation();
  // A stdin write is a different kind of action from the command that opened
  // the terminal, so its text is shown even when it happens to look similar.
  const distinct =
    approval.kind === 'writeStdin' ||
    (Boolean(approval.command) && approval.command !== hostCommand);

  return (
    <div className="space-y-2 border-t border-border/50 px-3 py-2 font-sans">
      {approval.status !== 'pending' && (
        <div className="flex items-center gap-2">
          <ApprovalStatusBadge approval={approval} />
        </div>
      )}

      {distinct && approval.command && (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            {approval.kind === 'writeStdin'
              ? t('Input to send to this terminal:')
              : t('Awaiting approval for:')}
          </div>
          <pre className="m-0 overflow-x-auto rounded bg-muted/60 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-all">
            {approval.command}
          </pre>
        </div>
      )}

      {approval.networkContext && (
        <NetworkSubject approval={approval} />
      )}

      <ApprovalDetails approval={approval} />
      <ApprovalControls approval={approval} />
    </div>
  );
}

/** Host and protocol subject for an approval that carries no command. */
export function NetworkSubject({ approval }: { approval: ApprovalRequest }) {
  const { t } = useTranslation();
  if (!approval.networkContext) return null;
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">
        {t('Requesting network access to:')}
      </div>
      <code className="block rounded bg-muted/60 px-2 py-1.5 font-mono text-xs break-all">
        {approval.networkContext.protocol}://{approval.networkContext.host}
      </code>
    </div>
  );
}

/**
 * Strips the shell invocation wrapper added by Codex.
 * e.g. `/bin/zsh -lc "mkdir -p .claude && ..."` → `mkdir -p .claude && ...`
 * Never truncates — returns the full inner command.
 *
 * Display only. Authorization comparisons use the raw command, because two
 * different raw invocations can strip to the same inner text.
 */
function stripShellWrapper(cmd: string): string {
  const match = cmd.match(/^\/bin\/(?:zsh|bash)\s+-\w+\s+"([\s\S]+)"$/);
  return match ? match[1] : cmd;
}
