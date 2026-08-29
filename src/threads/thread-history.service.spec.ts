import { CodexService } from '../codex/codex.service';
import { CodexRpcError } from '../codex/codex-errors';
import { ThreadHistoryService } from './thread-history.service';

describe('ThreadHistoryService', () => {
  const mockCodex = { request: vi.fn() };
  let service: ThreadHistoryService;

  beforeEach(() => {
    mockCodex.request.mockReset();
    service = new ThreadHistoryService(mockCodex as unknown as CodexService);
  });

  it('falls back to paged history when resume omits the experimental page', async () => {
    // `excludeTurns` empties `thread.turns` unconditionally, so an absent
    // `initialTurnsPage` is not an empty conversation — it is the experimental
    // surface no longer being honoured. Coercing it to `{ data: [] }` would
    // render every conversation blank instead of reporting the regression.
    mockCodex.request
      .mockResolvedValueOnce({ thread: { id: 't1', turns: [] } })
      .mockResolvedValueOnce({
        data: [{ id: 'turn-1' }],
        nextCursor: null,
        backwardsCursor: 'newer',
      });

    const response = await service.resumeMetadataFirst({
      threadId: 't1',
      initialTurnsLimit: 20,
      itemsView: 'summary',
    });

    expect(response.initialTurnsPage?.data).toHaveLength(1);
    expect(mockCodex.request).toHaveBeenNthCalledWith(
      2,
      'thread/turns/list',
      expect.objectContaining({ threadId: 't1', limit: 20 }),
    );
  });

  it('keeps an explicitly empty page as empty without a second request', async () => {
    // The other half of the distinction: a conversation really can have no
    // turns yet, and that must not trigger a fallback round trip.
    mockCodex.request.mockResolvedValueOnce({
      thread: { id: 't1', turns: [] },
      initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
    });

    const response = await service.resumeMetadataFirst({
      threadId: 't1',
      initialTurnsLimit: 20,
      itemsView: 'summary',
    });

    expect(response.initialTurnsPage?.data).toEqual([]);
    expect(mockCodex.request).toHaveBeenCalledTimes(1);
  });

  it('counts turns through non-resuming paged history', async () => {
    mockCodex.request
      .mockResolvedValueOnce({
        data: [{ id: 'a' }, { id: 'b' }],
        nextCursor: 'older',
        backwardsCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'c' }],
        nextCursor: null,
        backwardsCursor: null,
      });

    await expect(service.countTurnsForThreads(['t1'])).resolves.toEqual([
      { threadId: 't1', count: 3, errorMessage: null },
    ]);
    expect(mockCodex.request).toHaveBeenNthCalledWith(1, 'thread/turns/list', {
      threadId: 't1',
      cursor: undefined,
      limit: 200,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    });
    expect(mockCodex.request).toHaveBeenNthCalledWith(2, 'thread/turns/list', {
      threadId: 't1',
      cursor: 'older',
      limit: 200,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    });
  });

  it('returns unknown count when a graph node cannot be counted', async () => {
    mockCodex.request.mockRejectedValue(new Error('gone'));

    await expect(service.countTurnsForThreads(['missing'])).resolves.toEqual([
      { threadId: 'missing', count: null, errorMessage: 'gone' },
    ]);
  });

  it('falls back to full turn pages when thread/items/list is unsupported', async () => {
    mockCodex.request
      .mockRejectedValueOnce(
        new CodexRpcError(
          { code: -32601, message: 'thread/items/list is not supported yet' },
          { method: 'thread/items/list' },
        ),
      )
      .mockResolvedValueOnce({
        data: [
          {
            id: 'turn-1',
            items: [{ type: 'plan', id: 'item-1', text: 'Plan' }],
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      });

    await expect(service.listTurnItems('t1', 'turn-1')).resolves.toEqual([
      {
        turnId: 'turn-1',
        item: { type: 'plan', id: 'item-1', text: 'Plan' },
      },
    ]);
    expect(mockCodex.request).toHaveBeenNthCalledWith(
      2,
      'thread/turns/list',
      expect.objectContaining({
        threadId: 't1',
        itemsView: 'full',
        sortDirection: 'desc',
      }),
    );
  });
});
