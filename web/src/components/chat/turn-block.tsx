/**
 * Renders a single AI turn as a unified block.
 * Contains all items (reasoning, tool calls, messages) under one avatar.
 */
import { Bot, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import type { ApprovalRequest } from '@/types/approval';
import type { TimelineEntry, TurnItem } from '@/types/timeline';
import { ReasoningItem } from './turn-items/reasoning-item';
import { AgentMessageItem } from './turn-items/agent-message-item';
import { ToolCallItem } from './turn-items/tool-call-item';
import { CommandItem } from './turn-items/command-item';
import { FileChangeItem } from './turn-items/file-change-item';
import { TurnMarkerItem } from './turn-items/turn-marker-item';
import {
  CollabAgentToolCallItem,
  DynamicToolCallItem,
  FunctionCallOutputItem,
  HookPromptItem,
} from './turn-items/tool-activity-items';
import {
  ImageGenerationItem,
  ImageViewItem,
  SleepItem,
  SubAgentActivityItem,
  UnknownActivityItem,
  WebSearchItem,
} from './turn-items/rich-activity-items';
import { useTurnItemsTopUp } from '@/hooks/use-turn-items-topup';
import { DiffViewer } from './turn-items/diff-viewer';
import { ToolCallGroup } from './turn-items/tool-call-group';
import { ApprovalItem } from './turn-items/approval-item';
import { UserInputCard } from './turn-items/user-input-card';
import { TurnTokenFooter } from './turn-token-footer';
import { PlanPanel } from './plan-panel';
import { useTimelineStore } from '@/stores/timeline-store';

/* ── Grouping consecutive mcpToolCall items ── */

type GroupedEntry =
  | { kind: 'single'; item: TurnItem }
  | {
      kind: 'toolGroup';
      items: Array<Extract<TurnItem, { type: 'mcpToolCall' }>>;
    };

/** Groups consecutive mcpToolCall items so they can be rendered in a collapsible block. */
function groupConsecutiveToolCalls(items: TurnItem[]): GroupedEntry[] {
  const result: GroupedEntry[] = [];
  let buffer: Array<Extract<TurnItem, { type: 'mcpToolCall' }>> = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      result.push({ kind: 'single', item: buffer[0] });
    } else {
      result.push({ kind: 'toolGroup', items: buffer });
    }
    buffer = [];
  };

  for (const item of items) {
    if (item.type === 'mcpToolCall') {
      buffer.push(item);
    } else {
      flush();
      result.push({ kind: 'single', item });
    }
  }
  flush();

  return result;
}

interface Props {
  entry: Extract<TimelineEntry, { kind: 'turn' }>;
}

/** Compile-time exhaustiveness guard for the internal item union. */
function assertNever(value: never): never {
  void value;
  throw new Error('Unhandled normalized turn item');
}

/**
 * Renders a single turn item with its same-turn blocking request cards.
 *
 * Approvals arrive already grouped by item because they are keyed by request
 * id: resolving them per item would rescan the whole map on every item render
 * and re-render every item whenever any approval anywhere changed.
 */
function ItemWithRequests({
  item,
  turnId,
  approvals,
}: {
  item: TurnItem;
  turnId: string;
  approvals: ApprovalRequest[];
}) {
  // userInputRequests keyed by requestId — find matching entry by itemId.
  const userInputRequest = useTimelineStore((s) => {
    const match = Object.values(s.userInputRequests).filter(
      (req) => req.turnId === turnId && req.itemId === item.itemId,
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
          {approvals
            .filter((approval) => approval.kind !== 'fileChange')
            .map((approval) => (
              <ApprovalItem
                key={String(approval.requestId)}
                approval={approval}
              />
            ))}
          {inputCard}
        </>
      );
    case 'fileChange':
      return (
        <>
          <FileChangeItem
            item={item}
            approval={approvals.find(
              (approval) => approval.kind === 'fileChange',
            )}
          />
          {inputCard}
        </>
      );
    case 'contextCompaction':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return (
        <>
          <TurnMarkerItem item={item} />
          {inputCard}
        </>
      );
    case 'hookPrompt':
      return (
        <>
          <HookPromptItem item={item} />
          {inputCard}
        </>
      );
    case 'functionCallOutput':
      return (
        <>
          <FunctionCallOutputItem item={item} />
          {inputCard}
        </>
      );
    case 'dynamicToolCall':
      return (
        <>
          <DynamicToolCallItem item={item} />
          {inputCard}
        </>
      );
    case 'collabAgentToolCall':
      return (
        <>
          <CollabAgentToolCallItem item={item} />
          {inputCard}
        </>
      );
    case 'subAgentActivity':
      return (
        <>
          <SubAgentActivityItem item={item} />
          {inputCard}
        </>
      );
    case 'webSearch':
      return (
        <>
          <WebSearchItem item={item} />
          {inputCard}
        </>
      );
    case 'imageView':
      return (
        <>
          <ImageViewItem item={item} />
          {inputCard}
        </>
      );
    case 'sleep':
      return (
        <>
          <SleepItem item={item} />
          {inputCard}
        </>
      );
    case 'imageGeneration':
      return (
        <>
          <ImageGenerationItem item={item} />
          {inputCard}
        </>
      );
    case 'unknownActivity':
      return (
        <>
          <UnknownActivityItem item={item} />
          {inputCard}
        </>
      );
  }
  return assertNever(item);
}

export function TurnBlock({ entry }: Props) {
  const { t } = useTranslation();
  const userInputRequests = useTimelineStore((s) => s.userInputRequests);
  // Select this turn's approvals, not the whole map: approvals are keyed by
  // request id, so subscribing to the map would rerender every mounted turn
  // whenever any approval anywhere changed.
  const approvals = useTimelineStore(
    useShallow((s) =>
      Object.values(s.approvals).filter(
        (approval) => approval.turnId === entry.turnId,
      ),
    ),
  );
  // History opens in the cheap `summary` view, which withholds reasoning and
  // plan items; a rendered turn fetches its own full items once.
  useTurnItemsTopUp({
    threadId: useTimelineStore((s) => s.threadId),
    turnId: entry.turnId,
    itemsView: entry.itemsView,
    completed: entry.completed,
  });
  // Render user-input requests whose itemId doesn't match any existing turn item.
  const itemIds = new Set(entry.items.map((item) => item.itemId));
  const unattachedInputs = Object.values(userInputRequests).filter(
    (req) => req.turnId === entry.turnId && !itemIds.has(req.itemId),
  );
  // Group this turn's approvals once. One request id can share an itemId with
  // another (zsh-exec-bridge subcommands, stdin callbacks), so an item maps to
  // a list rather than a single card.
  const approvalsByItemId = new Map<string, ApprovalRequest[]>();
  // A writeStdin approval belongs to the current callback turn even though its
  // itemId names the command item from an earlier turn. Render it here without
  // changing the parent command's lifecycle or moving the card backward.
  const unattachedApprovals: ApprovalRequest[] = [];
  for (const approval of approvals) {
    if (!itemIds.has(approval.itemId)) {
      unattachedApprovals.push(approval);
      continue;
    }
    const existing = approvalsByItemId.get(approval.itemId);
    if (existing) existing.push(approval);
    else approvalsByItemId.set(approval.itemId, [approval]);
  }

  // A summary turn holds an entry purely so the top-up above can be mounted,
  // and a turn whose only item was the user message stays empty even after it.
  // Rendering the shell anyway would leave a bare assistant avatar with nothing
  // in it. The hook still ran, so bailing out here does not prevent the fetch.
  const hasContent =
    entry.items.length > 0 ||
    Boolean(entry.plan) ||
    entry.diff !== undefined ||
    unattachedApprovals.length > 0 ||
    unattachedInputs.length > 0;
  if (!hasContent) return null;

  return (
    <div className="mb-6 flex gap-3">
      <Avatar className="mt-1 h-8 w-8 shrink-0">
        <AvatarFallback className="glass-1 bg-transparent">
          <Bot className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>

      <div className="glass-1 min-w-0 flex-1 space-y-2 rounded-2xl px-4 py-3">
        {entry.plan && <PlanPanel plan={entry.plan} completed={entry.completed} />}

        {groupConsecutiveToolCalls(entry.items).map((group) => {
          if (group.kind === 'single') {
            return (
              <ItemWithRequests
                key={group.item.itemId}
                item={group.item}
                turnId={entry.turnId}
                approvals={approvalsByItemId.get(group.item.itemId) ?? []}
              />
            );
          }
          return (
            <ToolCallGroup key={group.items[0].itemId} items={group.items}>
              {group.items.map((item) => (
                <ItemWithRequests
                  key={item.itemId}
                  item={item}
                  turnId={entry.turnId}
                  approvals={approvalsByItemId.get(item.itemId) ?? []}
                />
              ))}
            </ToolCallGroup>
          );
        })}

        {unattachedApprovals.map((approval) => (
          <ApprovalItem
            key={String(approval.requestId)}
            approval={approval}
          />
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
