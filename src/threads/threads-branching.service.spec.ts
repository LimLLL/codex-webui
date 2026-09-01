import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import { ErrorCode } from '../common/error-codes';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import {
  InProgressTurnHistoryError,
  ThreadHistoryService,
} from './thread-history.service';
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
  const mockHistory = {
    listAllTurnIds: vi.fn(),
    listAllSettledTurnIds: vi.fn(),
    readTurnUserMessage: vi.fn(),
    readThreadMetadata: vi.fn(),
  };

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
    Object.values(mockHistory).forEach((mock) => mock.mockReset());
    mockBranches.hasForkEdge.mockReturnValue(false);
    mockBranches.resolveTreeRootThreadId.mockImplementation(
      (threadId: string): string => threadId,
    );
    mockHistory.listAllSettledTurnIds.mockResolvedValue(['turn-a']);
    mockHistory.readTurnUserMessage.mockResolvedValue(userInput('first'));
    mockHistory.readThreadMetadata.mockResolvedValue(
      sourceMetadata({ type: 'idle' }),
    );
  });

  it('creates a message branch by forking before the edited turn', async () => {
    mockCodex.request.mockResolvedValueOnce({
      thread: {
        id: 'child',
        historyMode: 'paginated',
        forkedFromId: 'source',
        turns: [],
      },
    });
    mockHistory.listAllSettledTurnIds.mockResolvedValue(['turn-a', 'turn-b']);
    mockHistory.readTurnUserMessage.mockResolvedValue(userInput('second'));
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

    expect(mockHistory.readThreadMetadata).toHaveBeenCalledWith('source');
    expect(mockCodex.request).toHaveBeenNthCalledWith(1, 'thread/fork', {
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
    mockHistory.listAllSettledTurnIds.mockResolvedValue(['turn-a', 'turn-b']);
    mockHistory.readTurnUserMessage.mockResolvedValue(userInput('second'));
    mockHistory.listAllTurnIds.mockResolvedValue(['turn-a', 'turn-b']);

    await expect(
      service.createMessageBranch('source', { editedTurnId: 'turn-b' }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.threads.branchPrefixMismatch,
    });

    expect(mockCodex.request).toHaveBeenNthCalledWith(2, 'thread/delete', {
      threadId: 'child',
    });
    expect(mockBranches.recordMessageBranch).not.toHaveBeenCalled();
  });

  it('cleans up the fork when branch metadata persistence fails', async () => {
    mockCodex.request
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

    expect(mockCodex.request).toHaveBeenNthCalledWith(2, 'thread/delete', {
      threadId: 'child',
    });
  });

  it('preserves a message-branch child once its edge is durable', async () => {
    mockCodex.request.mockResolvedValueOnce({
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

    expect(mockCodex.request).toHaveBeenCalledTimes(1);
    expect(mockCodex.request).not.toHaveBeenCalledWith(
      'thread/delete',
      expect.anything(),
    );
  });

  it('blocks branch creation while the source thread is active', async () => {
    mockHistory.readThreadMetadata.mockResolvedValue(
      sourceMetadata({ type: 'active', activeFlags: [] }),
    );

    await expect(
      service.createMessageBranch('source', { editedTurnId: 'turn-a' }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.threads.branchThreadInProgress,
    });

    expect(mockCodex.request).not.toHaveBeenCalled();
  });

  it('stops the descending source walk as soon as it observes activity', async () => {
    mockHistory.listAllSettledTurnIds.mockRejectedValue(
      new InProgressTurnHistoryError('source', 'turn-running'),
    );

    await expect(
      service.createMessageBranch('source', { editedTurnId: 'turn-a' }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.threads.branchThreadInProgress,
    });

    expect(mockHistory.readTurnUserMessage).not.toHaveBeenCalled();
    expect(mockHistory.readThreadMetadata).not.toHaveBeenCalled();
    expect(mockCodex.request).not.toHaveBeenCalled();
  });
});

function sourceMetadata(status: v2.ThreadStatus): v2.ThreadReadResponse {
  return {
    thread: {
      id: 'source',
      historyMode: 'paginated',
      status,
      turns: [],
    } as v2.Thread,
  };
}

function userInput(text: string): v2.UserInput[] {
  return [{ type: 'text', text, text_elements: [] }];
}
