import type { TurnItem } from '@/types/timeline';
import { MarkdownRenderer } from '../markdown-renderer';

interface Props {
  item: TurnItem;
}

export function AgentMessageItem({ item }: Props) {
  return (
    <div>
      <MarkdownRenderer content={item.content} completed={item.completed} />
    </div>
  );
}
