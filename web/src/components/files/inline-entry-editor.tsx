/** Layout-independent Windows-style name input hosted by either directory view. */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface InlineEntryEditorProps {
  initialValue?: string;
  selectBaseName?: boolean;
  pending?: boolean;
  error?: string | null;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Acquires focus after menu teardown. Enter and blur commit once; Escape never
 * falls through to a parent dialog or a blur submission. Composition Enter,
 * including WebKit's legacy 229 marker, is left to the IME.
 */
export function InlineEntryEditor({
  initialValue = '',
  selectBaseName = false,
  pending = false,
  error,
  className,
  onCommit,
  onCancel,
}: InlineEntryEditorProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const committed = useRef(false);
  const errorId = useId();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      const dot = initialValue.lastIndexOf('.');
      input.current?.setSelectionRange(
        0,
        selectBaseName && dot > 0 ? dot : initialValue.length,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [initialValue, selectBaseName]);
  useEffect(() => {
    if (!pending) committed.current = false;
  }, [pending, error]);
  const commit = (draft = value) => {
    if (pending || committed.current || composing.current) return;
    committed.current = true;
    if (!draft.trim()) onCancel();
    else onCommit(draft.trim());
  };
  return (
    <div
      className={cn('min-w-0 flex-1', className)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Input
        data-file-inline-edit="true"
        ref={input}
        value={value}
        readOnly={pending}
        aria-busy={pending}
        aria-label={t('File or directory name')}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className="h-6 text-xs"
        onChange={(event) => {
          committed.current = false;
          setValue(event.target.value);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          if (document.activeElement !== event.currentTarget)
            commit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          if (event.key === 'Escape') {
            event.preventDefault();
            committed.current = true;
            onCancel();
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        onBlur={() => commit()}
      />
      {error && (
        <p
          id={errorId}
          role="alert"
          className="mt-1 text-[10px] text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
