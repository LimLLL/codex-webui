/** Shared discovery publishes complete collections and survives failures without request amplification. */
import { EventEmitter } from 'node:events';
import type { ServerNotification, v2 } from '../codex/codex-schema';
import type { CodexService } from '../codex/codex.service';
import type {
  CodexLifecycleEvent,
  CodexProcessManager,
} from '../codex/codex-process-manager.service';
import { ThreadMetadataService } from './thread-metadata.service';
import { makeThreadFixture } from './threads.testing';

describe('ThreadMetadataService', () => {
  const events = new EventEmitter<{
    notification: [ServerNotification];
    lifecycle: [CodexLifecycleEvent];
  }>();
  const request =
    vi.fn<
      (
        method: string,
        params: v2.ThreadListParams,
      ) => Promise<v2.ThreadListResponse>
    >();
  let generation: number;
  let service: ThreadMetadataService;
  const page = (
    ids: string[],
    nextCursor: string | null = null,
  ): v2.ThreadListResponse => ({
    data: ids.map((id) => makeThreadFixture({ id })),
    nextCursor,
    backwardsCursor: null,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    events.removeAllListeners();
    generation = 1;
    request
      .mockReset()
      .mockImplementation((_method, params) =>
        Promise.resolve(page(params.archived ? ['archived'] : ['active'])),
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
        getGeneration: () => generation,
        getClient: () => ({}),
      } as unknown as CodexProcessManager,
    );
  });
  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('shares all pages of cold discovery across browsers and serves warm reads locally', async () => {
    request.mockImplementation((_method, params) =>
      Promise.resolve(
        params.archived
          ? page(['archived'])
          : params.cursor
            ? page(['second'])
            : page(['first'], 'next'),
      ),
    );
    const results = await Promise.all([
      service.read(),
      service.read(),
      service.read(),
    ]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(results[0].entries.map((entry) => entry.thread.id)).toEqual([
      'first',
      'second',
      'archived',
    ]);
    expect(
      results.every((result) => result.entries === results[0].entries),
    ).toBe(true);
    await service.read();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('retains the entire previous collection when one partition fails', async () => {
    const before = await service.read();
    request
      .mockResolvedValueOnce(page(['new']))
      .mockRejectedValueOnce(new Error('archive unavailable'));
    await service.refresh();
    const after = await service.read();
    expect(after.entries).toBe(before.entries);
    expect(after.freshness.stale).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not convert an initial failure into an empty collection or a retry per browser', async () => {
    request.mockRejectedValue(new Error('unavailable'));
    await expect(service.read()).rejects.toThrow('not available');
    await expect(service.read()).rejects.toThrow('not available');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('discovers external changes on one backend schedule without browser reads', async () => {
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    request.mockImplementation((_method, params) =>
      Promise.resolve(page(params.archived ? [] : ['external'])),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(4);
    expect(
      (await service.read()).entries.map((entry) => entry.thread.id),
    ).toEqual(['external']);
  });

  it('ignores output deltas and does not postpone discovery under repeated lifecycle events', async () => {
    await service.read();
    service.invalidate();
    await vi.advanceTimersByTimeAsync(250);
    service.invalidate();
    events.emit('notification', {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'active',
        turnId: 'turn',
        itemId: 'item',
        delta: 'text',
      },
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('refuses to publish a page made obsolete by deletion and reacquires once', async () => {
    const before = await service.read();
    let finish!: (page: v2.ThreadListResponse) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refreshing = service.refresh();
    service.invalidate();
    finish(page(['deleted']));
    await refreshing;
    expect((await service.read()).entries).toBe(before.entries);
    expect((await service.read()).freshness.stale).toBe(true);
    request.mockResolvedValue(page([]));
    await vi.advanceTimersByTimeAsync(500);
    expect((await service.read()).entries).toEqual([]);
  });

  it('rejects repeated cursors instead of publishing truncated metadata', async () => {
    await service.read();
    request
      .mockResolvedValueOnce(page(['a'], 'same'))
      .mockResolvedValueOnce(page(['b'], 'same'));
    await service.refresh();
    expect(
      (await service.read()).entries.map((entry) => entry.thread.id),
    ).toEqual(['active', 'archived']);
    expect((await service.read()).freshness.stale).toBe(true);
  });

  it('marks a prior generation stale until a new complete acquisition', async () => {
    await service.read();
    generation = 2;
    events.emit('lifecycle', {
      type: 'appServerReady',
      generation,
      restarted: true,
    });
    expect((await service.read()).freshness).toMatchObject({
      generation: 1,
      stale: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await service.read()).freshness).toMatchObject({
      generation: 2,
      stale: false,
    });
  });
  it('removes positive deletion evidence even if the next refresh fails', async () => {
    await service.read();
    events.emit('notification', {
      method: 'thread/deleted',
      params: { threadId: 'active' },
    });
    request.mockRejectedValue(new Error('offline'));
    await service.refresh();
    expect(
      (await service.read()).entries.map((entry) => entry.thread.id),
    ).toEqual(['archived']);
    expect((await service.read()).freshness.stale).toBe(true);
  });
});

/**
 * Turn lifecycle is the highest-frequency signal reaching this service, and it
 * used to force a full walk of both archive partitions every time. Measured
 * against 0.153.2 (`codex_probe/metadata-incremental.ts`): turns can advance
 * `updatedAt` but carry no replacement conversation timestamp. Status is sent
 * separately. Sorting stays explicitly stale until periodic discovery; an
 * unlisted new conversation's own turn still makes discovery urgent.
 */
describe('ThreadMetadataService incremental maintenance', () => {
  const events = new EventEmitter<{
    notification: [ServerNotification];
    lifecycle: [CodexLifecycleEvent];
  }>();
  const request =
    vi.fn<
      (
        method: string,
        params: v2.ThreadListParams,
      ) => Promise<v2.ThreadListResponse>
    >();
  let service: ThreadMetadataService;

  const listed = (id: string): v2.ThreadListResponse => ({
    data: [makeThreadFixture({ id })],
    nextCursor: null,
    backwardsCursor: null,
  });

  /** Runs the coalescing window and lets the acquisition settle. */
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    events.removeAllListeners();
    request
      .mockReset()
      .mockImplementation((_method, params) =>
        Promise.resolve(params.archived ? listed('archived') : listed('live')),
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
    service.onModuleInit();
    await settle();
    request.mockClear();
  });
  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('does not re-enumerate for a turn on an already listed conversation', async () => {
    events.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'live', turn: { id: 't1', status: 'completed' } },
    } as unknown as ServerNotification);
    await settle();

    expect(request).not.toHaveBeenCalled();
  });

  it('does re-enumerate while a started conversation is not listable yet', async () => {
    events.emit('notification', {
      method: 'thread/started',
      params: { thread: makeThreadFixture({ id: 'brand-new' }) },
    } as unknown as ServerNotification);
    await settle();
    request.mockClear();

    events.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'brand-new',
        turn: { id: 't1', status: 'completed' },
      },
    } as unknown as ServerNotification);
    await settle();

    expect(request).toHaveBeenCalled();
  });

  it('applies a status change in place instead of walking the list', async () => {
    const status = {
      type: 'active',
      activeFlags: [],
    } as unknown as v2.Thread['status'];
    events.emit('notification', {
      method: 'thread/status/changed',
      params: { threadId: 'live', status },
    } as unknown as ServerNotification);
    await settle();

    expect(request).not.toHaveBeenCalled();
    const { entries } = await service.read();
    expect(
      entries.find((entry) => entry.thread.id === 'live')?.thread.status,
    ).toEqual(status);
  });

  it('refuses to invent a conversation the stored list has not listed', async () => {
    events.emit('notification', {
      method: 'thread/status/changed',
      params: {
        threadId: 'never-listed',
        status: { type: 'active', activeFlags: [] },
      },
    } as unknown as ServerNotification);
    await settle();

    const { entries } = await service.read();
    expect(entries.some((entry) => entry.thread.id === 'never-listed')).toBe(
      false,
    );
  });
});
