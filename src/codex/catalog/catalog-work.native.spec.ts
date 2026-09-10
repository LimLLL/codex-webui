/** Real stdio dispatch and terminal correlation against a local, explicitly controlled model provider. */
import type { v2 } from '../codex-schema';
import { localCatalogProvider } from './catalog-provider.testing';

const input = [
  { type: 'text' as const, text: 'Continue working', text_elements: [] },
];

describe('native retained work', () => {
  let environment: Awaited<ReturnType<typeof localCatalogProvider>>;
  beforeEach(async () => {
    environment = await localCatalogProvider();
  });
  afterEach(async () => {
    await environment.close();
  });

  it('holds an inline review until its correlated terminal turn', async () => {
    const { client, thread } = environment;
    const result = await client.request<v2.ReviewStartResponse>(
      'review/start',
      {
        threadId: thread.id,
        target: { type: 'custom', instructions: 'Inspect the task.' },
        delivery: 'inline',
      },
    );
    expect((await environment.inspect()).blockers).toContainEqual(
      expect.objectContaining({
        requestMethod: 'review/start',
        turnId: result.turn.id,
      }),
    );
    const lifecycle: string[] = [];
    const removeListener = environment.manager.addLifecycleListener((event) =>
      lifecycle.push(event.type),
    );
    await expect(environment.manager.restartControlled()).rejects.toThrow(
      'Cannot establish idle',
    );
    removeListener();
    expect(lifecycle).toEqual([]);
    expect(environment.manager.getClient()).toBe(client);
    await environment.request(0);
    environment.complete(0);
    await environment.event(
      (event) =>
        event.method === 'turn/completed' &&
        event.params.turn.id === result.turn.id,
    );
    expect(client.acceptedWork.blockers()).toEqual([]);
  }, 25_000);

  it('releases a manual compaction on its own completed contextCompaction item', async () => {
    const { client, thread } = environment;
    const initial = await client.request<v2.TurnStartResponse>('turn/start', {
      threadId: thread.id,
      input,
    });
    await environment.request(0);
    environment.complete(0);
    await environment.event(
      (event) =>
        event.method === 'turn/completed' &&
        event.params.turn.id === initial.turn.id,
    );
    await client.request('thread/compact/start', { threadId: thread.id });
    expect((await environment.inspect()).blockers).toContainEqual(
      expect.objectContaining({ requestMethod: 'thread/compact/start' }),
    );
    await environment.request(1);
    environment.complete(1);
    // The acknowledgement carries no turn id, so correlation comes from the turn
    // the compaction runs in: this asserts the pinned app-server really opens a
    // fresh turn after the acknowledgement and stamps its `contextCompaction`
    // item with that turn id. Without both, the reservation would never bind and
    // would block forever rather than release early.
    const started = await environment.event(
      (event) =>
        event.method === 'item/started' &&
        (event.params as { item?: { type?: string } }).item?.type ===
          'contextCompaction',
    );
    const compactionTurnId = (started.params as { turnId?: string }).turnId;
    expect(compactionTurnId).toBeTruthy();
    expect(compactionTurnId).not.toBe(initial.turn.id);
    expect(
      client.acceptedWork
        .blockers()
        .find((blocker) => blocker.requestMethod === 'thread/compact/start')
        ?.turnId,
    ).toBe(compactionTurnId);
    await environment.event(
      (event) =>
        event.method === 'turn/completed' &&
        event.params.turn.id === compactionTurnId,
    );
    expect(
      client.acceptedWork
        .blockers()
        .filter((blocker) => blocker.requestMethod === 'thread/compact/start'),
    ).toEqual([]);
  }, 25_000);

  it('tracks locally queued work through automatic dequeue and its client message identity', async () => {
    const { client, thread } = environment;
    const initial = await client.request<v2.TurnStartResponse>('turn/start', {
      threadId: thread.id,
      input,
    });
    await environment.request(0);
    await client.request('thread/queue/add', {
      threadId: thread.id,
      input,
      clientUserMessageId: 'catalog-queued-message',
    });
    environment.complete(0);
    await environment.event(
      (event) =>
        event.method === 'turn/completed' &&
        event.params.turn.id === initial.turn.id,
    );
    expect((await environment.inspect()).canApply).toBe(false);
    await environment.request(1);
    const queued = client.acceptedWork
      .blockers()
      .find((entry) => entry.requestMethod === 'thread/queue/add');
    expect(queued?.turnId).toBeTruthy();
    environment.complete(1);
    await environment.event(
      (event) =>
        event.method === 'turn/completed' &&
        event.params.turn.id === queued?.turnId,
    );
    expect(client.acceptedWork.blockers()).toEqual([]);
  }, 25_000);

  it('retains a locally activated goal across automatic continuation and later pause', async () => {
    const { client, thread } = environment;
    await client.request('thread/goal/set', {
      threadId: thread.id,
      objective: 'Keep working until explicitly paused',
      status: 'active',
    });
    const initial = await client.request<v2.TurnStartResponse>('turn/start', {
      threadId: thread.id,
      input,
    });
    await environment.request(0);
    environment.complete(0);
    await environment.event(
      (event) =>
        event.method === 'turn/completed' &&
        event.params.turn.id === initial.turn.id,
    );
    await environment.request(1);
    await client.request('thread/goal/set', {
      threadId: thread.id,
      status: 'paused',
    });
    environment.complete(1);
    await environment.event(
      (event) =>
        event.method === 'turn/completed' &&
        event.params.turn.id !== initial.turn.id,
    );
    const inspection = await environment.inspect();
    expect(inspection.canApply).toBe(false);
    const goalBlocker = inspection.blockers.find(
      (entry) => entry.requestMethod === 'thread/goal/set',
    );
    expect(goalBlocker?.reason).toContain('Cannot establish idle');
  }, 25_000);
});
