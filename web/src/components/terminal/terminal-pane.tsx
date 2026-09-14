/** xterm.js pane bound to one shared backend terminal session. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import i18n from '@/i18n';
import { getSocket } from '@/socket';
import { useTerminalStore } from '@/stores/terminal-store';
import { cn } from '@/lib/utils';
import type { TerminalMetadata } from '@/types/terminal';

interface Props {
  contextKey: string;
  terminalId: string;
  active: boolean;
  className?: string;
}

export function TerminalPane({
  contextKey,
  terminalId,
  active,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const attachedRef = useRef(false);
  const activeRef = useRef(active);
  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  const config = useTerminalStore((s) => s.config);
  const [scrollback] = useState(config.scrollback);
  const reconnectTerminal = useTerminalStore((s) => s.reconnectTerminal);
  const detachTerminal = useTerminalStore((s) => s.detachTerminal);
  const resizeTerminal = useTerminalStore((s) => s.resizeTerminal);

  /** Only the visibly presented attachment may change the shared PTY dimensions. */
  const fitVisible = useCallback(() => {
    const element = containerRef.current;
    const term = termRef.current;
    if (
      !activeRef.current ||
      !element?.clientWidth ||
      !element.clientHeight ||
      !term
    )
      return;
    fitRef.current?.fit();
    if (attachedRef.current)
      resizeTerminal(contextKey, terminalId, term.cols, term.rows);
  }, [contextKey, resizeTerminal, terminalId]);

  /** Replays the attachment snapshot, then reports geometry only if this view is still active. */
  const attach = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const response = await reconnectTerminal(contextKey, terminalId);
    if (termRef.current !== term) return;
    if (!response) {
      attachedRef.current = false;
      term.write(
        `\r\n[${i18n.t('Terminal no longer exists. Create a new terminal.')}]\r\n`,
      );
      return;
    }
    term.reset();
    if (response.state) term.write(response.state);
    if (response.terminal.status === 'exited') {
      const code =
        response.terminal.exitCode ?? response.terminal.signal ?? '?';
      term.write(
        `\r\n[${i18n.t('Process exited with code {{code}}', { code })}]\r\n`,
      );
      attachedRef.current = false;
    } else {
      attachedRef.current = true;
    }
    requestAnimationFrame(() => {
      if (termRef.current === term) fitVisible();
    });
  }, [contextKey, reconnectTerminal, terminalId, fitVisible]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback,
      theme: {
        background: '#0a0a0a',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        selectionBackground: '#3f3f46',
      },
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(serializeAddon);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fitAddon;

    const socket = getSocket();
    const handleConnect = () => {
      void attach();
    };
    const handleOutput = (event: { terminalId: string; data: string }) => {
      if (event.terminalId === terminalId) term.write(event.data);
    };

    const handleExit = (event: {
      terminal?: TerminalMetadata;
      terminalId?: string;
      closed?: boolean;
    }) => {
      const tid = event.terminal?.id ?? event.terminalId;
      if (tid !== terminalId) return;
      if (event.closed) {
        term.write(`\r\n[${i18n.t('Terminal closed')}]\r\n`);
        attachedRef.current = false;
      } else if (event.terminal?.exitCode !== undefined) {
        term.write(
          `\r\n[${i18n.t('Process exited with code {{code}}', { code: event.terminal.exitCode })}]\r\n`,
        );
        attachedRef.current = false;
      }
    };

    socket.on('connect', handleConnect);
    socket.on('terminal.output', handleOutput);
    socket.on('terminal.exit', handleExit);
    void attach();

    const inputDisposable = term.onData((data) => {
      if (!attachedRef.current || !activeRef.current) return;
      socket.emit('terminal.input', { contextKey, terminalId, data });
    });

    return () => {
      socket.off('connect', handleConnect);
      socket.off('terminal.output', handleOutput);
      socket.off('terminal.exit', handleExit);
      inputDisposable.dispose();
      detachTerminal(terminalId);
      attachedRef.current = false;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [attach, scrollback, contextKey, detachTerminal, terminalId]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(fitVisible);
    observer.observe(element);
    const frame = active ? requestAnimationFrame(fitVisible) : null;
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [active, fitVisible]);

  return (
    <div
      ref={containerRef}
      className={cn('h-full w-full', className)}
      style={{ visibility: active ? 'visible' : 'hidden' }}
      inert={!active}
    />
  );
}
