import { readTurnItems } from './thread-item-history';

describe('bounded persisted item recovery', () => {
  const codex = { request: vi.fn() };
  const item = (id: string) => ({
    turnId: 'turn',
    item: {
      id,
      type: 'commandExecution',
      status: 'completed',
      aggregatedOutput: 'all output',
    },
  });
  beforeEach(() => vi.resetAllMocks());

  it('preserves completion order and accumulated payloads across pages', async () => {
    codex.request
      .mockResolvedValueOnce({ data: [item('quick')], nextCursor: 'second' })
      .mockResolvedValueOnce({ data: [item('slow')], nextCursor: null });
    await expect(
      readTurnItems(codex as never, 'thread', 'turn'),
    ).resolves.toEqual({
      entries: [item('quick'), item('slow')],
      complete: true,
      nextCursor: null,
      incompleteReason: null,
    });
  });

  it('returns a continuation instead of claiming a capped read is complete', async () => {
    let page = 0;
    codex.request.mockImplementation(() =>
      Promise.resolve({
        data: [item(String(++page))],
        nextCursor: String(page),
      }),
    );
    const result = await readTurnItems(codex as never, 'thread', 'turn');
    expect(result).toMatchObject({
      complete: false,
      nextCursor: '20',
      incompleteReason: 'pageLimit',
    });
    expect(result.entries).toHaveLength(20);
    codex.request.mockResolvedValue({ data: [], nextCursor: null });
    await expect(
      readTurnItems(codex as never, 'thread', 'turn', result.nextCursor!),
    ).resolves.toMatchObject({ complete: true });
    expect(codex.request).toHaveBeenLastCalledWith(
      'thread/items/list',
      expect.objectContaining({ cursor: '20' }),
    );
  });

  it('detects multi-page cursor cycles without advertising a looping continuation', async () => {
    codex.request
      .mockResolvedValueOnce({ data: [item('1')], nextCursor: 'a' })
      .mockResolvedValueOnce({ data: [item('2')], nextCursor: 'b' })
      .mockResolvedValueOnce({ data: [item('3')], nextCursor: 'a' });
    const result = await readTurnItems(codex as never, 'thread', 'turn');
    expect(result).toMatchObject({
      complete: false,
      nextCursor: null,
      incompleteReason: 'cursorCycle',
    });
    expect(result.entries).toHaveLength(3);
  });

  it.each([
    { data: [] },
    { data: [], nextCursor: 12 },
    { nextCursor: null },
    { data: [{ ...item('wrong'), turnId: 'other' }], nextCursor: null },
  ])('does not certify malformed history: %j', async (response) => {
    codex.request.mockResolvedValue(response);
    await expect(
      readTurnItems(codex as never, 'thread', 'turn'),
    ).resolves.toMatchObject({
      complete: false,
      incompleteReason: 'invalidResponse',
    });
  });

  it('treats explicit empty exhaustion as complete only for this read', async () => {
    codex.request.mockResolvedValue({ data: [], nextCursor: null });
    await expect(
      readTurnItems(codex as never, 'thread', 'turn'),
    ).resolves.toEqual({
      entries: [],
      complete: true,
      nextCursor: null,
      incompleteReason: null,
    });
  });
});
