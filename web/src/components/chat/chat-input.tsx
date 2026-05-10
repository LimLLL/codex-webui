/**
 * Chat message input with embedded send button and session panel toggle.
 */
import { useCallback, useRef } from 'react';
import { Send, TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useTimelineStore } from '@/stores/timeline-store';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Whether the session bottom panel is open. */
  panelOpen: boolean;
  /** Toggle session bottom panel. */
  onTogglePanel: () => void;
}

export function ChatInput({ value, onChange, panelOpen, onTogglePanel }: Props) {
  const threadId = useTimelineStore((s) => s.threadId);
  const loading = useTimelineStore((s) => s.loading);
  const sendMessage = useTimelineStore((s) => s.sendMessage);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    if (!value.trim()) return;
    void sendMessage(value.trim());
    onChange('');
  }, [value, onChange, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <footer className="glass sticky bottom-0 z-10 px-4 py-3 md:px-6">
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            threadId
              ? 'Type a message... (Enter to send)'
              : 'Create a thread first'
          }
          disabled={!threadId || loading}
          rows={1}
          className="max-h-32 min-h-0 resize-none rounded-xl bg-background/60 pb-10 pr-4 pt-2.5 backdrop-blur-sm transition-all duration-200 focus:ring-2 focus:ring-primary/30"
        />
        {/* Bottom bar inside textarea area */}
        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
          <Button
            size="sm"
            variant={panelOpen ? 'secondary' : 'ghost'}
            className="h-7 gap-1.5 rounded-lg px-2.5 text-xs"
            onClick={onTogglePanel}
            disabled={!threadId}
            title="Toggle terminal & files panel"
          >
            <TerminalSquare className="h-3.5 w-3.5" />
            Terminal
          </Button>

          <Button
            size="icon"
            className="h-7 w-7 rounded-lg transition-transform duration-200 hover:scale-105 active:scale-95"
            disabled={!threadId || !value.trim() || loading}
            onClick={handleSend}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </footer>
  );
}
