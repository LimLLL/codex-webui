import { ChildProcess } from 'node:child_process';
import { EventEmitter, Readable, Writable } from 'node:stream';
import { CodexRpcError } from './codex-errors';
import {
  CodexJsonRpcClient,
  serializeCodexAuditEntry,
} from './codex-jsonrpc-client';

function createMockProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  proc.kill = vi.fn();
  return proc;
}

describe('CodexJsonRpcClient', () => {
  let proc: ChildProcess;
  let client: CodexJsonRpcClient;

  beforeEach(() => {
    proc = createMockProcess();
    client = new CodexJsonRpcClient(proc);
  });

  afterEach(() => {
    client.destroy();
  });

  it('should resolve request when response arrives', async () => {
    const promise = client.request<{ ok: boolean }>('test/method', { foo: 1 });

    // Simulate server response on stdout
    proc.stdout!.push(JSON.stringify({ id: 1, result: { ok: true } }) + '\n');

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('should reject request on structured error response', async () => {
    const promise = client.request('test/fail', {});

    proc.stdout!.push(
      JSON.stringify({
        id: 1,
        error: { code: -1, message: 'boom', data: { reason: 'bad' } },
      }) + '\n',
    );

    await expect(promise).rejects.toMatchObject({
      code: -1,
      data: { reason: 'bad' },
      method: 'test/fail',
      requestId: 1,
    } satisfies Partial<CodexRpcError>);
  });

  it('should emit notification events', async () => {
    const received = new Promise((resolve) =>
      client.once('notification', resolve),
    );

    proc.stdout!.push(
      JSON.stringify({ method: 'thread/started', params: { threadId: 't1' } }) +
        '\n',
    );

    await expect(received).resolves.toEqual({
      method: 'thread/started',
      params: { threadId: 't1' },
    });
  });

  it('redacts misalignment explanation and steering from the audit line', () => {
    const line = serializeCodexAuditEntry('in', {
      method: 'error',
      params: {
        error: {
          message: 'blocked',
          misalignment: {
            errorType: 'policy',
            detailedExplanation: 'private explanation',
            steer: { message: 'private continuation' },
          },
        },
      },
    });

    expect(line).not.toContain('private explanation');
    expect(line).not.toContain('private continuation');
    expect(line).toContain('[REDACTED]');
  });

  it('should emit serverRequest events', async () => {
    const received = new Promise((resolve) =>
      client.once('serverRequest', resolve),
    );

    proc.stdout!.push(
      JSON.stringify({
        method: 'item/commandExecution/requestApproval',
        id: 99,
        params: { command: 'rm -rf' },
      }) + '\n',
    );

    await expect(received).resolves.toEqual({
      method: 'item/commandExecution/requestApproval',
      id: 99,
      params: { command: 'rm -rf' },
    });
  });

  it('should send initialized notification after initialize', async () => {
    const writeSpy = vi.spyOn(proc.stdin!, 'write');

    const promise = client.initialize({
      clientInfo: { name: 'test', title: null, version: '0.0.1' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });

    proc.stdout!.push(
      JSON.stringify({
        id: 1,
        result: {
          userAgent: 'codex/0.1',
          codexHome: '/home/.codex',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      }) + '\n',
    );

    const result = await promise;
    expect(result.codexHome).toBe('/home/.codex');

    // Second write should be the `initialized` notification
    expect(writeSpy).toHaveBeenCalledTimes(2);
    const secondCall = writeSpy.mock.calls[1][0] as string;
    expect(JSON.parse(secondCall.toString())).toEqual({
      method: 'initialized',
      params: {},
    });
  });

  it('should reject pending requests on timeout', async () => {
    const shortClient = new CodexJsonRpcClient(proc, 50);
    const promise = shortClient.request('slow/method', {});
    await expect(promise).rejects.toThrow('timed out');
    shortClient.destroy();
  });

  it('should reject pending requests on destroy', async () => {
    const promise = client.request('test/method', {});
    client.destroy();
    await expect(promise).rejects.toThrow('Client destroyed');
  });
});

/** These cases exercise transport ordering, not just the standalone ledger. */
describe('CodexJsonRpcClient accepted work', () => {
  let proc: ChildProcess;
  let client: CodexJsonRpcClient;
  const receive = (value: unknown) =>
    proc.stdout!.push(JSON.stringify(value) + '\n');
  beforeEach(() => {
    proc = createMockProcess();
    client = new CodexJsonRpcClient(proc, 20);
  });
  afterEach(() => {
    client.destroy();
    proc.emit('close', 0, null);
  });
  it('keeps an ambiguous timeout until a late response and correlated completion arrive', async () => {
    const request = client.request('turn/start', { threadId: 't' });
    await expect(request).rejects.toThrow('timed out');
    expect(client.acceptedWork.blockers()).toHaveLength(1);
    const terminal = new Promise((resolve) =>
      client.once('notification', resolve),
    );
    receive({ id: 1, result: { turn: { id: 'turn', status: 'inProgress' } } });
    receive({
      method: 'turn/completed',
      params: { threadId: 't', turn: { id: 'turn', status: 'completed' } },
    });
    await terminal;
    expect(client.acceptedWork.blockers()).toEqual([]);
  });
  it('distinguishes explicit refusal from an uncertain internal error', async () => {
    const refused = client.request('turn/start', { threadId: 't' });
    receive({ id: 1, error: { code: -32600, message: 'refused' } });
    await expect(refused).rejects.toThrow('refused');
    expect(client.acceptedWork.blockers()).toEqual([]);
    const uncertain = client.request('turn/start', { threadId: 't' });
    receive({ id: 2, error: { code: -32603, message: 'internal' } });
    await expect(uncertain).rejects.toThrow('internal');
    expect(client.acceptedWork.blockers()).toHaveLength(1);
  });
  it('does not clear work on a kill request, only on actual exit', async () => {
    const request = client.request('thread/compact/start', { threadId: 't' });
    receive({ id: 1, result: {} });
    await request;
    client.destroy();
    expect(client.acceptedWork.blockers()).toHaveLength(1);
    proc.emit('close', 0, null);
    expect(client.acceptedWork.blockers()).toEqual([]);
  });
});
