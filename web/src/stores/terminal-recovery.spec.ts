/** Discovery, closure and transport races must never manufacture replacement intent. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTerminalStore } from './terminal-store';
import { useTerminalViewStore } from './terminal-view-store';
import { useWorkspaceStore } from './workspace-store';
import type { TerminalAck, TerminalMetadata } from '@/types/terminal';

const wire = vi.hoisted(() => ({
  connected: true,
  id: 'connection',
  emit: vi.fn(),
  respond: (
    _event: string,
    _payload: Record<string, unknown>,
    done: (error: Error | null, response?: TerminalAck) => void,
  ) => done(null, { ok: true }),
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    get connected() {
      return wire.connected;
    },
    get id() {
      return wire.id;
    },
    emit: wire.emit,
    sendBuffer: [],
    timeout: () => ({
      emit: (
        event: string,
        payload: Record<string, unknown>,
        done: (error: Error | null, response?: TerminalAck) => void,
      ) => {
        wire.emit(event, payload);
        wire.respond(event, payload, done);
      },
    }),
  }),
}));
vi.mock('@/stores/snackbar-store', () => ({ showSnackbar: vi.fn() }));

const initial = useTerminalStore.getState();
const metadata = (id = 't'): TerminalMetadata => ({
  id,
  sessionId: `${id}-0`,
  generation: 0,
  contextKey: 'thread:a',
  title: id,
  shell: 'sh',
  cwd: '/workspace',
  status: 'running',
  exitCode: null,
  signal: null,
  attachedCount: 1,
  cols: 80,
  rows: 24,
  createdAt: '',
});
type Reply = (error: Error | null, response?: TerminalAck) => void;

beforeEach(() => {
  useTerminalStore.setState(initial, true);
  useTerminalViewStore.setState({
    retained: {},
    target: null,
    contextEpochs: {},
  });
  useWorkspaceStore.setState({ contexts: {}, fileViews: {} });
  wire.connected = true;
  wire.id = 'connection';
  wire.emit.mockClear();
  wire.respond = (_event, _payload, done) => done(null, { ok: true });
});
afterEach(() => document.body.replaceChildren());

it('adopts running and exited sessions once without selecting them or sending a creation request', async () => {
  useWorkspaceStore.getState().openFile('thread:a', '/workspace/file.ts');
  const terminals = [
    metadata('running'),
    { ...metadata('exited'), status: 'exited' as const, exitCode: 0 },
  ];
  wire.respond = (event, payload, done) =>
    done(
      null,
      event === 'terminal.list'
        ? { ok: true, terminals }
        : {
            ok: true,
            terminal: terminals.find(
              (terminal) => terminal.id === payload.terminalId,
            ),
            state: '',
            sequence: 0,
          },
    );
  await Promise.all([
    useTerminalStore.getState().ensureContext('thread:a'),
    useTerminalStore.getState().ensureContext('thread:a'),
  ]);
  await useTerminalStore.getState().ensureContext('thread:a');
  expect(useWorkspaceStore.getState().contexts['thread:a'].tabs).toHaveLength(
    3,
  );
  const active = useWorkspaceStore.getState().contexts['thread:a'].tabs.find(
    (tab) => tab.id === useWorkspaceStore.getState().contexts['thread:a'].activeId,
  );
  expect(active).toMatchObject({ kind: 'file', path: '/workspace/file.ts' });
  expect(useTerminalStore.getState().terminals.exited.status).toBe('exited');
  expect(
    wire.emit.mock.calls.every(([event]) =>
      ['terminal.list', 'terminal.reconnect'].includes(event as string),
    ),
  ).toBe(true);
});

it('omits a session reclaimed between listing and attachment, without replacing it', async () => {
  wire.respond = (event, _payload, done) =>
    done(
      null,
      event === 'terminal.list'
        ? { ok: true, terminals: [metadata()] }
        : { ok: false, errorCode: 'terminal.session_lost' },
    );
  await useTerminalStore.getState().ensureContext('thread:a');
  expect(useWorkspaceStore.getState().contexts['thread:a']).toBeUndefined();
  expect(useTerminalViewStore.getState().retained).toEqual({});
  expect(wire.emit.mock.calls.map(([event]) => event)).toEqual([
    'terminal.list',
    'terminal.reconnect',
  ]);
});

it('does not re-adopt a terminal when close overtakes its first attachment acknowledgement', async () => {
  let reply!: Reply;
  wire.respond = (event, _payload, done) => {
    if (event === 'terminal.list')
      done(null, { ok: true, terminals: [metadata()] });
    else reply = done;
  };
  const discovery = useTerminalStore.getState().ensureContext('thread:a');
  await vi.waitFor(() => expect(reply).toBeDefined());
  useTerminalStore.getState().markTerminalClosed('thread:a', 't');
  reply(null, { ok: true, terminal: metadata(), state: '' });
  await discovery;
  expect(useWorkspaceStore.getState().contexts['thread:a']).toBeUndefined();
  expect(useTerminalViewStore.getState().retained).toEqual({});
});

it('does not resurrect a deleted context from a delayed attachment', async () => {
  let reply!: Reply;
  wire.respond = (event, _payload, done) => {
    if (event === 'terminal.list')
      done(null, { ok: true, terminals: [metadata()] });
    else reply = done;
  };
  const discovery = useTerminalStore.getState().ensureContext('thread:a');
  await vi.waitFor(() => expect(reply).toBeDefined());
  useWorkspaceStore.getState().forgetConversations(['a']);
  reply(null, { ok: true, terminal: metadata(), state: '' });
  await discovery;
  expect(useWorkspaceStore.getState().contexts['thread:a']).toBeUndefined();
  expect(useTerminalViewStore.getState().retained).toEqual({});
});

it('orders an explicit New action after discovery and preserves that additional intent', async () => {
  let reply!: Reply;
  wire.respond = (event, _payload, done) => {
    if (event === 'terminal.list') reply = done;
    else
      done(null, {
        ok: true,
        terminal: metadata(event === 'terminal.open' ? 'new' : 'old'),
      });
  };
  const discovery = useTerminalStore.getState().ensureContext('thread:a');
  const create = useTerminalStore
    .getState()
    .createTerminal('thread:a', '/workspace');
  expect(wire.emit.mock.calls.map(([event]) => event)).toEqual([
    'terminal.list',
  ]);
  reply(null, { ok: true, terminals: [metadata('old')] });
  await discovery;
  expect((await create)?.id).toBe('new');
  expect(useTerminalStore.getState().contexts['thread:a'].terminalIds).toEqual([
    'old',
    'new',
  ]);
  expect(
    wire.emit.mock.calls.filter(([event]) => event === 'terminal.open'),
  ).toHaveLength(1);
});

it.each(['exited', 'expired'] as const)(
  'sends logical close for a %s terminal',
  async (status) => {
    useTerminalStore.getState().upsertTerminal({ ...metadata(), status });
    await expect(
      useTerminalStore.getState().closeTerminal('thread:a', 't'),
    ).resolves.toBe(true);
    expect(wire.emit).toHaveBeenCalledWith('terminal.close', {
      contextKey: 'thread:a',
      terminalId: 't',
    });
  },
);

it('keeps timeout, authorization, context mismatch and genuine loss distinct', async () => {
  useTerminalStore.getState().upsertTerminal(metadata());
  wire.respond = (_event, _payload, done) => done(new Error('timeout'));
  expect(
    (await useTerminalStore.getState().reconnectTerminal('thread:a', 't'))
      .errorCode,
  ).toBe('terminal.transport_timeout');
  expect(useTerminalStore.getState().terminals.t.status).toBe('running');
  for (const errorCode of [
    'auth.invalid_token',
    'terminal.context_mismatch',
    'terminal.socket_not_attached',
  ]) {
    wire.respond = (_event, _payload, done) =>
      done(null, { ok: false, errorCode });
    expect(
      (await useTerminalStore.getState().reconnectTerminal('thread:a', 't'))
        .errorCode,
    ).toBe(errorCode);
    expect(useTerminalStore.getState().terminals.t.status).toBe('running');
  }
  wire.respond = (_event, _payload, done) =>
    done(null, { ok: false, errorCode: 'terminal.session_lost' });
  await useTerminalStore.getState().reconnectTerminal('thread:a', 't');
  expect(useTerminalStore.getState().terminals.t.status).toBe('expired');
  expect(
    wire.emit.mock.calls.every(([event]) => event === 'terminal.reconnect'),
  ).toBe(true);
});

it('refuses recovery for hidden views and never buffers offline requests', async () => {
  useTerminalStore.getState().upsertTerminal(metadata());
  expect(
    (await useTerminalStore.getState().recoverTerminal('thread:a', 't', false))
      .errorCode,
  ).toBe('terminal.not_presented');
  wire.connected = false;
  expect(
    (await useTerminalStore.getState().reconnectTerminal('thread:a', 't'))
      .errorCode,
  ).toBe('terminal.disconnected');
  expect(wire.emit).not.toHaveBeenCalled();
});

it('does not turn an unconfirmed close into a confirmed closed result on reattachment', async () => {
  useTerminalStore.getState().upsertTerminal(metadata());
  wire.respond = (_event, _payload, done) =>
    done(new Error('lost close acknowledgement'));
  await expect(
    useTerminalStore.getState().closeTerminal('thread:a', 't'),
  ).resolves.toBe(false);
  const response = await useTerminalStore
    .getState()
    .reconnectTerminal('thread:a', 't');
  expect(response.errorCode).not.toBe('terminal.closed');
  expect(useTerminalStore.getState().terminals.t.status).toBe('running');
  expect(useTerminalStore.getState().closing.t).toBe(true);
});

it('ignores the previous connection failure after a new connection has attached successfully', async () => {
  useTerminalStore.getState().upsertTerminal(metadata());
  let previous!: Reply;
  wire.respond = (_event, _payload, done) => {
    previous = done;
  };
  const oldRequest = useTerminalStore
    .getState()
    .reconnectTerminal('thread:a', 't');
  wire.id = 'next-connection';
  const next = { ...metadata(), sessionId: 'new-pty', generation: 1 };
  wire.respond = (_event, _payload, done) =>
    done(null, { ok: true, terminal: next, state: '' });
  await useTerminalStore.getState().reconnectTerminal('thread:a', 't');
  previous(new Error('old connection ended'));
  await oldRequest;
  expect(useTerminalStore.getState().terminals.t).toEqual(next);
});

it('does not let a same-session stale attachment acknowledgement reverse a natural exit', async () => {
  useTerminalStore.getState().upsertTerminal(metadata());
  let reply!: Reply;
  wire.respond = (_event, _payload, done) => {
    reply = done;
  };
  const attaching = useTerminalStore
    .getState()
    .reconnectTerminal('thread:a', 't');
  useTerminalStore
    .getState()
    .upsertTerminal({ ...metadata(), status: 'exited', exitCode: 23 });
  reply(null, { ok: true, terminal: metadata(), state: '' });
  const result = await attaching;
  expect(useTerminalStore.getState().terminals.t).toMatchObject({
    status: 'exited',
    exitCode: 23,
  });
  expect(result.terminal).toMatchObject({ status: 'exited', exitCode: 23 });
});

it('rejects an attachment acknowledged just before the connection changed, before its continuation runs', async () => {
  let reply!: Reply;
  wire.respond = (_event, _payload, done) => {
    reply = done;
  };
  const oldRequest = useTerminalStore
    .getState()
    .reconnectTerminal('thread:a', 't');
  reply(null, { ok: true, terminal: metadata(), state: '' });
  wire.id = 'next-connection';
  await expect(oldRequest).resolves.toMatchObject({
    ok: false,
    errorCode: 'terminal.superseded',
  });
  expect(useTerminalStore.getState().terminals.t).toBeUndefined();
});
