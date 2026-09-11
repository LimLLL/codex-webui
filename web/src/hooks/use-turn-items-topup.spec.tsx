/** A cached/partial history response must not replace newer terminal evidence. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { threadsListTurnItems } from '@/generated/api/sdk.gen';
import type { TurnDto } from '@/generated/api';
import { useTimelineStore } from '@/stores/timeline-store';
import { useTurnItemsTopUp } from './use-turn-items-topup';
import { invalidateThreadDetails } from '@/lib/query-invalidation';
import { threadsListTurnItemsQueryKey } from '@/generated/api/@tanstack/react-query.gen';

const initial = useTimelineStore.getState();
beforeEach(() => { useTimelineStore.setState(initial, true); vi.clearAllMocks(); });

vi.mock('@/socket', () => ({ getSocket: () => ({ emit: vi.fn() }) }));
vi.mock('@/generated/api/sdk.gen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/generated/api/sdk.gen')>()),
  threadsListTurnItems: vi.fn(),
}));

it('keeps a terminal notification received while an incomplete top-up was in flight', async () => {
  type Reply = Awaited<ReturnType<typeof threadsListTurnItems<true>>>;
  let respond!: (reply: Reply) => void;
  vi.mocked(threadsListTurnItems).mockReturnValueOnce(
    new Promise<Reply>((resolve) => {
      respond = resolve;
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({
    threadId: 'thread',
    turnsNewestFirst: [
      {
        id: 'turn',
        status: 'completed',
        itemsView: 'summary',
        items: [
          {
            id: 'command',
            type: 'commandExecution',
            command: 'echo done',
            aggregatedOutput: 'old',
          },
        ],
      } as unknown as TurnDto,
    ],
    historyCursor: null,
    readOnlyReason: null,
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useTurnItemsTopUp({
        threadId: 'thread',
        turnId: 'turn',
        itemsView: 'summary',
        completed: true,
      }),
    { wrapper },
  );
  await waitFor(() => expect(threadsListTurnItems).toHaveBeenCalledOnce());
  act(() =>
    store.updateTurnItemForThread('thread', 'turn', 'command', () => ({
      itemId: 'command',
      type: 'commandExecution',
      command: 'echo done',
      content: 'new terminal output',
      completed: true,
    })),
  );
  await act(async () => {
    respond({
      data: {
        items: [
          {
            id: 'command',
            type: 'commandExecution',
            command: 'echo done',
            aggregatedOutput: 'old',
          },
          { id: 'gap', type: 'agentMessage', text: 'recovered' },
        ],
        complete: false,
        nextCursor: null,
        incompleteReason: 'pagingUnavailable',
      },
    } as Reply);
  });
  await waitFor(() => {
    const turn = useTimelineStore
      .getState()
      .getThreadRuntime('thread')!
      .timeline.find((entry) => entry.kind === 'turn');
    expect(
      turn?.kind === 'turn' && turn.items.some((item) => item.itemId === 'gap'),
    ).toBe(true);
    const command =
      turn?.kind === 'turn'
        ? turn.items.find((item) => item.itemId === 'command')
        : undefined;
    expect(command?.type === 'commandExecution' && command.content).toBe(
      'new terminal output',
    );
    expect(turn?.kind === 'turn' && turn.itemsView).toBe('summary');
  });
  hook.unmount();
  client.clear();
});

it('refreshes a full completed turn after a gap and defers inactive history until viewed', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({ threadId: 'owner', turnsNewestFirst: [{
    id: 'old', status: 'completed', itemsView: 'summary', items: [], error: null, startedAt: null, completedAt: null, durationMs: null,
  } satisfies TurnDto], historyCursor: null, readOnlyReason: null });
  store.applyFullTurnItemsForThread('owner', 'old', [{ type: 'agentMessage', id: 'answer', text: 'done' }]);
  const original = { items: [{ type: 'agentMessage', id: 'answer', text: 'done' }], complete: true, nextCursor: null, incompleteReason: null };
  const key = threadsListTurnItemsQueryKey({ path: { threadId: 'owner', turnId: 'old' } });
  const backgroundKey = threadsListTurnItemsQueryKey({ path: { threadId: 'owner', turnId: 'older' } });
  client.setQueryData(key, original);
  client.setQueryData(backgroundKey, original);
  const late = { type: 'subAgentActivity', id: 'subagent-completed-child-turn', kind: 'completed', agentThreadId: 'child', agentPath: '/root/child' };
  vi.mocked(threadsListTurnItems).mockResolvedValue({ data: { ...original, items: [...original.items, late] } } as Awaited<ReturnType<typeof threadsListTurnItems<true>>>);
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(({ turnId }) => useTurnItemsTopUp({ threadId: 'owner', turnId, itemsView: 'full', completed: true }), {
    wrapper, initialProps: { turnId: 'old' },
  });
  await act(async () => { invalidateThreadDetails(client, 'owner'); });
  await waitFor(() => {
    const turn = store.getThreadRuntime('owner')?.timeline.find((row) => row.kind === 'turn');
    expect(turn).toMatchObject({ completed: true, itemsView: 'full', items: expect.arrayContaining([expect.objectContaining({ itemId: late.id })]) });
  });
  expect(threadsListTurnItems).toHaveBeenCalledTimes(1);
  expect(client.getQueryState(backgroundKey)?.isInvalidated).toBe(true);
  hook.rerender({ turnId: 'older' });
  await waitFor(() => expect(threadsListTurnItems).toHaveBeenCalledTimes(2));
  hook.unmount(); client.clear();
});

it('replaces an initial in-flight item read on a gap instead of joining it', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = useTimelineStore.getState();
  store.hydrateOpenedThread({ threadId: 'owner', turnsNewestFirst: [{ id: 'old', status: 'completed', itemsView: 'summary', items: [], error: null, startedAt: null, completedAt: null, durationMs: null } satisfies TurnDto], historyCursor: null, readOnlyReason: null });
  type Reply = Awaited<ReturnType<typeof threadsListTurnItems<true>>>;
  let oldResponse!: (value: Reply) => void;
  vi.mocked(threadsListTurnItems)
    .mockReturnValueOnce(new Promise<Reply>((resolve) => { oldResponse = resolve; }))
    .mockResolvedValueOnce({ data: { items: [{ type: 'agentMessage', id: 'answer', text: 'fresh' }], complete: true, nextCursor: null } } as Reply);
  const hook = renderHook(() => useTurnItemsTopUp({ threadId: 'owner', turnId: 'old', itemsView: 'summary', completed: true }), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(threadsListTurnItems).toHaveBeenCalledTimes(1));
  await act(async () => { invalidateThreadDetails(client, 'owner'); });
  await waitFor(() => expect(threadsListTurnItems).toHaveBeenCalledTimes(2));
  await act(async () => oldResponse({ data: { items: [], complete: true, nextCursor: null, incompleteReason: null }, request: new Request('http://localhost'), response: new Response() }));
  await waitFor(() => expect(store.getThreadRuntime('owner')?.timeline.find((row) => row.kind === 'turn'))
    .toMatchObject({ items: [expect.objectContaining({ content: 'fresh' })] }));
  hook.unmount(); client.clear();
});
