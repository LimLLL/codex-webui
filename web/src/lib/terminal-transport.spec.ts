/** Input stays reliable on a live transport while Socket.IO's offline send buffer never replays it. */
import { beforeEach, expect, it, vi } from 'vitest';
import { emitTerminalInput } from './terminal-transport';

const wire = vi.hoisted(() => ({
  connected: true,
  sendBuffer: [] as { data: unknown }[],
  emit: vi.fn(),
}));
vi.mock('@/socket', () => ({ getSocket: () => wire }));
beforeEach(() => {
  wire.connected = true;
  wire.sendBuffer = [];
  wire.emit.mockReset();
});

it('sends every connected input chunk without volatile delivery', () => {
  for (const data of ['echo ', 'complete', '\r'])
    emitTerminalInput('global', 't', 'physical', data);
  expect(
    wire.emit.mock.calls.map(
      ([, payload]) => (payload as { data: string }).data,
    ),
  ).toEqual(['echo ', 'complete', '\r']);
});

it('discards input queued by an expired transport without discarding unrelated requests', () => {
  wire.sendBuffer = [{ data: ['terminal.close', { terminalId: 'other' }] }];
  wire.emit.mockImplementation((event: string, payload: unknown) =>
    wire.sendBuffer.push({ data: [event, payload] }),
  );
  emitTerminalInput('global', 't', 'physical', 'do not replay\r');
  expect(wire.sendBuffer).toEqual([
    { data: ['terminal.close', { terminalId: 'other' }] },
  ]);
  wire.connected = false;
  emitTerminalInput('global', 't', 'physical', 'also discard\r');
  expect(wire.emit).toHaveBeenCalledTimes(1);
});
