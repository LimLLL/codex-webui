/** A retained xterm view follows one durable terminal while binding input to its current physical shell. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from 'react-i18next';
import { getSocket } from '@/socket';
import { emitTerminalInput } from '@/lib/terminal-transport';
import { useTerminalStore } from '@/stores/terminal-store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  TerminalAck,
  TerminalMetadata,
  TerminalOutput,
} from '@/types/terminal';

interface Props {
  contextKey: string;
  terminalId: string;
  active: boolean;
  className?: string;
}
type Phase =
  | 'connecting'
  | 'ready'
  | 'disconnected'
  | 'error'
  | 'closed'
  | 'lost'
  | 'limited';

/** Keeps the latest replaced shell's local output separate from the new shell's reset VT state. */
function readOutput(term: Terminal): string {
  const lines: string[] = [];
  const buffer = term.buffer.active;
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').trimEnd();
}

/** Replacement is requested only while presented, and input is never buffered across connections. */
export function TerminalPane({
  contextKey,
  terminalId,
  active,
  className,
}: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const attachedRef = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const connectRef = useRef<(manual?: boolean) => void>(() => undefined);
  const terminal = useTerminalStore((s) => s.terminals[terminalId]);
  const closing = useTerminalStore((s) => s.closing[terminalId]);
  const [scrollback] = useState(useTerminalStore.getState().config.scrollback);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [failure, setFailure] = useState<string | null>(null);
  const [previousOutput, setPreviousOutput] = useState<string | null>(null);

  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  /** Hidden, unmeasured and disconnected panes never report geometry to a shared PTY. */
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
    if (attachedRef.current && sessionRef.current) {
      useTerminalStore
        .getState()
        .resizeTerminal(
          contextKey,
          terminalId,
          sessionRef.current,
          term.cols,
          term.rows,
        );
    }
  }, [contextKey, terminalId]);

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
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    const socket = getSocket();
    let disposed = false;
    let epoch = 0;
    let pending: Promise<void> | null = null;
    let replaying = true;
    let output: TerminalOutput[] = [];
    let sequence = 0;

    const showFailure = (response: TerminalAck) => {
      attachedRef.current = false;
      output = [];
      replaying = false;
      setFailure(response.error ?? t('Terminal operation failed'));
      setPhase(
        response.errorCode === 'terminal.closed'
          ? 'closed'
          : response.errorCode === 'terminal.recovery_limit'
            ? 'limited'
            : response.errorCode === 'terminal.session_lost'
              ? 'lost'
              : response.errorCode === 'terminal.disconnected'
                ? 'disconnected'
                : 'error',
      );
    };

    /** One local flight owns replay; transport changes and close invalidate its eventual result. */
    const connect = (manual = false) => {
      if (pending || disposed) return;
      if (!socket.connected) {
        setPhase('disconnected');
        return;
      }
      const requestEpoch = ++epoch;
      attachedRef.current = false;
      replaying = true;
      output = [];
      setPhase('connecting');
      const run = async () => {
        const store = useTerminalStore.getState();
        let response = await store.reconnectTerminal(contextKey, terminalId);
        if (disposed || requestEpoch !== epoch) return;
        // Only a known lost physical session may ask the backend to resolve durable eligibility.
        if (
          !response.ok &&
          response.errorCode === 'terminal.session_lost' &&
          activeRef.current
        ) {
          response = await store.recoverTerminal(
            contextKey,
            terminalId,
            manual,
          );
        }
        if (disposed || requestEpoch !== epoch) return;
        if (!response.ok || !response.terminal) {
          showFailure(response);
          return;
        }
        const current = useTerminalStore.getState();
        if (
          current.closing[terminalId] ||
          current.terminals[terminalId]?.status === 'closed' ||
          (current.terminals[terminalId]?.generation ?? 0) >
            response.terminal.generation
        )
          return;
        const observed = current.terminals[terminalId];
        const attachedTerminal =
          observed?.sessionId === response.terminal.sessionId
            ? observed
            : response.terminal;
        const changed =
          sessionRef.current !== null &&
          sessionRef.current !== attachedTerminal.sessionId;
        if (changed) {
          setPreviousOutput(readOutput(term));
          term.blur();
        }
        sessionRef.current = attachedTerminal.sessionId;
        sequence = response.sequence ?? 0;
        term.reset();
        if (response.state) term.write(response.state);
        for (const chunk of output) {
          if (
            chunk.sessionId === sessionRef.current &&
            chunk.sequence > sequence
          ) {
            term.write(chunk.data);
            sequence = chunk.sequence;
          }
        }
        output = [];
        replaying = false;
        attachedRef.current = attachedTerminal.status === 'running';
        setFailure(null);
        setPhase('ready');
        if (attachedTerminal.status === 'exited')
          term.write(
            `\r\n[${t('Process exited with code {{code}}', { code: attachedTerminal.exitCode ?? '?' })}]\r\n`,
          );
        requestAnimationFrame(() => {
          if (!disposed) fitVisible();
        });
      };
      const flight = run().finally(() => {
        if (pending === flight) pending = null;
      });
      pending = flight;
    };
    connectRef.current = connect;
    const handleConnect = () => connect();
    const handleDisconnect = () => {
      ++epoch;
      pending = null;
      attachedRef.current = false;
      replaying = true;
      output = [];
      term.blur();
      setPhase('disconnected');
    };
    const handleOutput = (event: TerminalOutput) => {
      if (event.terminalId !== terminalId || !socket.connected) return;
      if (replaying) {
        output.push(event);
        return;
      }
      if (event.sessionId !== sessionRef.current || event.sequence <= sequence)
        return;
      sequence = event.sequence;
      term.write(event.data);
    };
    const handleExit = (event: {
      terminal?: TerminalMetadata;
      terminalId?: string;
      closed?: boolean;
    }) => {
      if ((event.terminal?.id ?? event.terminalId) !== terminalId) return;
      if (event.closed) {
        ++epoch;
        pending = null;
        attachedRef.current = false;
        replaying = false;
        output = [];
        term.blur();
        setPhase('closed');
      } else if (event.terminal?.sessionId === sessionRef.current) {
        attachedRef.current = false;
        term.write(
          `\r\n[${t('Process exited with code {{code}}', { code: event.terminal.exitCode ?? '?' })}]\r\n`,
        );
      }
    };
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('terminal.output', handleOutput);
    socket.on('terminal.exit', handleExit);
    connect();
    const input = term.onData((data) => {
      const current = useTerminalStore.getState();
      if (
        !attachedRef.current ||
        !activeRef.current ||
        !socket.connected ||
        !sessionRef.current ||
        current.closing[terminalId]
      )
        return;
      emitTerminalInput(contextKey, terminalId, sessionRef.current, data);
    });
    return () => {
      disposed = true;
      ++epoch;
      connectRef.current = () => undefined;
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('terminal.output', handleOutput);
      socket.off('terminal.exit', handleExit);
      input.dispose();
      useTerminalStore.getState().detachTerminal(terminalId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      attachedRef.current = false;
    };
  }, [contextKey, terminalId, scrollback, fitVisible, t]);

  useEffect(() => {
    if (active && !attachedRef.current) connectRef.current();
  }, [active]);

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

  const closed = terminal?.status === 'closed' || phase === 'closed';
  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full flex-col bg-background',
        className,
      )}
      style={{ visibility: active ? 'visible' : 'hidden' }}
      inert={!active}
    >
      {terminal && terminal.generation > 0 && (
        <div
          role="status"
          className="shrink-0 border-b border-border px-3 py-2 text-xs"
        >
          {t(
            'Previous terminal was lost. Replacement shell {{shell}} started in {{cwd}}.',
            { shell: terminal.shell, cwd: terminal.cwd },
          )}
        </div>
      )}
      {previousOutput !== null && (
        <details className="shrink-0 border-b border-border px-3 py-1 text-xs">
          <summary>{t('Previous shell output (read-only)')}</summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap">
            {previousOutput || t('No retained output')}
          </pre>
        </details>
      )}
      {(phase !== 'ready' || closed || closing) && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs"
        >
          <span>
            {closed
              ? t('Terminal closed')
              : closing
                ? t('Terminal close is awaiting confirmation. Retry Close.')
                : phase === 'limited'
                  ? t('Automatic recovery paused: three attempts in 24 hours.')
                  : phase === 'lost'
                    ? t(
                        'Terminal session lost. Select this terminal to recover it.',
                      )
                    : phase === 'connecting'
                      ? t('Connecting terminal…')
                      : failure
                        ? // Natural-language keys are this project's convention, so a
                          // server message is localized when translated and shown as
                          // sent when not. The sentence is both lookup key and fallback.
                          t(failure)
                        : t('Terminal connection is offline')}
          </span>
          {!closed && !closing && phase !== 'connecting' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => connectRef.current(phase === 'limited')}
            >
              {phase === 'limited'
                ? t('Start replacement shell')
                : t('Retry connection')}
            </Button>
          )}
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
