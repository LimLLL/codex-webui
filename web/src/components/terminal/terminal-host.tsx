/** Stable terminal instances presented over a route-owned rectangle without reparenting React trees. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TerminalPane } from './terminal-pane';
import { useTerminalViewStore } from '@/stores/terminal-view-store';
import { useTerminalSocketEvents } from '@/hooks/use-terminal-socket';

/** Registers only the visible terminal's destination. Unmount withdraws presentation, not attachment. */
export function TerminalSurface({
  terminalId,
  contextKey,
  active = true,
}: {
  terminalId: string;
  contextKey: string;
  active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active) return;
    useTerminalViewStore.getState().present(terminalId, contextKey, element);
    return () => useTerminalViewStore.getState().withdraw(element);
  }, [terminalId, contextKey, active]);
  return <div ref={ref} className="h-full min-h-0 w-full" />;
}

/** Owns attached xterm instances for the authenticated browser lifetime. */
export function TerminalHost() {
  const retained = useTerminalViewStore((s) => s.retained);
  const target = useTerminalViewStore((s) => s.target);
  const [usableTarget, setUsableTarget] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const [rect, setRect] = useState({ left: 0, top: 0, width: 1, height: 1 });
  useTerminalSocketEvents();
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useLayoutEffect(() => {
    if (!target) return;
    const measure = () => {
      const { left, top, width, height } =
        target.element.getBoundingClientRect();
      if (width <= 0 || height <= 0) {
        setUsableTarget(null);
        return;
      }
      setUsableTarget(target.element);
      setRect((old) =>
        old.left === left &&
        old.top === top &&
        old.width === width &&
        old.height === height
          ? old
          : { left, top, width, height },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(target.element);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [target]);

  return Object.entries(retained).map(([terminalId, contextKey]) => {
    const active =
      visible &&
      target?.terminalId === terminalId &&
      target.element.isConnected &&
      usableTarget === target.element &&
      rect.width > 1;
    return (
      <div
        key={terminalId}
        // A stable hook for the real-browser geometry tests, which have to
        // assert where this overlay actually landed. The React key is not
        // observable in the DOM.
        data-terminal-overlay={terminalId}
        inert={!active}
        aria-hidden={!active}
        style={{
          position: 'fixed',
          ...rect,
          visibility: active ? 'visible' : 'hidden',
          zIndex: 20,
        }}
      >
        <TerminalPane
          terminalId={terminalId}
          contextKey={contextKey}
          active={active}
        />
      </div>
    );
  });
}
