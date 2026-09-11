/** Global attention must work without transcript rooms, including recovery. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { useCodexSocket } from './use-codex-socket';
import { useTimelineStore } from '@/stores/timeline-store';
import { useSnackbarStore } from '@/stores/snackbar-store';
import { useTurnItemsTopUp } from './use-turn-items-topup';
import type { TurnDto } from '@/generated/api';
import { threadsListTurnItemsQueryKey } from '@/generated/api/@tanstack/react-query.gen';

const transport = vi.hoisted(() => ({
  listeners: new Map<string, (value: unknown) => void>(),
  read: vi.fn(),
  items: vi.fn(),
  restore: vi.fn(async () => undefined),
  emit: vi.fn(
    (
      _event: string,
      _payload: unknown,
      callback?: (reply: { ok: boolean }) => void,
    ) => callback?.({ ok: true }),
  ),
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    connected: true,
    emit: transport.emit,
    timeout: () => ({
      emit: (
        _event: string,
        _payload: unknown,
        callback: (error: null, reply: { ok: boolean }) => void,
      ) => callback(null, { ok: true }),
    }),
    on: (name: string, handler: (value: unknown) => void) =>
      transport.listeners.set(name, handler),
    off: (name: string) => transport.listeners.delete(name),
  }),
}));
vi.mock('@/generated/api/sdk.gen', async (original) => ({
  ...await original<typeof import('@/generated/api/sdk.gen')>(),
  pendingApprovalsListPending: transport.read,
  threadsListTurnItems: transport.items,
}));
vi.mock('@/lib/thread-restore', () => ({ restoreThread: transport.restore }));
const initial = useTimelineStore.getState();
const params = {
  threadId: 'background',
  turnId: 'turn',
  itemId: 'item',
  command: 'pwd',
};
const row = {
  requestId: 'r',
  generation: 1,
  method: 'item/commandExecution/requestApproval',
  ...params,
  params,
  reviewSubject: null,
  status: 'pending',
  createdAt: 1,
  updatedAt: 1,
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useCodexSocket(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}
beforeEach(() => {
  useTimelineStore.setState(initial, true);
  useSnackbarStore.getState().clear();
  transport.listeners.clear();
  vi.clearAllMocks();
  transport.read.mockResolvedValue({ data: { generation: 1, requests: [] } });
});

it('refreshes a viewed completed owner on readiness even when only its child is announced', async () => {
  const store = useTimelineStore.getState();
  store.setActiveThread('owner');
  store.hydrateOpenedThread({ threadId: 'owner', turnsNewestFirst: [{ id: 'old', status: 'completed', itemsView: 'summary', items: [], error: null, startedAt: null, completedAt: null, durationMs: null } satisfies TurnDto], historyCursor: null, readOnlyReason: null });
  store.applyFullTurnItemsForThread('owner', 'old', [{ type: 'agentMessage', id: 'answer', text: 'done' }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = threadsListTurnItemsQueryKey({ path: { threadId: 'owner', turnId: 'old' } });
  const original = { items: [{ type: 'agentMessage', id: 'answer', text: 'done' }], complete: true, nextCursor: null };
  client.setQueryData(key, original);
  transport.items.mockResolvedValue({ data: original });
  const view = renderHook(() => {
    useCodexSocket();
    useTurnItemsTopUp({ threadId: 'owner', turnId: 'old', itemsView: 'full', completed: true });
  }, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await waitFor(() => expect(transport.items).toHaveBeenCalled());
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const activity = { type: 'subAgentActivity', id: 'subagent-completed-child-turn', kind: 'completed', agentThreadId: 'child', agentPath: '/root/child' };
  transport.items.mockResolvedValue({ data: { ...original, items: [...original.items, activity] } });
  transport.restore.mockClear();
  await act(async () => {
    transport.listeners.get('codex.lifecycle')?.({ type: 'appServerRestarting', generation: 2, delayMs: 0 });
    transport.listeners.get('codex.lifecycle')?.({ type: 'appServerReady', generation: 2, restarted: true });
    transport.listeners.get('codex.lifecycle')?.({ type: 'autoResumeCompleted', generation: 2, resumedThreadIds: ['child'], failedThreadIds: [] });
  });
  await waitFor(() => expect(store.getThreadRuntime('owner')?.timeline.find((row) => row.kind === 'turn'))
    .toMatchObject({ completed: true, items: expect.arrayContaining([expect.objectContaining({ itemId: activity.id })]) }));
  expect(transport.restore).not.toHaveBeenCalledWith('owner', 'appServerRestart');
  expect(store.getThreadRuntime('child')).toBeNull();
  view.unmount(); client.clear();
});

it('ingests both late activity events into the initiating turn without reopening it or changing another active turn', async () => {
  const store = useTimelineStore.getState();
  store.setActiveThread('requester');
  store.hydrateOpenedThread({ threadId: 'requester', turnsNewestFirst: [{ id: 'old', status: 'completed', itemsView: 'summary', items: [], error: null, startedAt: null, completedAt: null, durationMs: null } satisfies TurnDto], historyCursor: null, readOnlyReason: null });
  store.setActiveTurnIdForThread('requester', 'new');
  store.setLoadingForThread('requester', true);
  const view = mount();
  await waitFor(() => expect(transport.read).toHaveBeenCalled());
  const params = { threadId: 'requester', turnId: 'old', item: {
    type: 'subAgentActivity', id: 'subagent-completed-worker-turn', kind: 'completed', agentThreadId: 'worker', agentPath: '/root/worker',
  } };
  const send = (method: string) => act(() => transport.listeners.get('codex.notification')?.({ method, params }));
  const turn = () => store.getThreadRuntime('requester')?.timeline.find((row) => row.kind === 'turn' && row.turnId === 'old');
  send('item/started');
  expect(turn()).toMatchObject({ completed: true, items: [expect.objectContaining({ itemId: params.item.id, completed: false })] });
  send('item/completed');
  send('item/started');
  send('item/completed');
  expect(turn()).toMatchObject({ completed: true, items: [expect.objectContaining({ itemId: params.item.id, completed: true })] });
  expect(store.getThreadRuntime('requester')).toMatchObject({ activeTurnId: 'new', loading: true });
  expect(store.getThreadRuntime('worker')).toBeNull();
  view.unmount();
});

it('notifies for an initial unscoped pending read and suppresses its live replay', async () => {
  transport.read.mockResolvedValue({
    data: { generation: 1, requests: [row] },
  });
  const view = mount();
  await waitFor(() =>
    expect(useSnackbarStore.getState().visible).toHaveLength(1),
  );
  expect(useTimelineStore.getState().subscribedThreadIds.size).toBe(0);
  act(() =>
    transport.listeners.get('codex.serverRequest')?.({ ...row, id: 'r' }),
  );
  expect(useSnackbarStore.getState().visible).toHaveLength(1);
  view.unmount();
});

it('does not hydrate the backend execution inventory into background browser runtimes', async () => {
  useTimelineStore.getState().setActiveThread('view');
  const view = mount();
  await waitFor(() => expect(transport.read).toHaveBeenCalled());
  transport.restore.mockClear();
  act(() =>
    transport.listeners.get('codex.lifecycle')?.({
      type: 'autoResumeCompleted',
      generation: 2,
      resumedThreadIds: ['view', 'background'],
      failedThreadIds: ['failed-background'],
    }),
  );
  expect(transport.restore).toHaveBeenCalledExactlyOnceWith(
    'view',
    'appServerRestart',
  );
  expect(useTimelineStore.getState().getThreadRuntime('background')).toBeNull();
  expect(
    useTimelineStore.getState().getThreadRuntime('failed-background'),
  ).toBeNull();
  view.unmount();
});

it('coalesces hints during a pending read into one trailing read and ignores post-unmount data', async () => {
  let finish!: (value: unknown) => void;
  transport.read.mockReturnValueOnce(
    new Promise((done) => {
      finish = done;
    }),
  );
  const view = mount();
  await waitFor(() => expect(transport.read).toHaveBeenCalledTimes(1));
  act(() => {
    for (let i = 0; i < 5; i++)
      transport.listeners.get('conversation.pending.changed')?.({
        generation: 1,
      });
  });
  await act(async () => {
    finish({ data: { generation: 1, requests: [] } });
  });
  await waitFor(() => expect(transport.read).toHaveBeenCalledTimes(2));
  transport.read.mockReturnValueOnce(
    new Promise((done) => {
      finish = done;
    }),
  );
  act(() =>
    transport.listeners.get('conversation.pending.changed')?.({
      generation: 1,
    }),
  );
  await waitFor(() => expect(transport.read).toHaveBeenCalledTimes(3));
  view.unmount();
  await act(async () => {
    finish({ data: { generation: 1, requests: [row] } });
  });
  expect(useTimelineStore.getState().getThreadRuntime('background')).toBeNull();
});
