/** Reconnect must recover actual transcript content, not just an active pointer. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { threadsListTurnItems, threadsListTurns } from '@/generated/api/sdk.gen';
import type { TurnDto } from '@/generated/api';
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
  id, status, items: [], itemsView: 'notLoaded', error: null,
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
    const turn = store.getThreadRuntime('t')!.timeline.find((entry) => entry.kind === 'turn');
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
    const turn = store.getThreadRuntime('t')!.timeline.find((entry) => entry.kind === 'turn');
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
    const turn = store.getThreadRuntime('t')!.timeline.find((entry) => entry.kind === 'turn');
    expect(turn?.plan?.planTextByItemId?.plan).toMatchObject({ text: 'whole plan', completed: true });
  });
});
