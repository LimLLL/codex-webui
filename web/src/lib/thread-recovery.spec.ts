/** Recovery owns full-page reconciliation and late items; scrolling never fetches them. */
import { beforeEach, expect, it, vi } from 'vitest';
import { threadsListTurnItems, threadsListTurns } from '@/generated/api/sdk.gen';
import type { TurnDto } from '@/generated/api';
import type { TimelineEntry } from '@/types/timeline';
import { useTimelineStore } from '@/stores/timeline-store';
import { recoverThreadAfterReconnect, recoverTurnItems } from './thread-recovery';
import { saveTranscriptBookmark, forgetTranscriptBookmarks } from './transcript-anchor';
import { currentObservationSeq } from './turn-item-merge';

vi.mock('@/socket', () => ({ getSocket: () => ({ emit: vi.fn() }) }));
vi.mock('@/generated/api/sdk.gen', () => ({ threadsListTurnItems: vi.fn(), threadsListTurns: vi.fn() }));
const pristine = useTimelineStore.getState();
const headers = vi.mocked(threadsListTurns);
const items = vi.mocked(threadsListTurnItems);
type HeaderReply = Awaited<ReturnType<typeof threadsListTurns<true>>>;
type ItemReply = Awaited<ReturnType<typeof threadsListTurnItems<true>>>;
const answer = (text = 'before disconnect') => ({ type: 'agentMessage' as const, id: 'answer', text, phase: null, questions: [], memoryCitation: null });
const turn = (id: string, status: TurnDto['status'], content: TurnDto['items'] = []): TurnDto => ({
  id, status, items: content, itemsView: 'full', error: null,
  startedAt: null, completedAt: null, durationMs: null,
});
const page = (data: TurnDto[], nextCursor: string | null = null) => ({ data: { data, nextCursor, backwardsCursor: null } }) as HeaderReply;
const getTurn = (id: string) => useTimelineStore.getState().getThreadRuntime('t')!.timeline
  .find((entry): entry is Extract<TimelineEntry, { kind: 'turn' }> => entry.kind === 'turn' && entry.turnId === id);

beforeEach(() => {
  forgetTranscriptBookmarks(['t']);
  useTimelineStore.setState(pristine, true);
  useTimelineStore.getState().ensureThreadState({ threadId: 't' });
  headers.mockReset().mockResolvedValue(page([turn('active', 'inProgress', [answer()]), turn('older', 'completed')]));
  items.mockReset().mockResolvedValue({ data: { items: [answer('late durable output')], complete: true, nextCursor: null, incompleteReason: null }, request: new Request('http://localhost'), response: new Response() } satisfies ItemReply);
});

it('adopts full running history without an N-request per-turn hydration pass', async () => {
  await expect(recoverThreadAfterReconnect('t')).resolves.toBe(true);
  expect(useTimelineStore.getState().getThreadRuntime('t')?.activeTurnId).toBe('active');
  expect(getTurn('active')).toMatchObject({ completed: false, items: [expect.objectContaining({ content: 'before disconnect' })] });
  expect(items).not.toHaveBeenCalled();
});

it('keeps live items received while the full page is outstanding', async () => {
  let finish!: (value: HeaderReply) => void;
  headers.mockReturnValueOnce(new Promise<HeaderReply>((resolve) => { finish = resolve; }));
  const recovery = recoverThreadAfterReconnect('t');
  const store = useTimelineStore.getState();
  store.setActiveTurnIdForThread('t', 'active');
  store.updateTurnItemForThread('t', 'active', 'live', () => ({
    type: 'agentMessage', itemId: 'live', content: 'after reconnect', completed: false, questions: [],
  }));
  finish(page([turn('active', 'inProgress', [answer()])]));
  await recovery;
  expect(getTurn('active')?.items.map((item) => item.itemId)).toEqual(['answer', 'live']);
});

it('does not let a supplied opening snapshot overwrite a newer live terminal', async () => {
  const store = useTimelineStore.getState();
  const baseline = currentObservationSeq();
  store.setPlanTextForThread('t', 'active', 'plan', 'new complete plan');
  await recoverThreadAfterReconnect('t', page([turn('active', 'inProgress', [
    { type: 'plan', id: 'plan', text: 'older complete plan' },
  ])]).data, baseline);
  expect(getTurn('active')?.plan?.planTextByItemId?.plan.text).toBe('new complete plan');
});

it('repairs plan text and turn completion from the same full snapshot', async () => {
  useTimelineStore.getState().appendPlanDeltaForThread('t', 'active', 'plan', 'prefix');
  headers.mockResolvedValueOnce(page([turn('active', 'completed', [{ type: 'plan', id: 'plan', text: 'whole plan' }])]));
  await recoverThreadAfterReconnect('t');
  expect(getTurn('active')).toMatchObject({ completed: true, plan: { planTextByItemId: { plan: { text: 'whole plan', completed: true } } } });
  expect(items).not.toHaveBeenCalled();
});

it('restores a whole turn that began and finished during a gap', async () => {
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({ threadId: 't', turnsNewestFirst: [turn('known', 'completed')], historyCursor: null, readOnlyReason: null });
  headers.mockResolvedValueOnce(page([turn('missed', 'completed', [answer('answered while away')]), turn('known', 'completed')]));
  await recoverThreadAfterReconnect('t');
  expect(getTurn('missed')).toMatchObject({ completed: true, items: [expect.objectContaining({ content: 'answered while away' })] });
  expect(items).not.toHaveBeenCalled();
});

it('follows the cursor to bridge a pre-read history gap', async () => {
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({ threadId: 't', turnsNewestFirst: [turn('known', 'completed')], historyCursor: 'earlier', readOnlyReason: null });
  headers.mockResolvedValueOnce(page([turn('newest', 'completed')], 'bridge'));
  headers.mockResolvedValueOnce(page([turn('middle', 'completed'), turn('known', 'completed')], 'earlier'));
  await recoverThreadAfterReconnect('t');
  expect(headers).toHaveBeenCalledTimes(2);
  expect(headers.mock.calls[1][0]?.query).toMatchObject({ cursor: 'bridge', itemsView: 'full' });
  expect(store.getThreadRuntime('t')?.historyCursor).toBe('earlier');
  expect(getTurn('middle')).toMatchObject({ completed: true });
});

it('repairs late output on retained completed turns outside the newest page', async () => {
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({ threadId: 't', turnsNewestFirst: [turn('active', 'inProgress'), turn('old', 'completed')], historyCursor: null, readOnlyReason: null });
  headers.mockResolvedValueOnce(page([turn('active', 'inProgress')]));
  await recoverThreadAfterReconnect('t');
  expect(items).toHaveBeenCalledExactlyOnceWith({ path: { threadId: 't', turnId: 'old' } });
  expect(getTurn('old')).toMatchObject({ completed: true, items: [expect.objectContaining({ content: 'late durable output' })] });
});

it('bounds the late-item sweep instead of re-reading every retained completed turn', async () => {
  const retained = Array.from({ length: 14 }, (_, index) =>
    turn(`old${index}`, 'completed'),
  );
  useTimelineStore.getState().hydrateOpenedThread({
    threadId: 't',
    turnsNewestFirst: [turn('active', 'inProgress'), ...retained],
    historyCursor: null,
    readOnlyReason: null,
  });
  headers.mockResolvedValueOnce(page([turn('active', 'inProgress')]));
  await recoverThreadAfterReconnect('t');
  // Nothing marks a completed turn as swept, so an unbounded set would be
  // re-read in full on every reconnect and grow with every page loaded.
  expect(items).toHaveBeenCalledTimes(8);
  // Newest retained turns first — `turnsNewestFirst` is reversed on hydration,
  // so `old0` is the turn the reader just left and `old13` the oldest.
  const swept = items.mock.calls.map((call) => call[0]?.path.turnId);
  expect(swept).toContain('old0');
  expect(swept).not.toContain('old13');
});

it('does not fail an open because a sweep of an unbroken old turn failed', async () => {
  useTimelineStore.getState().hydrateOpenedThread({
    threadId: 't',
    turnsNewestFirst: [turn('active', 'inProgress'), turn('old', 'completed')],
    historyCursor: null,
    readOnlyReason: null,
  });
  headers.mockResolvedValueOnce(page([turn('active', 'inProgress')]));
  items.mockRejectedValueOnce(new Error('offline'));
  // The transcript shows nothing known to be wrong, so a speculative read for
  // late sub-agent items must not replace it with the loading gate's error.
  await expect(recoverThreadAfterReconnect('t')).resolves.toBe(true);
  await vi.waitFor(() => expect(useTimelineStore.getState().getThreadRuntime('t')?.historyError).toBeTruthy());
  expect(useTimelineStore.getState().getThreadRuntime('t')?.historyRequest).toBe('idle');
});

it('reports an incomplete recovery when a turn with an unfinished item fails', async () => {
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({
    threadId: 't',
    turnsNewestFirst: [turn('broken', 'completed')],
    historyCursor: null,
    readOnlyReason: null,
  });
  store.updateTurnItemForThread('t', 'broken', 'answer', () => ({
    type: 'agentMessage',
    itemId: 'answer',
    content: 'cut off mid-',
    questions: [],
    completed: false,
  }));
  headers.mockResolvedValueOnce(page([]));
  items.mockRejectedValueOnce(new Error('offline'));
  await expect(recoverThreadAfterReconnect('t')).resolves.toBe(false);
});

it('applies partial repair without claiming full coverage on a completed turn', async () => {
  useTimelineStore.getState().hydrateOpenedThread({ threadId: 't', turnsNewestFirst: [turn('old', 'completed')], historyCursor: null, readOnlyReason: null });
  items.mockResolvedValueOnce({ data: { items: [answer('partial')], complete: false, nextCursor: null, incompleteReason: 'pagingUnavailable' }, request: new Request('http://localhost'), response: new Response() } satisfies ItemReply);
  await expect(recoverTurnItems('t', 'old')).resolves.toBe(false);
  expect(getTurn('old')?.items[0]).toMatchObject({ content: 'partial' });
  expect(useTimelineStore.getState().getThreadRuntime('t')).toMatchObject({ historyRequest: 'error', historyError: expect.stringContaining('incomplete') });
});

it('reports downgraded history while retaining valid warm content', async () => {
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({ threadId: 't', turnsNewestFirst: [turn('active', 'inProgress', [answer('retained')])], historyCursor: null, readOnlyReason: null });
  headers.mockResolvedValueOnce(page([{ ...turn('active', 'inProgress'), itemsView: 'summary' }]));
  // Failed supplementary item recovery also cannot replace the retained buffer.
  items.mockRejectedValueOnce(new Error('offline'));
  await expect(recoverThreadAfterReconnect('t')).resolves.toBe(false);
  expect(getTurn('active')?.items.some((item) => item.type === 'agentMessage' && item.content === 'retained')).toBe(true);
  expect(store.getThreadRuntime('t')?.historyRequest).toBe('error');
});

it('cannot resurrect a deleted runtime with a response from an older epoch', async () => {
  const store = useTimelineStore.getState();
  let finish!: (value: HeaderReply) => void;
  headers.mockReturnValueOnce(new Promise<HeaderReply>((done) => { finish = done; }));
  const recovery = recoverThreadAfterReconnect('t');
  store.forgetThreads(['t']); store.ensureThreadState({ threadId: 't' });
  finish(page([turn('active', 'inProgress', [answer()])]));
  await recovery;
  expect(store.getThreadRuntime('t')?.timeline).toEqual([]);
});

it('lets an opening caller adopt reconnect repair that finishes before its superseded read', async () => {
  let finishOld!: (value: HeaderReply) => void;
  headers.mockReturnValueOnce(new Promise<HeaderReply>((done) => { finishOld = done; }));
  const opening = recoverThreadAfterReconnect('t');
  headers.mockResolvedValueOnce(page([turn('new', 'completed', [answer('newest')])]));
  await expect(recoverThreadAfterReconnect('t')).resolves.toBe(true);
  finishOld(page([turn('old', 'completed', [answer('stale')])]));
  await expect(opening).resolves.toBe(true);
  expect(getTurn('new')?.items).toEqual([expect.objectContaining({ content: 'newest' })]);
  expect(getTurn('old')).toBeUndefined();
});

it('reveals after required work while a completed-turn sweep is still outstanding', async () => {
  useTimelineStore.getState().hydrateOpenedThread({ threadId: 't', turnsNewestFirst: [turn('active', 'inProgress'), turn('old', 'completed')], historyCursor: null, readOnlyReason: null });
  headers.mockResolvedValueOnce(page([turn('active', 'inProgress')]));
  let finish!: (reply: ItemReply) => void;
  items.mockReturnValueOnce(new Promise<ItemReply>((resolve) => { finish = resolve; }));
  await expect(recoverThreadAfterReconnect('t')).resolves.toBe(true);
  expect(items).toHaveBeenCalledTimes(1);
  finish({ data: { items: [answer('late')], complete: true, nextCursor: null, incompleteReason: null }, request: new Request('http://localhost'), response: new Response() });
  await vi.waitFor(() => expect(getTurn('old')?.items).toEqual([expect.objectContaining({ content: 'late' })]));
});

it('keeps an old reading bookmark inside the eight-turn sweep budget', async () => {
  const retained = Array.from({ length: 14 }, (_, index) => turn(`old${index}`, 'completed'));
  useTimelineStore.getState().hydrateOpenedThread({ threadId: 't', turnsNewestFirst: [turn('active', 'inProgress'), ...retained], historyCursor: null, readOnlyReason: null });
  saveTranscriptBookmark('t', { follow: false, offset: 100, width: 800, anchor: {
    rowKey: 'turn:old13:0', itemId: 'answer', block: 0, blockKey: null, textOffset: 0, viewportY: 8, rowViewportY: 0,
  } });
  headers.mockResolvedValueOnce(page([turn('active', 'inProgress')]));
  await recoverThreadAfterReconnect('t');
  await vi.waitFor(() => expect(items).toHaveBeenCalledTimes(8));
  expect(items.mock.calls[0][0]?.path.turnId).toBe('old13');
});
