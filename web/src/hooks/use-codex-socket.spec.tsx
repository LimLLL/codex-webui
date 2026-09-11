/** Global attention must work without transcript rooms, including recovery. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { useCodexSocket } from './use-codex-socket';
import { useTimelineStore } from '@/stores/timeline-store';
import { useSnackbarStore } from '@/stores/snackbar-store';

const transport = vi.hoisted(() => ({
  listeners: new Map<string, (value: unknown) => void>(),
  read: vi.fn(),
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
vi.mock('@/generated/api/sdk.gen', () => ({
  pendingApprovalsListPending: transport.read,
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
