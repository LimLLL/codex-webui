/** Concurrent discovery must retain live fields without turning unrelated activity into full scans. */
import { EventEmitter } from 'node:events';
import type { ServerNotification, v2 } from '../codex/codex-schema';
import type { CodexService } from '../codex/codex.service';
import type {
  CodexLifecycleEvent,
  CodexProcessManager,
} from '../codex/codex-process-manager.service';
import { ThreadMetadataService } from './thread-metadata.service';
import { makeThreadFixture } from './threads.testing';
import { executionTurn } from './thread-execution.testing';

describe('incremental metadata during discovery', () => {
  const events = new EventEmitter<{
    notification: [ServerNotification];
    lifecycle: [CodexLifecycleEvent];
  }>();
  const page = (ids: string[]): v2.ThreadListResponse => ({
    data: ids.map((id) => makeThreadFixture({ id })),
    nextCursor: null,
    backwardsCursor: null,
  });
  const request =
    vi.fn<
      (
        method: string,
        params: v2.ThreadListParams,
      ) => Promise<v2.ThreadListResponse>
    >();
  let service: ThreadMetadataService;

  beforeEach(() => {
    vi.useFakeTimers();
    events.removeAllListeners();
    request
      .mockReset()
      .mockImplementation((_method, params) =>
        Promise.resolve(page(params.archived ? [] : ['live'])),
      );
    service = new ThreadMetadataService(
      { request } as unknown as CodexService,
      {
        addListener: (
          event: 'notification',
          handler: (note: ServerNotification) => void,
        ) => events.on(event, handler),
        addLifecycleListener: (handler: (event: CodexLifecycleEvent) => void) =>
          events.on('lifecycle', handler),
        getGeneration: () => 1,
        getClient: () => ({}),
      } as unknown as CodexProcessManager,
    );
  });
  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  /** Holds a native page while notifications advance the visible collection. */
  function deferPage() {
    let finish!: (value: v2.ThreadListResponse) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    return (value: v2.ThreadListResponse) => finish(value);
  }

  it('does not overwrite live status or name with an older in-flight page', async () => {
    await service.read();
    const finish = deferPage();
    const refresh = service.refresh();
    events.emit('notification', {
      method: 'thread/status/changed',
      params: {
        threadId: 'live',
        status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      },
    });
    events.emit('notification', {
      method: 'thread/name/updated',
      params: { threadId: 'live', threadName: 'renamed' },
    });
    finish(page(['live']));
    await refresh;
    expect((await service.read()).entries[0].thread).toMatchObject({
      name: 'renamed',
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('keeps cold-acquisition notifications only for rows actually listed', async () => {
    const finish = deferPage();
    const read = service.read();
    for (const threadId of ['live', 'unlisted']) {
      events.emit('notification', {
        method: 'thread/status/changed',
        params: { threadId, status: { type: 'active', activeFlags: [] } },
      });
    }
    finish(page(['live']));
    const result = await read;
    expect(result.entries.map((entry) => entry.thread.id)).toEqual(['live']);
    expect(result.entries[0].thread.status.type).toBe('active');
  });

  it('keeps turn-driven timestamp staleness raised during a successful walk', async () => {
    await service.read();
    const finish = deferPage();
    const refresh = service.refresh();
    events.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'live', turn: executionTurn('turn', 'failed') },
    });
    finish(page(['live']));
    await refresh;
    expect((await service.read()).freshness.stale).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(29_500);
    expect((await service.read()).freshness.stale).toBe(false);
  });

  it('rejects a partition walk crossed by unarchive instead of losing the moved row', async () => {
    request.mockImplementation((_method, params) =>
      Promise.resolve(page(params.archived ? ['moved'] : ['live'])),
    );
    await service.read();
    request.mockResolvedValueOnce(page(['live']));
    let finish!: (value: v2.ThreadListResponse) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = service.refresh();
    await Promise.resolve();
    events.emit('notification', {
      method: 'thread/unarchived',
      params: { threadId: 'moved' },
    });
    finish(page([]));
    await refresh;
    expect(
      (await service.read()).entries.find(
        (entry) => entry.thread.id === 'moved',
      )?.archived,
    ).toBe(false);
    expect((await service.read()).freshness.stale).toBe(true);
    request.mockImplementation((_method, params) =>
      Promise.resolve(page(params.archived ? [] : ['live', 'moved'])),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(
      (await service.read()).entries.map((entry) => entry.thread.id),
    ).toEqual(['live', 'moved']);
  });

  it('does not make an unrelated conversation urgent while an empty conversation awaits listing', async () => {
    await service.read();
    events.emit('notification', {
      method: 'thread/started',
      params: { thread: makeThreadFixture({ id: 'empty' }) },
    });
    await vi.advanceTimersByTimeAsync(500);
    request.mockClear();
    events.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'live', turn: executionTurn('turn', 'completed') },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(request).not.toHaveBeenCalled();
  });

  it('expires pending-listing urgency while keeping periodic discovery available', async () => {
    await service.read();
    events.emit('notification', {
      method: 'thread/started',
      params: { thread: makeThreadFixture({ id: 'empty' }) },
    });
    await vi.advanceTimersByTimeAsync(300_500);
    request.mockClear();
    events.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'empty', turn: executionTurn('turn', 'failed') },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(request).not.toHaveBeenCalled();
    request.mockImplementation((_method, params) =>
      Promise.resolve(page(params.archived ? [] : ['live', 'empty'])),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      (await service.read()).entries.map((entry) => entry.thread.id),
    ).toContain('empty');
  });
});
