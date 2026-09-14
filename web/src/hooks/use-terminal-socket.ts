/** Connects terminal socket events to the terminal metadata store. */
import { useEffect } from 'react';
import { getSocket } from '@/socket';
import { showSnackbar } from '@/stores/snackbar-store';
import { useTerminalStore } from '@/stores/terminal-store';
import type { TerminalMetadata } from '@/types/terminal';

export function useTerminalSocketEvents() {
  useEffect(() => {
    const socket = getSocket();

    const handleMetadata = (event: { terminal: TerminalMetadata }) => {
      const store = useTerminalStore.getState();
      // Attach emits metadata before its snapshot can fail. Only successful
      // open/attach acknowledgements may admit a new, selectable terminal. Keep
      // early lifecycle evidence in the metadata cache without creating a tab.
      const terminal = event.terminal;
      const previous = store.terminals[terminal.id];
      if (
        store.contexts[terminal.contextKey]?.terminalIds.includes(terminal.id)
      ) {
        store.upsertTerminal(terminal);
      } else if (
        !store.closing[terminal.id] &&
        previous?.status !== 'closed' &&
        (!previous || previous.generation <= terminal.generation) &&
        !(
          previous?.sessionId === terminal.sessionId &&
          previous.status === 'exited' &&
          terminal.status === 'running'
        )
      ) {
        useTerminalStore.setState({
          terminals: { ...store.terminals, [terminal.id]: terminal },
        });
      }
    };

    const handleExit = (event: {
      terminal?: TerminalMetadata;
      terminalId?: string;
      contextKey?: string;
      closed?: boolean;
    }) => {
      if (event.closed && event.terminalId && event.contextKey) {
        useTerminalStore
          .getState()
          .markTerminalClosed(event.contextKey, event.terminalId);
        return;
      }
      if (event.terminal) {
        handleMetadata({ terminal: event.terminal });
      }
    };

    const handleError = (event: { error?: string }) => {
      showSnackbar(event.error ?? 'Terminal operation failed', 'error');
    };

    socket.on('terminal.metadata', handleMetadata);
    socket.on('terminal.exit', handleExit);
    socket.on('terminal.error', handleError);

    return () => {
      socket.off('terminal.metadata', handleMetadata);
      socket.off('terminal.exit', handleExit);
      socket.off('terminal.error', handleError);
    };
  }, []);
}
