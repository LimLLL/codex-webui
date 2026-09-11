/** Reconnect must recover actual transcript content, not just an active pointer. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { threadsListTurnItems, threadsListTurns } from '@/generated/api/sdk.gen';
import type { TurnDto } from '@/generated/api';
import type { TimelineEntry } from '@/types/timeline';
import { useTimelineStore } from '@/stores/timeline-store';
import { recoverThreadAfterReconnect } from './thread-recovery';
import { currentObservationSeq } from './turn-item-merge';

vi.mock('@/socket', () => ({ getSocket: () => ({ emit: vi.fn() }) }));
vi.mock('@/generated/api/sdk.gen', () => ({
  threadsListTurnItems: vi.fn(), threadsListTurns: vi.fn(),
}));
const pristine = useTimelineStore.getState();
const headers = vi.mocked(threadsListTurns);
const items = vi.mocked(threadsListTurnItems);
type HeaderReply = Awaited<ReturnType<typeof threadsListTurns<true>>>;
type ItemReply = Awaited<ReturnType<typeof threadsListTurnItems<true>>>;
const header = (id: string, status: TurnDto['status']): TurnDto => ({
  id, status, items: [], itemsView: 'summary', error: null,
  startedAt: null, completedAt: null, durationMs: null,
});
const page = (): HeaderReply => ({ data: { data: [
  header('active', 'inProgress'), header('older', 'completed'),
], nextCursor: null } }) as HeaderReply;

beforeEach(() => {
  useTimelineStore.setState(pristine, true);
  useTimelineStore.getState().ensureThreadState({ threadId: 't' });
  headers.mockReset().mockResolvedValue(page());
  items.mockReset().mockResolvedValue({ data: {
    items: [
      { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'prompt' }] },
      { type: 'agentMessage', id: 'reply', text: 'before disconnect' },
    ], complete: true, nextCursor: null,
  } } as ItemReply);
});

describe('adopted active turn', () => {
  it('restores its prompt and items without fetching unrelated older turns', async () => {
    recoverThreadAfterReconnect('t');
    await vi.waitFor(() => expect(items).toHaveBeenCalledTimes(1));
    const runtime = useTimelineStore.getState().getThreadRuntime('t')!;
    expect(runtime.activeTurnId).toBe('active');
    expect(runtime.timeline).toEqual([
      expect.objectContaining({ kind: 'turn', turnId: 'older', completed: true }),
      expect.objectContaining({ kind: 'user', turnId: 'active', content: 'prompt' }),
      expect.objectContaining({ kind: 'turn', turnId: 'active', completed: false,
        items: [expect.objectContaining({ itemId: 'reply', content: 'before disconnect' })] }),
    ]);
    expect(items).toHaveBeenCalledWith({ path: { threadId: 't', turnId: 'active' } });
  });

  it('still fetches missing items when a live event creates the turn during the header read', async () => {
    let finish!: (value: HeaderReply) => void;
    headers.mockReturnValueOnce(new Promise<HeaderReply>((resolve) => { finish = resolve; }));
    recoverThreadAfterReconnect('t');
    const store = useTimelineStore.getState();
    store.setActiveTurnIdForThread('t', 'active');
    store.updateTurnItemForThread('t', 'active', 'live', () => ({
      type: 'agentMessage', itemId: 'live', content: 'after reconnect', completed: false, questions: [],
    }));
    finish(page());
    await vi.waitFor(() => expect(items).toHaveBeenCalledTimes(1));
    const turn = store.getThreadRuntime('t')!.timeline.find((entry): entry is Extract<TimelineEntry, { kind: 'turn' }> => entry.kind === 'turn' && entry.turnId === 'active');
    expect(turn?.items.map((item) => item.itemId)).toEqual(['reply', 'live']);
  });
});

describe('plan recovery authority', () => {
  it('keeps a plan terminal observed after the recovery request', () => {
    const store = useTimelineStore.getState();
    store.appendPlanDeltaForThread('t', 'active', 'plan', 'prefix');
    const baseline = currentObservationSeq();
    store.setPlanTextForThread('t', 'active', 'plan', 'new complete plan');
    store.applyRecoveredTurnItemsForThread('t', 'active', [
      { type: 'plan', id: 'plan', text: 'older complete plan' },
    ], baseline);
    const turn = store.getThreadRuntime('t')!.timeline.find((entry): entry is Extract<TimelineEntry, { kind: 'turn' }> => entry.kind === 'turn' && entry.turnId === 'active');
    expect(turn?.plan?.planTextByItemId?.plan.text).toBe('new complete plan');
  });

  it('repairs unfinished plan prose even without an active pointer or regular items', async () => {
    const store = useTimelineStore.getState();
    store.appendPlanDeltaForThread('t', 'active', 'plan', 'prefix');
    headers.mockResolvedValueOnce({ data: { data: [header('active', 'completed')] } } as HeaderReply);
    items.mockResolvedValueOnce({ data: {
      items: [{ type: 'plan', id: 'plan', text: 'whole plan' }], complete: true,
    } } as ItemReply);
    recoverThreadAfterReconnect('t');
    await vi.waitFor(() => expect(items).toHaveBeenCalledTimes(1));
    const turn = store.getThreadRuntime('t')!.timeline.find((entry): entry is Extract<TimelineEntry, { kind: 'turn' }> => entry.kind === 'turn' && entry.turnId === 'active');
    expect(turn?.plan?.planTextByItemId?.plan).toMatchObject({ text: 'whole plan', completed: true });
  });
});

describe('turns that began and ended during the gap', () => {
  /** Gives the client one known turn so the page has an anchor to walk back to. */
  function withKnownTurn(turnId = 'known') {
    const store = useTimelineStore.getState();
    store.updateTurnItemForThread('t', turnId, 'seen', () => ({
      type: 'agentMessage', itemId: 'seen', content: 'before the gap',
      completed: true, questions: [],
    }));
    return store;
  }

  it('adopts a whole turn the client never saw start or finish', async () => {
    const store = withKnownTurn();
    headers.mockResolvedValueOnce({ data: { data: [
      header('missed', 'completed'), header('known', 'completed'),
    ], nextCursor: null } } as HeaderReply);
    items.mockResolvedValue({ data: {
      items: [
        { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'ask' }] },
        { type: 'agentMessage', id: 'a', text: 'answered while away' },
      ], complete: true, nextCursor: null,
    } } as ItemReply);

    recoverThreadAfterReconnect('t');
    await vi.waitFor(() =>
      expect(
        store.getThreadRuntime('t')!.timeline.some(
          (entry) => entry.kind === 'turn' && entry.turnId === 'missed',
        ),
      ).toBe(true),
    );
    const adopted = store
      .getThreadRuntime('t')!
      .timeline.find(
        (entry) => entry.kind === 'turn' && entry.turnId === 'missed',
      );
    // Terminal, not spinning: nothing is coming to settle it later.
    expect(adopted).toMatchObject({ completed: true });
    expect(
      adopted?.kind === 'turn'
        ? adopted.items.map((item) => item.itemId)
        : null,
    ).toEqual(['a']);
    expect(items).toHaveBeenCalledWith({
      path: { threadId: 't', turnId: 'missed' },
    });
  });

  it('uses the latest window when no held turn overlaps', async () => {
    // No overlap can be a long gap or a pruned window. Use positive page
    // evidence and its cursor instead of inventing continuity.
    const store = withKnownTurn('local-only');
    headers.mockResolvedValueOnce({ data: { data: [
      header('far-1', 'completed'), header('far-2', 'completed'),
    ], nextCursor: null } } as HeaderReply);

    recoverThreadAfterReconnect('t');
    await vi.waitFor(() => expect(headers).toHaveBeenCalled());
    const turnIds = store
      .getThreadRuntime('t')!
      .timeline.flatMap((entry) => (entry.kind === 'turn' ? [entry.turnId] : []));
    expect(turnIds).toEqual(['far-2', 'far-1']);
  });
});

it('places missed turns before a live turn received while the read was outstanding', async () => {
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({ threadId: 't', turnsNewestFirst: [header('known', 'completed')], historyCursor: null, readOnlyReason: null });
  let finish!: (value: HeaderReply) => void;
  headers.mockReturnValueOnce(new Promise<HeaderReply>((done) => { finish = done; }));
  const recovery = recoverThreadAfterReconnect('t');
  store.setActiveTurnIdForThread('t', 'live');
  store.updateCurrentTurnForThread('t', 'live', () => ({ items: [], completed: false }));
  finish({ data: { data: [header('live', 'inProgress'), header('missed', 'completed'), header('known', 'completed')], nextCursor: null } } as HeaderReply);
  await recovery;
  expect(store.getThreadRuntime('t')?.timeline.flatMap((entry) => entry.kind === 'turn' ? [entry.turnId] : [])).toEqual(['known', 'missed', 'live']);
  expect(store.getThreadRuntime('t')?.activeTurnId).toBe('live');
});

it('follows the cursor when the first page has no pre-read anchor', async () => {
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({ threadId: 't', turnsNewestFirst: [header('known', 'completed')], historyCursor: 'earlier', readOnlyReason: null });
  headers.mockResolvedValueOnce({ data: { data: [header('newest', 'completed')], nextCursor: 'bridge' } } as HeaderReply);
  headers.mockResolvedValueOnce({ data: { data: [header('middle', 'completed'), header('known', 'completed')], nextCursor: 'earlier' } } as HeaderReply);
  await recoverThreadAfterReconnect('t');
  expect(headers).toHaveBeenCalledTimes(2);
  expect(headers.mock.calls[1][0]?.query).toMatchObject({ cursor: 'bridge', itemsView: 'summary', sortDirection: 'desc' });
  expect(store.getThreadRuntime('t')?.timeline.flatMap((entry) => entry.kind === 'turn' ? [entry.turnId] : [])).toEqual(['known', 'middle', 'newest']);
  expect(store.getThreadRuntime('t')?.historyCursor).toBe('earlier');
});

it('does not apply a read to a deleted and recreated runtime', async () => {
  const store = useTimelineStore.getState();
  let finish!: (value: HeaderReply) => void;
  headers.mockReturnValueOnce(new Promise<HeaderReply>((done) => { finish = done; }));
  const recovery = recoverThreadAfterReconnect('t');
  store.forgetThreads(['t']);
  store.ensureThreadState({ threadId: 't' });
  finish(page());
  await recovery;
  expect(store.getThreadRuntime('t')?.timeline).toEqual([]);
});
