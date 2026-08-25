import { ChildProcess } from 'node:child_process';
import { EventEmitter, Readable, Writable } from 'node:stream';
import { CodexRpcError } from './codex-errors';
import { CodexJsonRpcClient } from './codex-jsonrpc-client';

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
