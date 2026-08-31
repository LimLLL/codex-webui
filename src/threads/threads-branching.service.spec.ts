import { CodexService } from '../codex/codex.service';
import { ErrorCode } from '../common/error-codes';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadHistoryService } from './thread-history.service';
import { ThreadsBranchingService } from './threads-branching.service';

describe('ThreadsBranchingService', () => {
  let service: ThreadsBranchingService;

  const mockCodex = { request: vi.fn() };
  const mockResumeRegistry = {
    markResumed: vi.fn(),
    cacheResponse: vi.fn(),
    forget: vi.fn(),
  };
  const mockBranches = {
    hasForkEdge: vi.fn(),
    recordMessageBranch: vi.fn(),
    resolveTreeRootThreadId: vi.fn(),
  };
  const mockHistory = { listAllTurnIds: vi.fn() };

  beforeEach(() => {
    service = new ThreadsBranchingService(
      mockCodex as unknown as CodexService,
      mockResumeRegistry as unknown as ThreadResumeRegistryService,
      mockBranches as unknown as ConversationBranchesService,
      mockHistory as unknown as ThreadHistoryService,
    );
    mockCodex.request.mockReset();
    Object.values(mockResumeRegistry).forEach((mock) => mock.mockReset());
    Object.values(mockBranches).forEach((mock) => mock.mockReset());
    mockHistory.listAllTurnIds.mockReset();
    mockBranches.hasForkEdge.mockReturnValue(false);
    mockBranches.resolveTreeRootThreadId.mockImplementation(
      (threadId: string): string => threadId,
    );
  });

  it('creates a message branch by forking before the edited turn', async () => {
    mockCodex.request
      .mockResolvedValueOnce({
        thread: {
          id: 'source',
          historyMode: 'paginated',
          status: { type: 'idle' },
          turns: [
            completedUserTurn('turn-a', 'first'),
            completedUserTurn('turn-b', 'second'),
          ],
        },
      })
      .mockResolvedValueOnce({
        thread: {
          id: 'child',
          historyMode: 'paginated',
          forkedFromId: 'source',
          turns: [],
        },
      });
    mockHistory.listAllTurnIds.mockResolvedValue(['turn-a']);
    mockBranches.resolveTreeRootThreadId.mockReturnValue('root');
    mockBranches.recordMessageBranch.mockReturnValue({
      tree: {
        treeRootThreadId: 'root',
        tracked: true,
        members: [],
        groups: [],
      },
      group: {
        groupId: 'group',
        treeRootThreadId: 'root',
        commonPrefixTurnId: 'turn-a',
        createdAt: 1,
        updatedAt: 1,
        versions: [],
      },
      version: {
        versionId: 'version',
        groupId: 'group',
        threadId: 'child',
        versionIndex: 2,
        kind: 'branch',
        messageTurnId: null,
        previewText: 'edited',
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await service.createMessageBranch('source', {
      editedTurnId: 'turn-b',
      previewText: 'edited',
    });

    expect(mockCodex.request).toHaveBeenNthCalledWith(1, 'thread/read', {
      threadId: 'source',
      includeTurns: true,
    });
    expect(mockCodex.request).toHaveBeenNthCalledWith(2, 'thread/fork', {
      threadId: 'source',
      beforeTurnId: 'turn-b',
      excludeTurns: true,
    });
    expect(mockBranches.recordMessageBranch).toHaveBeenCalledWith({
      sourceThreadId: 'source',
      childThreadId: 'child',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-a',
      editedTurnId: 'turn-b',
      inheritedTurnIds: ['turn-a'],
      originalPreviewText: 'second',
      branchPreviewText: 'edited',
    });
    expect(mockResumeRegistry.markResumed).toHaveBeenCalledWith('child');
  });

  it('discards a fork whose prefix does not match the requested boundary', async () => {
    mockCodex.request
      .mockResolvedValueOnce({
        thread: {
          id: 'source',
          historyMode: 'paginated',
          status: { type: 'idle' },
          turns: [
            completedUserTurn('turn-a', 'first'),
            completedUserTurn('turn-b', 'second'),
          ],
        },
      })
      // app-server kept turn-b, so the child is not the branch we asked for.
      .mockResolvedValueOnce({
        thread: {
          id: 'child',
          historyMode: 'paginated',
          forkedFromId: 'source',
          turns: [],
        },
      })
      .mockResolvedValueOnce({});
    mockHistory.listAllTurnIds.mockResolvedValue(['turn-a', 'turn-b']);

    await expect(
      service.createMessageBranch('source', { editedTurnId: 'turn-b' }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.threads.branchPrefixMismatch,
    });

    expect(mockCodex.request).toHaveBeenNthCalledWith(3, 'thread/delete', {
      threadId: 'child',
    });
    expect(mockBranches.recordMessageBranch).not.toHaveBeenCalled();
  });

  it('cleans up the fork when branch metadata persistence fails', async () => {
    mockCodex.request
      .mockResolvedValueOnce({
        thread: {
          id: 'source',
          historyMode: 'paginated',
          status: { type: 'idle' },
          turns: [completedUserTurn('turn-a', 'first')],
        },
      })
      .mockResolvedValueOnce({
        thread: {
          id: 'child',
          historyMode: 'paginated',
          forkedFromId: 'source',
          turns: [],
        },
      })
      .mockResolvedValueOnce({});
    mockHistory.listAllTurnIds.mockResolvedValue([]);
    mockBranches.recordMessageBranch.mockImplementation(() => {
      throw new Error('db failed');
    });

    await expect(
      service.createMessageBranch('source', { editedTurnId: 'turn-a' }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.threads.branchMetadataFailed,
    });

    expect(mockCodex.request).toHaveBeenNthCalledWith(3, 'thread/delete', {
      threadId: 'child',
    });
  });

  it('preserves a message-branch child once its edge is durable', async () => {
    mockCodex.request
      .mockResolvedValueOnce({
        thread: {
          id: 'source',
          historyMode: 'paginated',
          status: { type: 'idle' },
          turns: [completedUserTurn('turn-a', 'first')],
        },
      })
      .mockResolvedValueOnce({
        thread: {
          id: 'child',
          historyMode: 'paginated',
          forkedFromId: 'source',
          turns: [],
        },
      });
    mockHistory.listAllTurnIds.mockResolvedValue([]);
    mockBranches.recordMessageBranch.mockImplementation(() => {
      throw new Error('projection failed after commit');
    });
    mockBranches.hasForkEdge.mockReturnValue(true);

    await expect(
      service.createMessageBranch('source', { editedTurnId: 'turn-a' }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.threads.branchMetadataFailed,
    });

    expect(mockCodex.request).toHaveBeenCalledTimes(2);
    expect(mockCodex.request).not.toHaveBeenCalledWith(
      'thread/delete',
      expect.anything(),
    );
  });

  it('blocks branch creation while the source thread is active', async () => {
    mockCodex.request.mockResolvedValueOnce({
      thread: {
        id: 'source',
        historyMode: 'paginated',
        status: { type: 'active', activeFlags: [] },
        turns: [completedUserTurn('turn-a', 'first')],
      },
    });

    await expect(
      service.createMessageBranch('source', { editedTurnId: 'turn-a' }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.threads.branchThreadInProgress,
    });

    expect(mockCodex.request).toHaveBeenCalledTimes(1);
  });
});

function completedUserTurn(id: string, text: string) {
  return {
    id,
    status: 'completed',
    items: [
      {
        type: 'userMessage',
        id: `${id}-item`,
        clientId: null,
        content: [{ type: 'text', text, text_elements: [] }],
      },
    ],
    itemsView: 'full',
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 100,
  };
}
