/**
 * Renders a single AI turn as a unified block.
 * Contains all items (reasoning, tool calls, messages) under one avatar.
 */
import { Bot, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import type { TimelineEntry, TurnItem } from '@/types/timeline';
import { ReasoningItem } from './turn-items/reasoning-item';
import { AgentMessageItem } from './turn-items/agent-message-item';
import { ToolCallItem } from './turn-items/tool-call-item';
import { CommandItem } from './turn-items/command-item';
import { FileChangeItem } from './turn-items/file-change-item';
import { DiffViewer } from './turn-items/diff-viewer';
import { ApprovalItem } from './turn-items/approval-item';
import { UserInputCard } from './turn-items/user-input-card';
import { TurnTokenFooter } from './turn-token-footer';
import { PlanPanel } from './plan-panel';
import { useTimelineStore } from '@/stores/timeline-store';

interface Props {
  entry: Extract<TimelineEntry, { kind: 'turn' }>;
}

/** Renders a single turn item with its blocking request cards (approval / user input). */
function ItemWithRequests({ item }: { item: TurnItem }) {
  const approval = useTimelineStore((s) => s.approvals[item.itemId]);
  // userInputRequests keyed by requestId — find matching entry by itemId.
  const userInputRequest = useTimelineStore((s) => {
    const match = Object.values(s.userInputRequests).filter(
      (req) => req.itemId === item.itemId,
    );
    return match.find((req) => req.status === 'pending') ?? match[0] ?? null;
  });

  const inputCard = userInputRequest ? (
    <UserInputCard key={String(userInputRequest.requestId)} request={userInputRequest} />
  ) : null;

  switch (item.type) {
    case 'reasoning':
      return (
        <>
          <ReasoningItem item={item} />
          {inputCard}
        </>
      );
    case 'agentMessage':
      return (
        <>
          <AgentMessageItem item={item} />
          {inputCard}
        </>
      );
    case 'mcpToolCall':
      return (
        <>
          <ToolCallItem item={item} />
          {inputCard}
        </>
      );
    case 'commandExecution':
      return (
        <>
          <CommandItem item={item} />
          {approval && <ApprovalItem approval={approval} />}
          {inputCard}
        </>
      );
    case 'fileChange':
      return (
        <>
          <FileChangeItem item={item} approval={approval} />
          {inputCard}
        </>
      );
  }
}

export function TurnBlock({ entry }: Props) {
  const { t } = useTranslation();
  const userInputRequests = useTimelineStore((s) => s.userInputRequests);
  // Render user-input requests whose itemId doesn't match any existing turn item.
  const itemIds = new Set(entry.items.map((item) => item.itemId));
  const unattachedInputs = Object.values(userInputRequests).filter(
    (req) => req.turnId === entry.turnId && !itemIds.has(req.itemId),
  );

  return (
    <div className="mb-6 flex gap-3">
      <Avatar className="mt-1 h-8 w-8 shrink-0">
        <AvatarFallback className="glass-1 bg-transparent">
          <Bot className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>

      <div className="glass-1 min-w-0 flex-1 space-y-2 rounded-2xl px-4 py-3">
        {entry.plan && <PlanPanel plan={entry.plan} completed={entry.completed} />}

        {entry.items.map((item) => (
          <ItemWithRequests key={item.itemId} item={item} />
        ))}

        {unattachedInputs.map((req) => (
          <UserInputCard key={String(req.requestId)} request={req} />
        ))}

        {entry.diff && <DiffViewer diff={entry.diff} />}

        {entry.completed && <TurnTokenFooter turnId={entry.turnId} />}

        {!entry.completed && entry.items.length === 0 && !entry.plan && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('Thinking...')}
          </div>
        )}
      </div>
    </div>
  );
}
