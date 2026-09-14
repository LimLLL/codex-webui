/** Conversation opening and socket reconnect discover existing sessions without creating shells. */
import { useEffect } from 'react';
import { getSocket } from '@/socket';
import { useTerminalStore } from '@/stores/terminal-store';

/** Discovery targets its original context and preserves selection when navigation finishes first. */
export function useTerminalDiscovery(contextKey: string): void {
  useEffect(() => {
    const socket = getSocket();
    const discover = () => {
      void useTerminalStore.getState().ensureContext(contextKey);
    };
    socket.on('connect', discover);
    if (socket.connected) discover();
    return () => {
      socket.off('connect', discover);
    };
  }, [contextKey]);
}
