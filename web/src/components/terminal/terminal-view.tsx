/**
 * xterm.js terminal component.
 * Connects to backend node-pty via Socket.IO.
 * Reusable for both session-level and global terminal views.
 */
import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import i18n from '@/i18n';
import { getSocket } from '@/socket';

interface Props {
  /** Working directory for the terminal session. */
  cwd: string;
  /** Optional CSS class for the container. */
  className?: string;
}

export function TerminalView({ cwd, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  /** Monotonically increasing generation counter to distinguish effect runs. */
  const generationRef = useRef(0);

  const cleanup = useCallback(() => {
    generationRef.current++;
    const socket = getSocket();
    if (terminalIdRef.current) {
      socket.emit('terminal.close', { terminalId: terminalIdRef.current });
      terminalIdRef.current = null;
    }
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0a0a0a',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        selectionBackground: '#3f3f46',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fitAddon;

    // Fit after a tick so the container has its layout dimensions
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    const socket = getSocket();

    const thisGeneration = generationRef.current;

    // Open PTY session
    socket.emit(
      'terminal.open',
      { cwd, cols: term.cols, rows: term.rows },
      (response: { terminalId: string }) => {
        if (generationRef.current !== thisGeneration) {
          // Effect was cleaned up before ack — close the orphaned PTY
          if (response.terminalId) {
            socket.emit('terminal.close', { terminalId: response.terminalId });
          }
          return;
        }
        terminalIdRef.current = response.terminalId;
      },
    );

    // Forward PTY output to xterm
    const handleOutput = (data: { terminalId: string; data: string }) => {
      if (data.terminalId === terminalIdRef.current) {
        term.write(data.data);
      }
    };

    const handleExit = (data: { terminalId: string; exitCode: number }) => {
      if (data.terminalId === terminalIdRef.current) {
        term.write(`\r\n[${i18n.t('Process exited with code {{code}}', { code: data.exitCode })}]\r\n`);
        terminalIdRef.current = null;
      }
    };

    socket.on('terminal.output', handleOutput);
    socket.on('terminal.exit', handleExit);

    // Forward xterm input to PTY
    const inputDisposable = term.onData((data) => {
      if (terminalIdRef.current) {
        socket.emit('terminal.input', {
          terminalId: terminalIdRef.current,
          data,
        });
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (terminalIdRef.current) {
        socket.emit('terminal.resize', {
          terminalId: terminalIdRef.current,
          cols: term.cols,
          rows: term.rows,
        });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      socket.off('terminal.output', handleOutput);
      socket.off('terminal.exit', handleExit);
      cleanup();
    };
  }, [cwd, cleanup]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
