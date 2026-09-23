/** Stable measured transcript surface, shared by production and real-browser behavior tests. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  useVirtualizer,
  elementScroll,
  measureElement,
  defaultRangeExtractor,
} from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  TranscriptScrollOwner,
  AT_END_THRESHOLD_PX,
} from '@/lib/transcript-scroll-owner';
import { shouldPrefetchOlder } from '@/lib/history-prefetch';
import { TranscriptSnapshot } from './transcript-snapshot';

/** How far a row dissolves over as it passes under the floating composer. */
const COMPOSER_FADE_PX = 56;

interface Props {
  threadId: string;
  keys: readonly string[];
  renderRow: (index: number) => ReactNode;
  active: boolean;
  ready: boolean;
  bottomInset: number;
  scrollSignal: number;
  historyHeader?: ReactNode;
  hasOlder?: boolean;
  historyLoading?: boolean;
  loadOlder?: () => void;
  onReady?: (measured: boolean) => void;
}

/** Uses the pinned adapter's synchronous extent/position writes, retaining one measured scroll box. */
export function VirtualTranscript({
  threadId,
  keys,
  renderRow,
  active,
  ready,
  bottomInset,
  scrollSignal,
  historyHeader,
  hasOlder = false,
  historyLoading = false,
  loadOlder,
  onReady,
}: Props) {
  'use no memo';
  const { t } = useTranslation();
  const owner = useMemo(() => new TranscriptScrollOwner(threadId), [threadId]);
  const [measured, setMeasured] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [previousScroll] = useState(() => ({ value: 0 }));
  const bind = useCallback(
    (node: HTMLDivElement | null) => {
      owner.bind(node);
      setElement(node);
    },
    [owner],
  );
  const getKey = useCallback((index: number) => keys[index], [keys]);
  /**
   * Dissolves the scroller's own bottom edge so rows never hard-cut against the
   * floating composer.
   *
   * The composer is opaque, but it is inset from the scroller, so without this
   * rows still surface in the gutters beside and above it. A mask is used
   * rather than a painted gradient overlay because a mask is colour-agnostic:
   * one declaration works in both themes and over any surface, where an overlay
   * has to know the exact background it fades into.
   *
   * The ramp starts where the composer band starts, and `paddingEnd` already
   * reserves that band, so a transcript resting at the end is never faded.
   */
  const composerFade = useMemo<CSSProperties | undefined>(() => {
    if (bottomInset <= 0) return undefined;
    const ramp = Math.min(COMPOSER_FADE_PX, bottomInset);
    const gradient =
      `linear-gradient(to bottom, #000 calc(100% - ${bottomInset}px), ` +
      `transparent calc(100% - ${bottomInset - ramp}px))`;
    return { maskImage: gradient, WebkitMaskImage: gradient };
  }, [bottomInset]);
  const measure = useCallback(
    (
      node: Element,
      entry: ResizeObserverEntry | undefined,
      instance: Parameters<typeof measureElement>[2],
    ) => {
      if (entry) owner.rowResized();
      return measureElement(node, entry, instance);
    },
    [owner],
  );
  // The adapter owns height and main-axis positions. React must not overwrite them.
  // eslint-disable-next-line react-hooks/incompatible-library -- The pinned adapter intentionally owns mutable geometry.
  const virtualizer = useVirtualizer({
    count: keys.length,
    getScrollElement: () => element,
    getItemKey: getKey,
    scrollToFn: (offset, options, instance) => {
      elementScroll(offset, options, instance);
      owner.programmaticScroll();
    },
    estimateSize: () => 100,
    overscan: 5,
    anchorTo: 'end',
    followOnAppend: false,
    directDomUpdates: true,
    directDomUpdatesMode: 'position',
    // Pairs with `directDomUpdates`. The adapter writes row positions and the
    // container extent synchronously inside `onChange`. Newly visible indexes
    // still need a React commit: this does not guarantee same-paint mounting
    // outside overscan during a large native scroll or a busy main thread. Leaving it
    // on made React log — and discard — a flush on every correction, because
    // the corrections are issued from a layout effect.
    useFlushSync: false,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const anchor = owner.anchor ? keys.indexOf(owner.anchor.rowKey) : -1;
      return anchor >= 0 && !indexes.includes(anchor)
        ? [...indexes, anchor].sort((a, b) => a - b)
        : indexes;
    },
    paddingStart: 48,
    paddingEnd: bottomInset,
    scrollPaddingEnd: bottomInset,
    scrollEndThreshold: AT_END_THRESHOLD_PX,
    measureElement: measure,
    onChange: (instance) => {
      if (!instance.isScrolling) queueMicrotask(() => owner.endInput());
    },
  });

  // Ordering is deliberate: useVirtualizer registered its own layout effects above.
  // Every content commit participates, even when the row keys and count are unchanged.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- The owner publishes only changed boolean state.
  useLayoutEffect(() => {
    owner.commit(virtualizer, {
      active,
      ready,
      signal: scrollSignal,
      onPosition: setAtEnd,
    });
    const settled = ready && owner.rangeMeasured(bottomInset);
    setMeasured((current) => (current === settled ? current : settled));
    onReady?.(settled);
  });

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() => owner.geometryChanged());
    observer.observe(element);
    const fontChange = () => owner.geometryChanged(true);
    const pointerEnd = () => owner.endPointer();
    const scrollEnd = () => owner.endInput();
    document.fonts?.addEventListener('loadingdone', fontChange);
    window.addEventListener('pointerup', pointerEnd);
    window.addEventListener('pointercancel', pointerEnd);
    element.addEventListener('scrollend', scrollEnd);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener('loadingdone', fontChange);
      window.removeEventListener('pointerup', pointerEnd);
      window.removeEventListener('pointercancel', pointerEnd);
      element.removeEventListener('scrollend', scrollEnd);
      owner.dispose();
    };
  }, [element, owner]);

  return (
    <TranscriptSnapshot beforeCommit={() => owner.beforeCommit()}>
      <div
        className="relative flex h-full min-h-0 flex-1 flex-col"
        style={{ visibility: ready && measured ? undefined : 'hidden' }}
      >
        <div
          ref={bind}
          data-transcript-scroller
          tabIndex={0}
          onFocusCapture={() => owner.beginInput()}
          style={composerFade}
          className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] [overflow-anchor:none]"
          onWheel={() => owner.beginInput()}
          onTouchStart={() => owner.beginInput(true)}
          onTouchEnd={() => owner.endPointer()}
          onPointerDown={() => owner.beginInput(true)}
          onKeyDown={(event) => {
            if (
              [
                'ArrowUp',
                'ArrowDown',
                'PageUp',
                'PageDown',
                'Home',
                'End',
                ' ',
              ].includes(event.key)
            )
              owner.beginInput();
          }}
          onScroll={() => {
            const userScroll = owner.scrolled();
            const top = element?.scrollTop ?? 0;
            if (
              userScroll &&
              shouldPrefetchOlder({
                scrollTop: top,
                previousScrollTop: previousScroll.value,
                hasCursor: hasOlder,
                loading: historyLoading,
              })
            )
              loadOlder?.();
            previousScroll.value = top;
          }}
        >
          <div ref={virtualizer.containerRef} className="relative w-full">
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                data-transcript-row={String(item.key)}
                ref={virtualizer.measureElement}
                className="absolute left-0 w-full"
              >
                {/* No centred maximum width: the shell and the resizable
                    explorer decide how much room the conversation gets, and
                    the column consumes all of it. Padding matches the
                    composer's so the two surfaces stay aligned at every
                    breakpoint. */}
                <div
                  data-transcript-column
                  className="min-w-0 w-full overflow-x-hidden px-3 py-2 [overflow-wrap:anywhere] sm:px-4 lg:px-6"
                >
                  {renderRow(item.index)}
                </div>
              </div>
            ))}
          </div>
        </div>
        {historyHeader && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-12 items-center justify-center">
            <div className="pointer-events-auto rounded-full bg-background">
              {historyHeader}
            </div>
          </div>
        )}
        {!atEnd && (
          <div
            className="pointer-events-none absolute inset-x-0 z-20 flex justify-end px-3 sm:px-4 lg:px-6"
            style={{ bottom: bottomInset + 12 }}
          >
            <button
              type="button"
              onClick={() => owner.jumpToLatest()}
              aria-label={t('Jump to latest')}
              className="pointer-events-auto flex items-center gap-1 rounded-full border bg-card px-3 py-1.5 text-xs shadow-md"
            >
              <ArrowDown className="h-3 w-3" />
              {t('Jump to latest')}
            </button>
          </div>
        )}
      </div>
    </TranscriptSnapshot>
  );
}
