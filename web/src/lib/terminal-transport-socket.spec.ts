/** Exercises actual Socket.IO emit/buffer behavior without connecting to an external server. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Manager, Socket } from 'socket.io-client';
import { emitTerminalAck, emitTerminalInput } from './terminal-transport';

const owner = vi.hoisted(() => ({ socket: null as Socket | null }));
vi.mock('@/socket', () => ({ getSocket: () => owner.socket }));

let socket: Socket;
let expired: boolean;
let writable: boolean;
let sent: ReturnType<typeof vi.fn<Manager['_packet']>>;

beforeEach(() => {
  const manager = new Manager('http://localhost', { autoConnect: false });
  socket = new Socket(manager, '/ws');
  owner.socket = socket;
  socket.connected = true;
  socket.id = 'connection';
  expired = false;
  writable = true;
  sent = vi.fn<Manager['_packet']>();
  // Only the engine/network boundary is substituted; Socket.emit and ACK cleanup are real.
  manager.engine = {
    transport: {
      get writable() {
        return writable;
      },
    },
    _hasPingExpired: () => expired,
  } as unknown as Manager['engine'];
  vi.spyOn(manager, '_packet').mockImplementation(sent);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('retains reliable connected input under backpressure and discards input discovered to be offline', () => {
  writable = false;
  emitTerminalInput('global', 't', 'pty', 'echo complete\r');
  expect(sent).toHaveBeenCalledTimes(1);
  expired = true;
  emitTerminalInput('global', 't', 'pty', 'do not replay\r');
  expect(socket.sendBuffer).toEqual([]);
  expect(sent).toHaveBeenCalledTimes(1);
});

it.each([
  'terminal.open',
  'terminal.recover',
  'terminal.close',
  'terminal.reconnect',
])(
  'does not retain an expired-transport %s request for reconnection',
  async (event) => {
    expired = true;
    const pending = emitTerminalAck(event, {
      contextKey: 'global',
      terminalId: 't',
      manual: false,
    });
    expect(socket.sendBuffer).toEqual([]);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      errorCode: 'terminal.disconnected',
    });
    expect(sent).not.toHaveBeenCalled();
  },
);
