/** Lifecycle notifications update admitted terminals; they cannot bypass discovery's attachment result. */
import { beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTerminalSocketEvents } from './use-terminal-socket';
import { useTerminalStore } from '@/stores/terminal-store';
import type { TerminalMetadata } from '@/types/terminal';

const handlers = vi.hoisted(() => new Map<string, (value: unknown) => void>());
vi.mock('@/socket', () => ({
  getSocket: () => ({
    on: (name: string, handler: (value: unknown) => void) =>
      handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
  }),
}));
vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: vi.fn() }));

const initial = useTerminalStore.getState();
const terminal: TerminalMetadata = {
  id: 't',
  contextKey: 'global',
  sessionId: 'pty',
  generation: 0,
  title: 'Shell',
  cwd: '/workspace',
  shell: 'sh',
  status: 'running',
  exitCode: null,
  signal: null,
  attachedCount: 1,
  cols: 80,
  rows: 24,
  createdAt: '',
};
beforeEach(() => {
  handlers.clear();
  useTerminalStore.setState(initial, true);
});

it('does not create selectable global tabs from metadata emitted before a discovery attach succeeds', () => {
  renderHook(useTerminalSocketEvents);
  act(() => handlers.get('terminal.metadata')?.({ terminal }));
  expect(
    useTerminalStore.getState().contexts.global?.terminalIds ?? [],
  ).toEqual([]);
  expect(useTerminalStore.getState().terminals.t).toEqual(terminal);
});

it('retains an early natural exit without admitting a tab until attachment succeeds', () => {
  renderHook(useTerminalSocketEvents);
  act(() =>
    handlers.get('terminal.exit')?.({
      terminal: { ...terminal, status: 'exited', exitCode: 7 },
      closed: false,
    }),
  );
  expect(
    useTerminalStore.getState().contexts.global?.terminalIds ?? [],
  ).toEqual([]);
  act(() => useTerminalStore.getState().upsertTerminal(terminal));
  expect(useTerminalStore.getState().contexts.global.terminalIds).toEqual([
    't',
  ]);
  expect(useTerminalStore.getState().terminals.t).toMatchObject({
    status: 'exited',
    exitCode: 7,
  });
});

it('keeps updating admitted terminals and remembers closure that precedes their first acknowledgement', () => {
  renderHook(useTerminalSocketEvents);
  act(() => useTerminalStore.getState().upsertTerminal(terminal));
  act(() =>
    handlers.get('terminal.metadata')?.({
      terminal: { ...terminal, attachedCount: 2 },
    }),
  );
  expect(useTerminalStore.getState().terminals.t.attachedCount).toBe(2);
  act(() =>
    handlers.get('terminal.exit')?.({
      closed: true,
      terminalId: 'new',
      contextKey: 'global',
    }),
  );
  act(() =>
    useTerminalStore.getState().upsertTerminal({ ...terminal, id: 'new' }),
  );
  expect(useTerminalStore.getState().terminals.new).toBeUndefined();
});
