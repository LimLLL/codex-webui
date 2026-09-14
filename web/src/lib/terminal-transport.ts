/** Typed terminal request/response transport; disconnected writes are never buffered for later execution. */
import { getSocket } from '@/socket';
import type { TerminalAck } from '@/types/terminal';

/**
 * Keeps connected keystrokes reliable, but discards any packet Socket.IO queues
 * after detecting an expired transport. `sendBuffer` is public in Socket.IO's
 * types, but this behavior is verified against the installed client's real emit
 * implementation. Volatile delivery would drop connected input under backpressure.
 */
export function emitTerminalInput(
  contextKey: string,
  terminalId: string,
  sessionId: string,
  data: string,
): void {
  const socket = getSocket();
  if (!socket.connected) return;
  socket.emit('terminal.input', { contextKey, terminalId, sessionId, data });
  if (socket.sendBuffer.length) {
    socket.sendBuffer = socket.sendBuffer.filter((packet) => {
      const payload: unknown = packet.data;
      return !Array.isArray(payload) || payload[0] !== 'terminal.input';
    });
  }
}

/** A timeout describes missing acknowledgement, never missing terminal identity. */
export function emitTerminalAck<T = unknown>(
  event: string,
  payload: Record<string, unknown>,
): Promise<TerminalAck<T>> {
  const socket = getSocket();
  if (!socket.connected)
    return Promise.resolve({
      ok: false,
      errorCode: 'terminal.disconnected',
      error: 'Terminal connection is offline',
    });
  const connectionId = socket.id;
  return new Promise((resolve) => {
    socket
      .timeout(10_000)
      .emit(
        event,
        payload,
        (error: Error | null, response?: TerminalAck<T>) => {
          if (socket.id !== connectionId || !socket.connected) {
            resolve({
              ok: false,
              errorCode: 'terminal.disconnected',
              error: 'Terminal connection changed',
            });
          } else if (error) {
            resolve({
              ok: false,
              errorCode: 'terminal.transport_timeout',
              error: 'Terminal request timed out; its outcome is unknown',
            });
          } else {
            resolve(
              response ?? {
                ok: false,
                errorCode: 'terminal.invalid_response',
                error: 'Empty terminal response',
              },
            );
          }
        },
      );
    // connected can remain true until a deferred ping-timeout callback runs.
    // Do not let an operation issued on that transport execute after reconnect.
    const buffered = socket.sendBuffer.findIndex((packet) => {
      const data: unknown = packet.data;
      return Array.isArray(data) && data[0] === event && data[1] === payload;
    });
    if (buffered !== -1) {
      socket.sendBuffer.splice(buffered, 1);
      resolve({
        ok: false,
        errorCode: 'terminal.disconnected',
        error: 'Terminal connection is offline',
      });
    }
  });
}

/** Downloads plain text from a retained terminal buffer. */
export function saveTerminalOutput(content: string, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([content], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
