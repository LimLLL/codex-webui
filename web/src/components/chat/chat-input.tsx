/**
 * Chat message input orchestrator.
 * Delegates attachment management to useChatAttachments and @ mention to useChatMention.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Send, Square, TerminalSquare } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { threadsInterruptTurnMutation, threadsStartTurnMutation, threadsSteerTurnMutation } from '@/generated/api/@tanstack/react-query.gen';
import { cn } from '@/lib/utils';
import { useTimelineStore } from '@/stores/timeline-store';
import { useModelStore } from '@/stores/model-store';
import { useChatAttachments } from '@/hooks/use-chat-attachments';
import { useChatMention } from '@/hooks/use-chat-mention';
import { SecurityPolicyBadge } from './security-policy-badge';
import { ModelSelector } from './model-selector';
import { TokenUsageRing } from './token-usage-ring';
import { McpStatusBadge } from './mcp-status-badge';
import { SkillSelector } from './skill-selector';
import { AttachmentChips } from './attachment-chips';
import { MentionPopover } from './mention-popover';

/** Imperative handle exposed via ref for external input manipulation. */
export interface ChatInputHandle {
  setInput: (value: string) => void;
  addFileAttachment: (displayName: string, absolutePath: string) => void;
}

interface Props {
  panelOpen: boolean;
  onTogglePanel: () => void;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  { panelOpen, onTogglePanel },
  ref,
) {
  const [value, setValue] = useState('');
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { t } = useTranslation();
  const threadId = useTimelineStore((s) => s.threadId);
  const threadCwd = useTimelineStore((s) => s.threadCwd);
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
  const addSystemError = useTimelineStore((s) => s.addSystemError);
  const readOnly = threadMode === 'readOnly';
  const hasActiveTurn = Boolean(threadId && activeTurnId && !readOnly);
  const canSteer = hasActiveTurn && !hasPendingApproval;

  // ── Attachment hook ──────────────────────────────────────
  const {
    attachments,
    attachmentsRef,
    setAttachments,
    chipAttachments,
    buildInput,
    clearAfterSend,
    handlePaste,
    addFileMention,
    handleRemoveAttachment,
    handleSkillSelect,
    toRelativePath,
  } = useChatAttachments({
    textareaRef,
    valueRef,
    setValue,
    threadCwd,
    addSystemError,
  });

  // ── Mention hook ─────────────────────────────────────────
  const {
    mentionOpen,
    mentionSelectedIndex,
    mentionFiltered,
    mentionLoading,
    browseRelative,
    detectMention,
    handleMentionSelect,
    handleMentionNavigate,
    handleMentionNavigateUp,
    handleMentionKeyDown,
  } = useChatMention({
    textareaRef,
    valueRef,
    cwd: threadCwd,
    setValue,
    setAttachments,
    toRelativePath,
  });

  // ── Imperative handle ────────────────────────────────────
  useImperativeHandle(ref, () => ({
    setInput: setValue,
    addFileAttachment: addFileMention,
  }), [addFileMention]);

  // ── Turn mutations ───────────────────────────────────────
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
    const input = buildInput();
    if (input.length === 0 || !threadId || loading || readOnly) return;
    // Collect image paths for timeline display
    const imageAttachments = attachmentsRef.current
      .filter((a): a is import('@/types/attachments').ChatImageAttachment => a.type === 'localImage')
      .map((a) => a.path);
    addUserMessage(valueRef.current.trim(), imageAttachments.length > 0 ? imageAttachments : undefined);
    clearAfterSend();
    const { modelOverride, effortOverride } = useModelStore.getState();
    startTurn.mutate({
      path: { threadId },
      body: {
        input: input as never,
        ...(modelOverride && { model: modelOverride }),
        ...(effortOverride && { effort: effortOverride }),
      },
    });
  }, [buildInput, threadId, loading, readOnly, attachmentsRef, addUserMessage, clearAfterSend, startTurn]);

  const handleSteer = useCallback(() => {
    const input = buildInput();
    if (input.length === 0 || !canSteer || !threadId || !activeTurnId || steer.isPending) return;
    clearAfterSend();
    steer.mutate({
      path: { threadId, turnId: activeTurnId },
      body: { input: input as never },
    });
  }, [buildInput, clearAfterSend, canSteer, threadId, activeTurnId, steer]);

  const handleStop = useCallback(() => {
    if (!threadId || !activeTurnId || interruptTurn.isPending) return;
    interruptTurn.mutate({ path: { threadId, turnId: activeTurnId } });
  }, [threadId, activeTurnId, interruptTurn]);

  const handleSubmit = useCallback(() => {
    if (hasActiveTurn) { handleSteer(); return; }
    handleSend();
  }, [hasActiveTurn, handleSteer, handleSend]);

  // ── Input handlers ───────────────────────────────────────
  const handleChange = useCallback((newValue: string) => {
    setValue(newValue);
    detectMention(newValue);
  }, [detectMention]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (handleMentionKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleMentionKeyDown, handleSubmit]);

  const hasContent = value.trim().length > 0 || attachments.length > 0;

  // ── Render ───────────────────────────────────────────────
  return (
    <footer className="glass-4 sticky bottom-0 z-10 px-4 py-3 md:px-6">
      {readOnly && (
        <p className="mb-2 rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
          {t('Archived threads are read-only. Unarchive or fork to continue.')}
        </p>
      )}
      <div className="relative">
        <AttachmentChips
          attachments={chipAttachments}
          onRemove={handleRemoveAttachment}
          className="rounded-t-xl border border-b-0 border-border/40 bg-background/40"
        />

        <MentionPopover
          open={mentionOpen}
          browseRelative={browseRelative}
          filtered={mentionFiltered}
          isLoading={mentionLoading}
          selectedIndex={mentionSelectedIndex}
          onSelect={handleMentionSelect}
          onNavigate={handleMentionNavigate}
          onNavigateUp={handleMentionNavigateUp}
        />

        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            readOnly
              ? t('Archived thread is read-only')
              : hasActiveTurn
                ? t('Add input to the active turn...')
                : threadId
                  ? t('Type a message... (@ to mention files, paste images)')
                  : t('Create a thread first')
          }
          disabled={!threadId || readOnly}
          rows={1}
          className={cn(
            'max-h-32 min-h-0 resize-none bg-background/60 pb-10 pr-4 pt-2.5 backdrop-blur-sm transition-all duration-200 focus:ring-2 focus:ring-primary/30',
            chipAttachments.length > 0 ? 'rounded-b-xl rounded-t-none border-t-0' : 'rounded-xl',
          )}
        />
        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <ModelSelector />
            <SecurityPolicyBadge />
            <McpStatusBadge />
            <SkillSelector
              cwd={threadCwd}
              disabled={!threadId || readOnly}
              onSelect={handleSkillSelect}
            />
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
                  disabled={!hasContent || !canSteer || steer.isPending}
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
                disabled={!threadId || !hasContent || loading || readOnly}
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
});
