/** A cached/partial history response must not replace newer terminal evidence. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { expect, it, vi } from 'vitest';
import { threadsListTurnItems } from '@/generated/api/sdk.gen';
import type { TurnDto } from '@/generated/api';
import { useTimelineStore } from '@/stores/timeline-store';
import { useTurnItemsTopUp } from './use-turn-items-topup';

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
