/** Exercises real connection ownership through the manager's child replacement paths. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexProcessManager } from './codex-process-manager.service';
import { catalogFixture } from './catalog/catalog.testing';
import type {
  OwnedServerRequest,
  ServerRequestRetirement,
} from './server-request-owner';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

/** Answers only startup RPCs, leaving server-initiated approvals owned by the real client. */
function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit('close', 0, null);
      return true;
    }),
  });
  child.stdin.on('data', (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString()) as {
      id?: number;
      method?: string;
    };
    if (!message.method || message.id === undefined) return;
    const result =
      message.method === 'initialize'
        ? {
            userAgent: 'test',
            codexHome: 'test',
            platformFamily: 'test',
            platformOs: 'test',
          }
        : message.method === 'config/read'
          ? { config: {} }
          : { data: [], nextCursor: null };
    queueMicrotask(() =>
      child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'),
    );
  });
  return child;
}

describe('manager request retirement', () => {
  let fixture: ReturnType<typeof catalogFixture>;
  let manager: CodexProcessManager;
  let children: ReturnType<typeof childFixture>[];
  let held: OwnedServerRequest[];
  let retirements: ServerRequestRetirement[];
  let order: string[];

  beforeEach(() => {
    fixture = catalogFixture();
    manager = new CodexProcessManager(fixture.storage);
    children = [];
    held = [];
    retirements = [];
    order = [];
    mocks.spawn.mockImplementation(() => {
      const child = childFixture();
      children.push(child);
      return child;
    });
    manager.setServerRequestHandler((request) => {
      held.push(request);
      return true;
    });
    manager.addListener(
      'serverRequestRetired',
      (event: ServerRequestRetirement) => {
        retirements.push(event);
        order.push('retired');
      },
    );
    manager.addListener('close', () => order.push('close'));
    manager.addLifecycleListener((event) => order.push(event.type));
  });

  afterEach(() => {
    manager.onModuleDestroy();
    fixture.cleanup();
    mocks.spawn.mockReset();
    vi.useRealTimers();
  });

  /** Emits a new request through stdout, never through the manager's observers. */
  function request(child = children.at(-1)!) {
    child.stdout.write(
      JSON.stringify({
        id: 0,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 't',
          turnId: 'turn',
          itemId: 'item',
          command: 'pwd',
        },
      }) + '\n',
    );
  }

  it.each(['crash', 'controlled', 'shutdown'] as const)(
    'retires the original owner before %s removes its connection identity',
    async (path) => {
      await manager.onModuleInit();
      const lateRetirement = vi.fn();
      manager.addListener('serverRequestRetired', lateRetirement);
      const lateClose = vi.fn();
      manager.addListener('close', lateClose);
      request();
      const original = held[0];
      order.length = 0;
      if (path === 'crash') {
        children[0].emit('close', 1, null);
        manager.suspendRetries();
        await manager.restartControlled();
      } else if (path === 'controlled') await manager.restartControlled();
      else manager.onModuleDestroy();
      expect(retirements).toMatchObject([
        { instanceId: original.instanceId, status: 'expired' },
      ]);
      expect(lateRetirement).toHaveBeenCalledOnce();
      expect(lateClose).toHaveBeenCalledOnce();
      expect(order.indexOf('retired')).toBeLessThan(order.indexOf('close'));
      expect(order.indexOf('close')).toBeLessThan(
        order.indexOf('appServerUnavailable'),
      );
      expect(() => original.respond({ decision: 'accept' })).toThrow(
        'no longer pending',
      );
      if (path !== 'shutdown') {
        // Old buffered frames cannot retire a replacement request with wire ID 0.
        request();
        children[0].stdout.write(
          JSON.stringify({
            method: 'serverRequest/resolved',
            params: { threadId: 't', requestId: 0 },
          }) + '\n',
        );
        expect(held[1].isPending()).toBe(true);
        expect(retirements).toHaveLength(1);
        expect(held[1].instanceId).not.toBe(original.instanceId);
      }
    },
  );

  it('retires immediately when shutdown times out and never replaces the still-live child', async () => {
    await manager.onModuleInit();
    request();
    children[0].kill.mockImplementation(() => true);
    vi.useFakeTimers();
    const restart = manager.restartControlled();
    const rejected = expect(restart).rejects.toThrow('did not exit');
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(retirements).toMatchObject([
      { instanceId: held[0].instanceId, status: 'expired' },
    ]);
    expect(children).toHaveLength(1);
    children[0].emit('close', 0, null);
    expect(retirements).toHaveLength(1);
    await manager.restartControlled();
    request();
    expect(held[1].isPending()).toBe(true);
  });

  it('retires admission from a candidate rejected before it becomes ready', async () => {
    await manager.onModuleInit();
    await expect(
      manager.restartControlled(() => {
        request();
        throw new Error('candidate rejected');
      }),
    ).rejects.toThrow('candidate rejected');
    expect(retirements).toMatchObject([
      { instanceId: held[0].instanceId, status: 'expired' },
    ]);
    expect(held[0].isPending()).toBe(false);
    expect(manager.getClient()).toBeNull();
  });

  it('retires before an asynchronous shutdown close arrives after manager destruction', async () => {
    await manager.onModuleInit();
    request();
    children[0].kill.mockImplementation(() => {
      queueMicrotask(() => children[0].emit('close', 0, null));
      return true;
    });
    manager.onModuleDestroy();
    expect(retirements).toMatchObject([
      { instanceId: held[0].instanceId, status: 'expired' },
    ]);
    await Promise.resolve();
    expect(retirements).toHaveLength(1);
  });
});
