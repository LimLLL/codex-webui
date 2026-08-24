import { CodexService } from '../codex/codex.service';
import { ErrorCode } from '../common/error-codes';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadsBranchingService } from './threads-branching.service';

describe('ThreadsBranchingService', () => {
  let service: ThreadsBranchingService;

  const mockCodex = { request: jest.fn() };
  const mockResumeRegistry = {
    markResumed: jest.fn(),
    cacheResponse: jest.fn(),
    forget: jest.fn(),
  };
  const mockBranches = {
    recordMessageBranch: jest.fn(),
    resolveTreeRootThreadId: jest.fn(),
  };

  beforeEach(() => {
    service = new ThreadsBranchingService(
      mockCodex as unknown as CodexService,
      mockResumeRegistry as unknown as ThreadResumeRegistryService,
      mockBranches as unknown as ConversationBranchesService,
    );
    mockCodex.request.mockReset();
    Object.values(mockResumeRegistry).forEach((mock) => mock.mockReset());
    Object.values(mockBranches).forEach((mock) => mock.mockReset());
    mockBranches.resolveTreeRootThreadId.mockImplementation(
      (threadId: string): string => threadId,
    );
  });

  it('creates a message branch by forking before the edited turn', async () => {
    mockCodex.request
      .mockResolvedValueOnce({
        thread: {
          id: 'source',
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
          turns: [completedUserTurn('turn-a', 'first')],
        },
      });
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
          turns: [
            completedUserTurn('turn-a', 'first'),
            completedUserTurn('turn-b', 'second'),
          ],
        },
      })
      .mockResolvedValueOnce({});

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
          status: { type: 'idle' },
          turns: [completedUserTurn('turn-a', 'first')],
        },
      })
      .mockResolvedValueOnce({
        thread: { id: 'child', turns: [] },
      })
      .mockResolvedValueOnce({});
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

  it('blocks branch creation while the source thread is active', async () => {
    mockCodex.request.mockResolvedValueOnce({
      thread: {
        id: 'source',
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
