/** Presented-only recovery and input isolation use the production pane/store with a controlled transport. */
import { beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { TerminalPane } from './terminal-pane';
import { useTerminalStore } from '@/stores/terminal-store';
import { useTerminalViewStore } from '@/stores/terminal-view-store';
import type { TerminalAck, TerminalMetadata } from '@/types/terminal';

const test = vi.hoisted(() => ({
  connected: true,
  id: 'first',
  calls: vi.fn(),
  input: (_data: string) => {
    void _data;
  },
  listeners: new Map<string, Set<(event?: unknown) => void>>(),
  writes: [] as string[],
  reply: (_event: string, _payload: Record<string, unknown>): TerminalAck => {
    void _event;
    void _payload;
    return { ok: false };
  },
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    get connected() {
      return test.connected;
    },
    get id() {
      return test.id;
    },
    on: (name: string, callback: (event?: unknown) => void) => {
      const listeners = test.listeners.get(name) ?? new Set();
      listeners.add(callback);
      test.listeners.set(name, listeners);
    },
    off: (name: string, callback: (event?: unknown) => void) =>
      test.listeners.get(name)?.delete(callback),
    emit: test.calls,
    sendBuffer: [],
    volatile: { emit: test.calls },
    timeout: () => ({
      emit: (
        event: string,
        payload: Record<string, unknown>,
        done: (error: null, response: TerminalAck) => void,
      ) => {
        test.calls(event, payload);
        done(null, test.reply(event, payload));
      },
    }),
  }),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    buffer = {
      active: {
        length: 1,
        getLine: () => ({ translateToString: () => 'old shell output' }),
      },
    };
    loadAddon() {}
    open() {}
    dispose() {}
    blur() {}
    reset() {
      test.writes = [];
    }
    write(data: string) {
      test.writes.push(data);
    }
    onData(callback: (data: string) => void) {
      test.input = callback;
      return { dispose: () => undefined };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: vi.fn() }));

const original = useTerminalStore.getState();
const terminal: TerminalMetadata = {
  id: 'terminal',
  sessionId: 'old',
  generation: 0,
  contextKey: 'thread:a',
  title: 'Build',
  shell: 'sh',
  cwd: '/workspace/project',
  status: 'running',
  exitCode: null,
  signal: null,
  attachedCount: 1,
  cols: 80,
  rows: 24,
  createdAt: '',
};
const replacement = { ...terminal, sessionId: 'new', generation: 1 };
const recoveries = () =>
  test.calls.mock.calls.filter(([event]) => event === 'terminal.recover');

/** Publishes a real connected destination, matching the retained host's visibility ownership. */
function present() {
  const element = document.createElement('div');
  document.body.append(element);
  useTerminalViewStore
    .getState()
    .present(terminal.id, terminal.contextKey, element);
  return element;
}
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  useTerminalStore.setState(original, true);
  useTerminalStore.getState().upsertTerminal(terminal);
  useTerminalViewStore.setState({
    retained: {},
    target: null,
    contextEpochs: {},
  });
  test.connected = true;
  test.id = 'first';
  test.calls.mockClear();
  test.listeners.clear();
  test.writes = [];
  test.reply = () => ({ ok: true, terminal, state: 'snapshot', sequence: 0 });
});

it('reattaches a hidden lost terminal without replacing it, then recovers once selected', async () => {
  test.reply = (event) =>
    event === 'terminal.recover'
      ? { ok: true, terminal: replacement, state: 'new shell', sequence: 0 }
      : { ok: false, errorCode: 'terminal.session_lost' };
  const view = render(
    <TerminalPane contextKey="thread:a" terminalId="terminal" active={false} />,
  );
  await waitFor(() =>
    expect(useTerminalStore.getState().terminals.terminal.status).toBe(
      'expired',
    ),
  );
  expect(recoveries()).toHaveLength(0);
  const destination = present();
  view.rerender(
    <TerminalPane contextKey="thread:a" terminalId="terminal" active />,
  );
  await waitFor(() => expect(recoveries()).toHaveLength(1));
  expect(
    await screen.findByText(
      'Previous terminal was lost. Replacement shell sh started in /workspace/project.',
    ),
  ).toBeTruthy();
  expect(useTerminalStore.getState().terminals.terminal.title).toBe('Build');
  destination.remove();
});

it('shows an explicit manual action after the automatic budget is exhausted', async () => {
  const destination = present();
  test.reply = (event, payload) =>
    event === 'terminal.recover'
      ? payload.manual
        ? { ok: true, terminal: replacement, state: '', sequence: 0 }
        : { ok: false, errorCode: 'terminal.recovery_limit' }
      : { ok: false, errorCode: 'terminal.session_lost' };
  render(<TerminalPane contextKey="thread:a" terminalId="terminal" active />);
  const manual = await screen.findByRole('button', {
    name: 'Start replacement shell',
  });
  expect(recoveries()).toHaveLength(1);
  fireEvent.click(manual);
  await waitFor(() => expect(recoveries()).toHaveLength(2));
  expect(recoveries()[1][1]).toMatchObject({ manual: true });
  destination.remove();
});

it('discards disconnected input, preserves old output separately and addresses new input to the replacement', async () => {
  const destination = present();
  render(<TerminalPane contextKey="thread:a" terminalId="terminal" active />);
  await waitFor(() => expect(test.writes).toContain('snapshot'));
  act(() => {
    test.connected = false;
    test.listeners.get('disconnect')?.forEach((callback) => callback());
  });
  test.input('must not replay\r');
  expect(
    test.calls.mock.calls.filter(([event]) => event === 'terminal.input'),
  ).toHaveLength(0);
  test.reply = (event) =>
    event === 'terminal.recover'
      ? {
          ok: true,
          terminal: replacement,
          state: 'replacement snapshot',
          sequence: 2,
        }
      : { ok: false, errorCode: 'terminal.session_lost' };
  act(() => {
    test.connected = true;
    test.id = 'second';
    test.listeners.get('connect')?.forEach((callback) => callback());
  });
  await waitFor(() => expect(test.writes).toContain('replacement snapshot'));
  expect(screen.getByText('Previous shell output (read-only)')).toBeTruthy();
  expect(screen.getByText('old shell output')).toBeTruthy();
  test.input('new command\r');
  expect(test.calls).toHaveBeenCalledWith('terminal.input', {
    contextKey: 'thread:a',
    terminalId: 'terminal',
    sessionId: 'new',
    data: 'new command\r',
  });
  destination.remove();
});

it('never interprets authorization or transport refusal as permission to replace', async () => {
  const destination = present();
  test.reply = () => ({
    ok: false,
    errorCode: 'auth.invalid_token',
    error: 'Authentication refused',
  });
  render(<TerminalPane contextKey="thread:a" terminalId="terminal" active />);
  expect(await screen.findByText('Authentication refused')).toBeTruthy();
  expect(recoveries()).toHaveLength(0);
  expect(useTerminalStore.getState().terminals.terminal.status).toBe('running');
  destination.remove();
});
