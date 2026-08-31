import type { TurnItem } from '@/types/timeline';
import { MarkdownRenderer } from '../markdown-renderer';

interface Props {
  item: Extract<TurnItem, { type: 'agentMessage' }>;
}

export function AgentMessageItem({ item }: Props) {
  return (
    <div>
      <MarkdownRenderer content={item.content} completed={item.completed} />
    </div>
  );
}
