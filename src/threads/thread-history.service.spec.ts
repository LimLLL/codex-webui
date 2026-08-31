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
      .mockResolvedValueOnce({
        thread: { id: 't1', turns: [], historyMode: 'paginated' },
      })
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
      thread: { id: 't1', turns: [], historyMode: 'paginated' },
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

  it('removes misalignment steering from paged history', async () => {
    mockCodex.request.mockResolvedValueOnce({
      data: [
        {
          id: 'turn-1',
          items: [],
          status: 'failed',
          error: {
            message: 'blocked',
            codexErrorInfo: 'misalignmentPolicyViolation',
            additionalDetails: null,
            misalignment: {
              errorType: 'policy',
              detailedExplanation: 'display this',
              steer: { message: 'do not send this' },
            },
          },
        },
      ],
      nextCursor: null,
      backwardsCursor: null,
    });

    const page = await service.listTurns({ threadId: 't1' });

    expect(page.data[0]?.error?.misalignment).toEqual({
      errorType: 'policy',
      detailedExplanation: 'display this',
    });
  });

  it('returns unknown count when a graph node cannot be counted', async () => {
    mockCodex.request.mockRejectedValue(new Error('gone'));

    await expect(service.countTurnsForThreads(['missing'])).resolves.toEqual([
      { threadId: 'missing', count: null, errorMessage: 'gone' },
    ]);
  });

  it('normalizes the pinned empty-thread item refusal without a fallback call', async () => {
    mockCodex.request.mockRejectedValueOnce(
      new CodexRpcError(
        { code: -32601, message: 'thread/items/list is not supported yet' },
        { method: 'thread/items/list' },
      ),
    );

    await expect(service.listTurnItems('t1', 'turn-1')).resolves.toEqual([]);
    expect(mockCodex.request).toHaveBeenCalledTimes(1);
  });

  it('does not normalize the same item wording from another method', async () => {
    const error = new CodexRpcError(
      { code: -32601, message: 'thread/items/list is not supported yet' },
      { method: 'thread/turns/list' },
    );
    mockCodex.request.mockRejectedValueOnce(error);

    await expect(service.listTurnItems('t1', 'turn-1')).rejects.toBe(error);
  });

  it('discovers all turn IDs in chronological order without loading items', async () => {
    mockCodex.request
      .mockResolvedValueOnce({
        data: [{ id: 'turn-3' }, { id: 'turn-2' }],
        nextCursor: 'older',
        backwardsCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'turn-1' }],
        nextCursor: null,
        backwardsCursor: null,
      });

    await expect(service.listAllTurnIds('t1')).resolves.toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
    ]);
    expect(mockCodex.request).toHaveBeenNthCalledWith(1, 'thread/turns/list', {
      threadId: 't1',
      cursor: undefined,
      limit: 200,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    });
  });

  it('treats the pinned pre-message turn-list refusal as no IDs', async () => {
    mockCodex.request.mockRejectedValueOnce(
      new CodexRpcError(
        {
          code: -32600,
          message:
            'thread t1 is not materialized yet; thread/turns/list is unavailable before first user message',
        },
        { method: 'thread/turns/list' },
      ),
    );

    await expect(service.listAllTurnIds('t1')).resolves.toEqual([]);
  });

  it('fails closed when turn paging repeats a cursor', async () => {
    mockCodex.request
      .mockResolvedValueOnce({ data: [{ id: 'two' }], nextCursor: 'same' })
      .mockResolvedValueOnce({ data: [{ id: 'one' }], nextCursor: 'same' });

    await expect(service.listAllTurnIds('t1')).rejects.toThrow(
      'cursor did not advance',
    );
  });

  it('fails closed when fresh turn cursors exceed the page cap', async () => {
    // The cursor and ids advance every page, so neither the repeat guard nor
    // the duplicate guard fires — only the cap terminates this. Truncating
    // instead would commit a short prefix as fork provenance.
    let page = 0;
    mockCodex.request.mockImplementation(() => {
      page += 1;
      return Promise.resolve({
        data: [{ id: `turn-${page}` }],
        nextCursor: `cursor-${page}`,
        backwardsCursor: null,
      });
    });

    await expect(service.listAllTurnIds('t1')).rejects.toThrow(
      'exceeded 200 pages',
    );
    expect(mockCodex.request).toHaveBeenCalledTimes(200);
  });
});
