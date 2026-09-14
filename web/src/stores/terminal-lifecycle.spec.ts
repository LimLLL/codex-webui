/** Local view cleanup must never terminate a shared terminal process. */
import { beforeEach, expect, it, vi } from 'vitest';
import { useTerminalStore } from './terminal-store';
import { useTerminalViewStore } from './terminal-view-store';
import { useWorkspaceStore } from './workspace-store';
import type { TerminalAck, TerminalMetadata } from '@/types/terminal';

const transport = vi.hoisted(() => ({
  response: { ok: true } as TerminalAck,
  emit: vi.fn(),
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    emit: transport.emit,
    sendBuffer: [],
    connected: true,
    id: 'test-socket',
    timeout: () => ({
      emit: (
        event: string,
        payload: unknown,
        done: (error: null, response: TerminalAck) => void,
      ) => {
        transport.emit(event, payload);
        done(null, transport.response);
      },
    }),
  }),
}));
vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: vi.fn() }));
const original = useTerminalStore.getState();
const terminal: TerminalMetadata = {
  id: 'pty',
  sessionId: 'session-0',
  generation: 0,
  contextKey: 'thread:a',
  title: 'shell',
  cwd: '/workspace',
  shell: 'sh',
  status: 'running',
  exitCode: null,
  signal: null,
  attachedCount: 2,
  cols: 80,
  rows: 24,
  createdAt: '',
};
beforeEach(() => {
  useTerminalStore.setState(original, true);
  useTerminalViewStore.setState({
    retained: {},
    target: null,
    contextEpochs: {},
  });
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
  transport.response = { ok: true };
  transport.emit.mockReset();
  useTerminalStore.getState().upsertTerminal(terminal);
  useTerminalViewStore.getState().retain('pty', 'thread:a');
  useWorkspaceStore.getState().openTerminal('thread:a', 'pty');
});

it('withdraws presentation and deletes local collections without sending close', () => {
  const element = document.createElement('div');
  const views = useTerminalViewStore.getState();
  views.present('pty', 'thread:a', element);
  views.withdraw(element);
  expect(useTerminalViewStore.getState().retained.pty).toBe('thread:a');
  useWorkspaceStore.getState().forgetConversations(['a']);
  expect(useTerminalViewStore.getState().retained.pty).toBeUndefined();
  expect(transport.emit).not.toHaveBeenCalled();
  expect(useTerminalStore.getState().terminals.pty.status).toBe('running');
});

it('keeps the attachment and usable metadata after a rejected shared close', async () => {
  transport.response = { ok: false, error: 'close refused' };
  await expect(
    useTerminalStore.getState().closeTerminal('thread:a', 'pty'),
  ).resolves.toBe(false);
  expect(useTerminalViewStore.getState().retained.pty).toBe('thread:a');
  expect(useTerminalStore.getState().terminals.pty.status).toBe('running');
});

it('releases local attachment only after explicit shared close succeeds', async () => {
  await expect(
    useTerminalStore.getState().closeTerminal('thread:a', 'pty'),
  ).resolves.toBe(true);
  expect(transport.emit).toHaveBeenCalledExactlyOnceWith('terminal.close', {
    contextKey: 'thread:a',
    terminalId: 'pty',
  });
  expect(useTerminalViewStore.getState().retained.pty).toBeUndefined();
});

it('retains output ownership and the local tab when another browser closes the session', () => {
  useTerminalStore.getState().markTerminalClosed('thread:a', 'pty');
  expect(useTerminalStore.getState().terminals.pty.status).toBe('closed');
  expect(useTerminalViewStore.getState().retained.pty).toBe('thread:a');
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
    1,
  );
});

it('opening a file never requests or restores a terminal process', () => {
  useWorkspaceStore.getState().openFile('thread:b', '/workspace/a.ts');
  expect(transport.emit).not.toHaveBeenCalled();
  expect(useWorkspaceStore.getState().contexts['thread:b'].tabs).toHaveLength(
    1,
  );
});

it('does not create a process when restoring an empty context, or expire sessions on list failure', async () => {
  transport.response = { ok: true, terminals: [] };
  useTerminalStore.setState({ configLoaded: true });
  await useTerminalStore.getState().ensureContext('empty');
  expect(transport.emit).toHaveBeenCalledExactlyOnceWith('terminal.list', {
    contextKey: 'empty',
  });
  transport.response = { ok: false, error: 'offline' };
  await useTerminalStore.getState().ensureContext('thread:a');
  expect(useTerminalStore.getState().terminals.pty.status).toBe('running');
});
