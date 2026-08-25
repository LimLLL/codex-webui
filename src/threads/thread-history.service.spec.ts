import { CodexService } from '../codex/codex.service';
import { ThreadHistoryService } from './thread-history.service';

describe('ThreadHistoryService', () => {
  const mockCodex = { request: jest.fn() };
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
});
