import type { TurnItem } from '@/types/timeline';
import { MarkdownRenderer } from '../markdown-renderer';

interface Props {
  item: Extract<TurnItem, { type: 'agentMessage' }>;
}

export function AgentMessageItem({ item }: Props) {
  return (
    <div>
      <MarkdownRenderer content={item.content} completed={item.completed} />
      {item.questions.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 border-border pl-3 text-sm">
          {item.questions.map((question, questionIndex) => (
            <div key={`${question.title}-${questionIndex}`}>
              <div className="font-medium">{question.title}</div>
              {question.options && question.options.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {question.options.map((option, optionIndex) => (
                    <span
                      className="rounded-md border border-border bg-muted px-2 py-1 text-muted-foreground"
                      key={`${option}-${optionIndex}`}
                    >
                      {option}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
