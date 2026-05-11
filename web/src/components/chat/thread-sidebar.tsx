/**
 * Left sidebar with global actions (top) and thread list (bottom).
 */
import { FolderOpen, MessageSquare, Plus, Terminal } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  threadsListThreadsOptions,
  threadsStartThreadMutation,
  threadsResumeThreadMutation,
} from '@/generated/api/@tanstack/react-query.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import { cn } from '@/lib/utils';

import type { GlobalView } from '@/types/views';

interface Props {
  activeView: GlobalView;
  onViewChange: (view: GlobalView) => void;
}

export function ThreadSidebar({ activeView, onViewChange }: Props) {
  const { t } = useTranslation();
  const threadId = useTimelineStore((s) => s.threadId);
  const setActiveThread = useTimelineStore((s) => s.setActiveThread);
  const hydrateTimeline = useTimelineStore((s) => s.hydrateTimeline);
  const addSystemError = useTimelineStore((s) => s.addSystemError);
  const queryClient = useQueryClient();

  const { data: threadList } = useQuery({
    ...threadsListThreadsOptions(),
  });
  const threads = threadList?.data ?? [];

  const createThread = useMutation({
    ...threadsStartThreadMutation(),
    onSuccess: (res) => {
      setActiveThread(res.thread.id, res.cwd);
      void queryClient.invalidateQueries({ queryKey: threadsListThreadsOptions().queryKey });
    },
    onError: (err) => addSystemError(String(err.message)),
  });

  const setLoading = useTimelineStore((s) => s.setLoading);

  const resumeThread = useMutation({
    ...threadsResumeThreadMutation(),
    onSuccess: (res) => {
      hydrateTimeline(res.thread.turns, res.cwd);
    },
    onError: () => {
      setLoading(false);
    },
  });

  const handleSwitchThread = (targetId: string) => {
    if (targetId === threadId) return;
    setActiveThread(targetId);
    setLoading(true);
    resumeThread.mutate({ path: { threadId: targetId } });
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/30">
      {/* Global actions */}
      <div className="space-y-0.5 px-2 py-2">
        <button
          type="button"
          onClick={() => onViewChange('files')}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
            activeView === 'files'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <FolderOpen className="h-4 w-4 shrink-0" />
          {t('Files')}
        </button>
        <button
          type="button"
          onClick={() => onViewChange('terminal')}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
            activeView === 'terminal'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}
        >
          <Terminal className="h-4 w-4 shrink-0" />
          {t('Terminal')}
        </button>
      </div>

      <Separator />

      {/* Thread list */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t('Threads')}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          onClick={() => {
            createThread.mutate({ body: {} });
            onViewChange('chat');
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2">
        <div className="space-y-0.5 pb-2">
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => {
                handleSwitchThread(thread.id);
                onViewChange('chat');
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                thread.id === threadId && activeView === 'chat'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <MessageSquare className="h-4 w-4 shrink-0" />
              <span className="truncate">
                {thread.preview || thread.id.slice(0, 8)}
              </span>
            </button>
          ))}

          {threads.length === 0 && (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              {t('No threads yet')}
            </p>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
