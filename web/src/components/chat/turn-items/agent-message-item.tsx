import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TurnItem } from '@/types/timeline';
import { resolveFileReferencePath, type FileReference } from '@/lib/file-references';
import { requestOpenFile } from '@/lib/open-file-request';
import { showSnackbar } from '@/stores/snackbar-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { MarkdownRenderer } from '../markdown-renderer';

interface Props {
  item: Extract<TurnItem, { type: 'agentMessage' }>;
}

export function AgentMessageItem({ item }: Props) {
  const { t } = useTranslation();
  // Resolution is bound here rather than inside the renderer: this component is
  // the lowest one that already belongs to a specific conversation, so the
  // renderer stays free of stores, routing and working directories, and no
  // callback has to be threaded down through the turn-rendering chain.
  const threadId = useTimelineStore((s) => s.threadId);
  const threadCwd = useTimelineStore((s) => s.threadCwd);

  const handleOpenFileReference = useCallback(
    (reference: FileReference) => {
      const absolutePath = resolveFileReferencePath(reference.path, threadCwd);
      if (!absolutePath) {
        // A relative path with no conversation directory has no honest
        // resolution; guessing one would open some unrelated file.
        showSnackbar(t('Cannot resolve this path: the conversation has no directory'), 'error');
        return;
      }
      requestOpenFile({
        path: absolutePath,
        line: reference.line,
        sourceThreadId: threadId,
      });
    },
    [threadCwd, threadId, t],
  );

  return (
    <div>
      <MarkdownRenderer
        content={item.content}
        completed={item.completed}
        onOpenFileReference={handleOpenFileReference}
      />
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
