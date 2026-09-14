/** A permanent conversation surface: floating composer, measured transcript, and an external loading gate. */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { ChatInput, type ChatInputHandle } from './chat-input';
import { ChatTimeline } from './chat-timeline';
import { SurfaceActivityContext } from '@/lib/surface-activity';
import { Button } from '@/components/ui/button';
import { useTimelineStore } from '@/stores/timeline-store';

/** Preserves the composer and scroll element across every sibling-tab activation. */
export function ConversationFrame({
  active,
  threadId,
  onRetry,
}: {
  active: boolean;
  threadId: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const input = useRef<ChatInputHandle>(null);
  const composer = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const [sendSignal, setSendSignal] = useState(0);
  const selected = useTimelineStore((s) => s.threadId === threadId);
  const hydrated = useTimelineStore((s) => s.threadsById[threadId]?.hydrated ?? false);
  const openState = useTimelineStore((s) => s.threadsById[threadId]?.openState);
  const historyError = useTimelineStore((s) => s.threadsById[threadId]?.historyError);
  const dataReady = selected && hydrated && openState === 'ready';
  const measureReady = useCallback(
    (measured: boolean) =>
      setLayoutReady((old) => (old === measured ? old : measured)),
    [],
  );
  useLayoutEffect(() => {
    const node = composer.current;
    if (!node) return;
    const measure = () =>
      setHeight((previous) =>
        previous === node.offsetHeight ? previous : node.offsetHeight,
      );
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);

  return (
    <SurfaceActivityContext value={active && selected}>
      <div className="relative flex h-full min-h-0 flex-col">
        <ChatTimeline
          conversationId={threadId}
          active={active && selected}
          ready={dataReady && height !== null}
          onReady={measureReady}
          bottomInset={height ?? 0}
          scrollToLatestSignal={sendSignal}
          onEditMessage={(text) => input.current?.setInput(text)}
        />
        <div
          ref={composer}
          className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-4xl pb-[env(safe-area-inset-bottom)]"
        >
          <ChatInput
            ref={input}
            active={active && selected}
            onSubmitted={() => setSendSignal((n) => n + 1)}
          />
        </div>
        {(!dataReady || !layoutReady) && (
          <div
            data-history-gate
            className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm text-muted-foreground"
          >
            {openState === 'error' && historyError ? (
              <>
                <AlertTriangle />
                <p>{historyError}</p>
                <Button onClick={onRetry}>{t('Retry')}</Button>
              </>
            ) : (
              <>
                <Loader2 className="animate-spin" />
                {t('Loading conversation…')}
              </>
            )}
          </div>
        )}
        {dataReady && layoutReady && historyError && (
          <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-3 border-b bg-background px-4 py-2 text-xs">
            <span className="flex-1">{historyError}</span>
            <Button size="sm" variant="ghost" onClick={onRetry}>
              {t('Retry')}
            </Button>
          </div>
        )}
      </div>
    </SurfaceActivityContext>
  );
}
