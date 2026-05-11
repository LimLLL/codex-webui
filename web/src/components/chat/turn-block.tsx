/**
 * Renders a single AI turn as a unified block.
 * Contains all items (reasoning, tool calls, messages) under one avatar.
 */
import { Bot, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import type { TimelineEntry, TurnItem } from '@/types/timeline';
import { ReasoningItem } from './turn-items/reasoning-item';
import { AgentMessageItem } from './turn-items/agent-message-item';
import { ToolCallItem } from './turn-items/tool-call-item';
import { CommandItem } from './turn-items/command-item';
import { FileChangeItem } from './turn-items/file-change-item';
import { DiffViewer } from './turn-items/diff-viewer';
import { ApprovalItem } from './turn-items/approval-item';
import { useTimelineStore } from '@/stores/timeline-store';

const entryVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 400, damping: 30 },
  },
};

interface Props {
  entry: Extract<TimelineEntry, { kind: 'turn' }>;
}

/** Renders a single turn item with its approval card (if any). */
function ItemWithApproval({ item }: { item: TurnItem }) {
  const approval = useTimelineStore((s) => s.approvals[item.itemId]);

  const rendered = (() => {
    switch (item.type) {
      case 'reasoning':
        return <ReasoningItem item={item} />;
      case 'agentMessage':
        return <AgentMessageItem item={item} />;
      case 'mcpToolCall':
        return <ToolCallItem item={item} />;
      case 'commandExecution':
        return <CommandItem item={item} />;
      case 'fileChange':
        return <FileChangeItem item={item} />;
    }
  })();

  return (
    <>
      {rendered}
      {approval && <ApprovalItem approval={approval} />}
    </>
  );
}

export function TurnBlock({ entry }: Props) {
  return (
    <motion.div
      variants={entryVariants}
      initial="hidden"
      animate="visible"
      className="mb-6 flex gap-3"
    >
      <Avatar className="mt-1 h-8 w-8 shrink-0">
        <AvatarFallback className="bg-muted">
          <Bot className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1 space-y-2">
        {entry.items.map((item) => (
          <ItemWithApproval key={item.itemId} item={item} />
        ))}

        {entry.diff && <DiffViewer diff={entry.diff} />}

        {!entry.completed && entry.items.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Thinking...
          </div>
        )}
      </div>
    </motion.div>
  );
}
