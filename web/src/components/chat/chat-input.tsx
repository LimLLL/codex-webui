/**
 * Chat message input with embedded send button and session panel toggle.
 */
import { useCallback, useRef } from 'react';
import { Send, Square, TerminalSquare } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { threadsInterruptTurnMutation, threadsStartTurnMutation, threadsSteerTurnMutation } from '@/generated/api/@tanstack/react-query.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import { SecurityPolicyBadge } from './security-policy-badge';
import { TokenUsageRing } from './token-usage-ring';

interface Props {
  value: string;
  onChange: (value: string) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

export function ChatInput({ value, onChange, panelOpen, onTogglePanel }: Props) {
  const { t } = useTranslation();
  const threadId = useTimelineStore((s) => s.threadId);
  const threadMode = useTimelineStore((s) => s.threadMode);
  const loading = useTimelineStore((s) => s.loading);
  const activeTurnId = useTimelineStore((s) => s.activeTurnId);
  const hasPendingApproval = useTimelineStore((s) => {
    const flagBlocked =
      s.threadStatus?.type === 'active' &&
      s.threadStatus.activeFlags.includes('waitingOnApproval');
    const cardBlocked = Object.values(s.approvals).some(
      (a) => a.status === 'pending',
    );
    return flagBlocked || cardBlocked;
  });
  const addUserMessage = useTimelineStore((s) => s.addUserMessage);
  const addSystemMessage = useTimelineStore((s) => s.addSystemMessage);
  const addSystemError = useTimelineStore((s) => s.addSystemError);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const readOnly = threadMode === 'readOnly';
  const hasActiveTurn = Boolean(threadId && activeTurnId && !readOnly);
  const canSteer = hasActiveTurn && !hasPendingApproval;

  const startTurn = useMutation({
    ...threadsStartTurnMutation(),
    onError: (err) => addSystemError(String(err.message)),
  });

  const steer = useMutation({
    ...threadsSteerTurnMutation(),
    onError: (err) => addSystemError(String(err.message)),
  });

  const interruptTurn = useMutation({
    ...threadsInterruptTurnMutation(),
    onError: (err) => addSystemError(String(err.message)),
  });

  const handleSend = useCallback(() => {
    if (!value.trim() || !threadId || loading || readOnly) return;
    const text = value.trim();
    addUserMessage(text);
    onChange('');
    startTurn.mutate({
      path: { threadId },
      body: { input: [{ type: 'text' as const, text }] },
    });
  }, [value, onChange, threadId, loading, readOnly, addUserMessage, startTurn]);

  const handleSteer = useCallback(() => {
    if (!value.trim() || !canSteer || !threadId || !activeTurnId || steer.isPending) return;
    const text = value.trim();
    onChange('');
    steer.mutate(
      {
        path: { threadId, turnId: activeTurnId },
        body: { input: [{ type: 'text' as const, text }] },
      },
      {
        onSuccess: () =>
          addSystemMessage(t('Steered current turn: {{text}}', { text }), 'info'),
        onError: () => onChange(text),
      },
    );
  }, [value, canSteer, threadId, activeTurnId, steer, onChange, addSystemMessage, t]);

  const handleStop = useCallback(() => {
    if (!threadId || !activeTurnId || interruptTurn.isPending) return;
    interruptTurn.mutate({ path: { threadId, turnId: activeTurnId } });
  }, [threadId, activeTurnId, interruptTurn]);

  const handleSubmit = useCallback(() => {
    if (hasActiveTurn) {
      handleSteer();
      return;
    }
    handleSend();
  }, [hasActiveTurn, handleSteer, handleSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <footer className="glass sticky bottom-0 z-10 px-4 py-3 md:px-6">
      {readOnly && (
        <p className="mb-2 rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
          {t('Archived threads are read-only. Unarchive or fork to continue.')}
        </p>
      )}
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            readOnly
              ? t('Archived thread is read-only')
              : hasActiveTurn
                ? t('Add input to the active turn...')
                : threadId
                ? t('Type a message... (Enter to send)')
                : t('Create a thread first')
          }
          disabled={!threadId || readOnly}
          rows={1}
          className="max-h-32 min-h-0 resize-none rounded-xl bg-background/60 pb-10 pr-4 pt-2.5 backdrop-blur-sm transition-all duration-200 focus:ring-2 focus:ring-primary/30"
        />
        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <SecurityPolicyBadge />
            <Button
              size="sm"
              variant={panelOpen ? 'secondary' : 'ghost'}
              className="h-7 gap-1.5 rounded-lg px-2.5 text-xs"
              onClick={onTogglePanel}
              disabled={!threadId || readOnly}
              title={t('Terminal')}
            >
              <TerminalSquare className="h-3.5 w-3.5" />
              {t('Terminal')}
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <TokenUsageRing />
            {hasActiveTurn ? (
              <>
                <Button
                  size="sm"
                  className="h-7 rounded-lg px-2.5 text-xs transition-transform duration-200 hover:scale-105 active:scale-95"
                  disabled={!value.trim() || !canSteer || steer.isPending}
                  onClick={handleSteer}
                  title={t('Steer current turn')}
                >
                  {t('Steer')}
                </Button>
                <Button
                  size="icon"
                  variant="destructive"
                  className="h-7 w-7 rounded-lg transition-transform duration-200 hover:scale-105 active:scale-95"
                  disabled={interruptTurn.isPending}
                  onClick={handleStop}
                  title={t('Stop current turn')}
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              </>
            ) : (
              <Button
                size="icon"
                className="h-7 w-7 rounded-lg transition-transform duration-200 hover:scale-105 active:scale-95"
                disabled={!threadId || !value.trim() || loading || readOnly}
                onClick={handleSend}
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}
