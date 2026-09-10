/**
 * Renders one timeline entry — user message, system notice, turn failure, or
 * assistant turn — plus the per-message controls that hang off a user message.
 */
import { Pencil } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { MessageVersions } from '@/hooks/use-message-branches';
import type { TimelineEntry } from '@/types/timeline';
import { MessageVersionSwitcher } from './message-version-switcher';
import { TurnBlock } from './turn-block';
import { UserMessageBubble } from './user-message-bubble';
import { TurnFailureCard } from './turn-failure-card';

/** Renders a single timeline entry (user message, system message, or turn block). */
export function TimelineEntryRow({
  entry,
  threadCwd,
  threadId,
  canBranch,
  versionsByTurnId,
  deleteBlockedReason,
  deletingThreadIds,
  onDeleteVersion,
  onEdit,
  t,
}: {
  entry: TimelineEntry;
  threadCwd: string | null;
  threadId: string | null;
  canBranch: boolean;
  versionsByTurnId: Map<string, MessageVersions>;
  deleteBlockedReason: string | null;
  deletingThreadIds: ReadonlySet<string>;
  onDeleteVersion: (threadId: string, siblingThreadIds: string[]) => void;
  onEdit: (target: { turnId: string; content: string }) => void;
  t: (key: string) => string;
}) {
  if (entry.kind === 'user') {
    const turnId = entry.turnId;
    const versions = turnId ? versionsByTurnId.get(turnId) : undefined;
    return (
      <div className="group/user flex flex-col items-end">
        {/* A neutral tint, not an accent colour: the user's own message is the
            one thing on screen they never need drawing to, and a saturated block
            was the only high-chroma surface in an otherwise neutral palette.
            Side and alignment already say who wrote it. */}
        <div className="max-w-2xl overflow-hidden rounded-2xl border border-border/60 bg-muted px-4 py-3 text-foreground [&_a]:underline">
          <UserMessageBubble
            content={entry.content}
            threadCwd={threadCwd}
            threadId={threadId}
            images={entry.images}
          />
        </div>
        {/* Reserved even when empty so revealing the controls cannot shift layout. */}
        <div className="mt-1 flex h-6 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/user:opacity-100">
          {versions && (
            <MessageVersionSwitcher
              versions={versions}
              deleteBlockedReason={deleteBlockedReason}
              deletingThreadIds={deletingThreadIds}
              onDeleteVersion={onDeleteVersion}
            />
          )}
          {/* Rendered whenever the message has a turn, disabled rather than
              removed — dropping it mid-switch would move the version switcher. */}
          {turnId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t('Edit this message')}
                  disabled={!canBranch}
                  className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  onClick={() => onEdit({ turnId, content: entry.content })}
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('Edit this message')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    );
  }

  if (entry.kind === 'system') {
    const severity = entry.severity ?? 'error';
    const colorMap = {
      info: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
      warning: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
      error: 'bg-destructive/10 text-destructive',
    } as const;
    return (
      <div className="text-center">
        <span className={`inline-block rounded-lg px-3 py-1.5 text-sm ${colorMap[severity]}`}>
          {entry.content}
        </span>
      </div>
    );
  }

  if (entry.kind === 'turnFailure') {
    return <TurnFailureCard failure={entry.failure} />;
  }

  return <TurnBlock entry={entry} />;
}
