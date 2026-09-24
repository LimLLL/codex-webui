import { describe, expect, it, vi } from 'vitest';
import { FileWatchCoordinatorService } from './file-watch-coordinator.service';

describe('FileWatchCoordinatorService', () => {
  it('deduplicates canonical paths and releases a deleted path without re-resolving it', async () => {
    let resolveCalls = 0;
    const files = {
      resolveWatchPath: vi.fn((requested: string) => {
        resolveCalls += 1;
        if (resolveCalls > 2) throw new Error('path was deleted');
        return requested === '/link' ? '/real' : requested;
      }),
    };
    const requests = vi.fn(() => Promise.resolve({ path: '/real' }));
    const processManager = {
      getClient: () => ({}),
      addListener: vi.fn(),
      addLifecycleListener: vi.fn(() => () => undefined),
    };
    const service = new FileWatchCoordinatorService(
      files as never,
      { request: requests } as never,
      processManager as never,
    );

    await service.acquire('socket-a', '/link');
    await service.acquire('socket-b', '/link');
    expect(requests).toHaveBeenCalledTimes(1);
    await service.release('socket-a', '/link');
    expect(requests).toHaveBeenCalledTimes(1);
    await service.release('socket-b', '/link');
    expect(requests).toHaveBeenCalledTimes(2);
    expect(resolveCalls).toBe(2);
  });

  it('allocates a fresh id after app-server readiness and fans out only leased changes', async () => {
    const notifications: Array<(value: unknown) => void> = [];
    const lifecycle: Array<(event: { type: string }) => void> = [];
    const requestCalls: Array<[string, Record<string, unknown>]> = [];
    const requests = vi.fn((method: string, body: Record<string, unknown>) => {
      requestCalls.push([method, body]);
      return Promise.resolve({ path: '/workspace' });
    });
    const processManager = {
      getClient: () => null,
      addListener: vi.fn((_event: string, listener: (value: unknown) => void) =>
        notifications.push(listener),
      ),
      addLifecycleListener: vi.fn(
        (listener: (event: { type: string }) => void) => {
          lifecycle.push(listener);
          return () => undefined;
        },
      ),
    };
    const service = new FileWatchCoordinatorService(
      { resolveWatchPath: vi.fn((path: string) => path) } as never,
      { request: requests } as never,
      processManager as never,
    );
    const changes: unknown[] = [];
    service.subscribe((change) => changes.push(change));
    await service.acquire('socket-a', '/workspace');
    lifecycle[0]({ type: 'appServerReady' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstIds = requestCalls
      .filter(([method]) => method === 'fs/watch')
      .map(([, body]) => body.watchId)
      .filter((id): id is string => typeof id === 'string');
    expect(new Set(firstIds).size).toBe(firstIds.length);
    const latestId = firstIds[firstIds.length - 1];
    if (!latestId) throw new Error('watch was not registered');
    notifications[0]({
      method: 'fs/changed',
      params: { watchId: latestId, changedPaths: ['/workspace/a'] },
    });
    expect(changes).toContainEqual(
      expect.objectContaining({
        watchPath: '/workspace',
        changedPaths: ['/workspace/a'],
        socketIds: ['socket-a'],
      }),
    );
    lifecycle[0]({ type: 'appServerUnavailable' });
    lifecycle[0]({ type: 'appServerReady' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const allIds = requestCalls
      .filter(([method]) => method === 'fs/watch')
      .map(([, body]) => body.watchId);
    expect(allIds).toHaveLength(2);
    expect(new Set(allIds).size).toBe(2);
    const count = changes.length;
    notifications[0]({
      method: 'fs/changed',
      params: { watchId: latestId, changedPaths: ['/stale-epoch'] },
    });
    expect(changes).toHaveLength(count);
  });
});

it('keeps overlapping surfaces alive and cancels an acquisition released during path resolution', async () => {
  let finish!: (path: string) => void;
  const resolve = vi.fn(() => Promise.resolve('/workspace'));
  const request = vi.fn(() => Promise.resolve({ path: '/workspace' }));
  const manager = {
    getClient: () => ({}),
    addListener: vi.fn(),
    addLifecycleListener: () => () => undefined,
  };
  const service = new FileWatchCoordinatorService(
    { resolveWatchPath: resolve } as never,
    { request } as never,
    manager as never,
  );
  await Promise.all([
    service.acquire('same-session', '/workspace', 'browser'),
    service.acquire('same-session', '/workspace', 'picker'),
  ]);
  expect(request).toHaveBeenCalledTimes(1);
  await service.release('same-session', 'browser');
  expect(request).toHaveBeenCalledTimes(1);
  await service.release('same-session', 'picker');
  expect(request).toHaveBeenCalledTimes(2);
  resolve.mockReturnValueOnce(
    new Promise((done) => {
      finish = done;
    }),
  );
  const pending = service.acquire('gone', '/workspace', 'pending');
  await service.releaseSocket('gone');
  finish('/workspace');
  await pending;
  expect(request).toHaveBeenCalledTimes(2);
});
