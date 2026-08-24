/**
 * Manages ChatInput attachment state: file mentions, images, skills.
 * Handles paste, FileTree attach events, buildInput for turn/start, cleanup.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clearApiToken, getAuthorizationHeader } from '@/auth-token';
import { withBasePath } from '@/base-path';
import { escapeMentionPath } from '@/lib/mention-utils';
import type { ChatAttachment, ChatFileAttachment, ChatImageAttachment } from '@/types/attachments';

let attachmentIdCounter = 0;
function nextAttachmentId(): string {
  return `att-${++attachmentIdCounter}-${Date.now()}`;
}

/** Escapes special regex characters for safe use in RegExp. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface UseChatAttachmentsParams {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  valueRef: React.RefObject<string>;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  threadCwd: string | null;
  addSystemError: (msg: string) => void;
}

export function useChatAttachments({
  textareaRef,
  valueRef,
  setValue,
  threadCwd,
  addSystemError,
}: UseChatAttachmentsParams) {
  const { t } = useTranslation();
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);

  const threadCwdRef = useRef(threadCwd);
  useEffect(() => { threadCwdRef.current = threadCwd; }, [threadCwd]);

  /** Compute relative path from cwd. */
  const toRelativePath = useCallback((absolutePath: string) => {
    const cwd = threadCwdRef.current;
    if (cwd && absolutePath.startsWith(cwd + '/')) {
      return absolutePath.slice(cwd.length + 1);
    }
    return absolutePath;
  }, []);

  /** Insert text at the current cursor position in the textarea. */
  const insertAtCursor = useCallback((text: string) => {
    const textarea = textareaRef.current;
    const currentValue = valueRef.current;
    if (!textarea) {
      setValue(currentValue + text);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newValue = currentValue.slice(0, start) + text + currentValue.slice(end);
    setValue(newValue);
    const newPos = start + text.length;
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  }, [textareaRef, valueRef, setValue]);

  /** Add a file mention: insert @displayName at cursor + track metadata. */
  /** Add a file mention: escape spaces, insert @path at cursor, track metadata. */
  const addFileMention = useCallback((displayName: string, absolutePath: string) => {
    const escaped = escapeMentionPath(displayName);
    insertAtCursor(`@${escaped} `);
    setAttachments((prev) => [
      ...prev,
      { type: 'mention', id: nextAttachmentId(), displayName: escaped, path: absolutePath } as ChatFileAttachment,
    ]);
  }, [insertAtCursor]);

  // Listen for external "attach file" events from FileTree context menu
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string; path: string }>).detail;
      if (detail?.name && detail?.path) {
        addFileMention(toRelativePath(detail.path), detail.path);
      }
    };
    window.addEventListener('codex-webui:attach-file', handler);
    return () => window.removeEventListener('codex-webui:attach-file', handler);
  }, [addFileMention, toRelativePath]);

  /**
   * Build the input array for turn/start or turn/steer.
   * File mentions: @relative → @absolute in text.
   * Images/skills: separate input items.
   */
  const buildInput = useCallback(() => {
    const input: Array<Record<string, unknown>> = [];
    const currentAttachments = attachmentsRef.current;
    let currentText = valueRef.current.trim();

    // Replace @relative with @absolute in text for file mentions.
    // Sort by displayName length descending to prevent partial matches.
    const fileMentions = currentAttachments
      .filter((att): att is ChatFileAttachment => att.type === 'mention')
      .sort((a, b) => b.displayName.length - a.displayName.length);
    for (const mention of fileMentions) {
      const pattern = new RegExp(
        `(^|\\s)@${escapeRegExp(mention.displayName)}(?=$|\\s)`, 'g',
      );
      // Escape spaces in absolute path too so backend regex can parse it
      const escapedAbsPath = escapeMentionPath(mention.path);
      currentText = currentText.replace(
        pattern, (_match, prefix: string) => `${prefix}@${escapedAbsPath}`,
      );
    }

    // Add non-file attachments as separate input items
    for (const att of currentAttachments) {
      if (att.type === 'localImage') {
        input.push({ type: 'localImage', path: att.path });
      } else if (att.type === 'skill') {
        input.push({ type: 'skill', name: att.name, path: att.path });
      }
    }

    if (currentText) {
      input.push({ type: 'text', text: currentText, text_elements: [] });
    }

    return input;
  }, [valueRef]);

  /** Clear attachments and text after sending. */
  const clearAfterSend = useCallback(() => {
    for (const att of attachmentsRef.current) {
      if (att.type === 'localImage' && (att as ChatImageAttachment).previewUrl) {
        URL.revokeObjectURL((att as ChatImageAttachment).previewUrl!);
      }
    }
    setValue('');
    setAttachments([]);
  }, [setValue]);

  /** Upload a file via direct fetch (SDK serializes body as JSON, multipart needs raw FormData). */
  const uploadFile = useCallback(async (file: File): Promise<{ path: string } | null> => {
    const formData = new FormData();
    formData.append('file', file, file.name || 'pasted-file');
    const authorization = getAuthorizationHeader();
    const resp = await fetch(withBasePath('/api/chat/upload'), {
      method: 'POST',
      headers: authorization ? { Authorization: authorization } : {},
      body: formData,
    });
    if (!resp.ok) {
      if (resp.status === 401) {
        clearApiToken();
        window.dispatchEvent(new Event('codex-webui:auth-expired'));
      }
      const err = await resp.json().catch(() => undefined);
      const msg = (err as { message?: string })?.message;
      throw new Error(msg || `Upload failed: ${resp.status}`);
    }
    return (await resp.json()) as { path: string };
  }, []);

  /** Paste handler: images → chip, files → @filename at cursor. */
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const fileItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') fileItems.push(items[i]);
    }
    if (fileItems.length === 0) return;
    e.preventDefault();

    for (const item of fileItems) {
      const file = item.getAsFile();
      if (!file) continue;

      try {
        const data = await uploadFile(file);
        if (!data) continue;

        if (file.type.startsWith('image/')) {
          const previewUrl = URL.createObjectURL(file);
          setAttachments((prev) => [
            ...prev,
            {
              type: 'localImage', id: nextAttachmentId(),
              name: file.name || 'image', path: data.path, previewUrl,
            } as ChatImageAttachment,
          ]);
        } else {
          const fileName = file.name || 'pasted-file';
          const escapedName = escapeMentionPath(fileName);
          insertAtCursor(`@${escapedName} `);
          setAttachments((prev) => [
            ...prev,
            { type: 'mention', id: nextAttachmentId(), displayName: escapedName, path: data.path } as ChatFileAttachment,
          ]);
        }
      } catch {
        addSystemError(t('Failed to upload pasted file'));
      }
    }
  }, [addSystemError, t, insertAtCursor, uploadFile]);

  /** Remove attachment. For file mentions, also remove @displayName from text. */
  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (!att) return prev.filter((a) => a.id !== id);

      if (att.type === 'localImage' && (att as ChatImageAttachment).previewUrl) {
        URL.revokeObjectURL((att as ChatImageAttachment).previewUrl!);
      }
      if (att.type === 'mention') {
        const fileAtt = att as ChatFileAttachment;
        const pattern = new RegExp(`\\s?@${escapeRegExp(fileAtt.displayName)}\\s?`, 'g');
        setValue((v: string) => v.replace(pattern, ' ').trim());
      }
      return prev.filter((a) => a.id !== id);
    });
  }, [setValue]);

  const handleSkillSelect = useCallback((skill: { name: string; path: string }) => {
    setAttachments((prev) => [
      ...prev,
      { type: 'skill', id: nextAttachmentId(), name: skill.name, path: skill.path },
    ]);
  }, []);

  // Only show chips for images and skills (file mentions are inline in text)
  const chipAttachments = attachments.filter((a) => a.type !== 'mention');

  return {
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
  };
}
