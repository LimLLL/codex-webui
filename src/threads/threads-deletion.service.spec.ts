import { CodexRpcError } from '../codex/codex-errors';
import type { v2 } from '../codex/codex-schema';
import { CodexService } from '../codex/codex.service';
import { ConversationBranchAdoptionService } from '../conversation-branches/conversation-branch-adoption.service';
import { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';
import type { BranchAdoptionStatusDto } from '../conversation-branches/dto/conversation-branches.dto';
import type { AppDatabase } from '../database/database.constants';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadsDeletePlannerService } from './threads-delete-planner.service';
import { ThreadsDeletionService } from './threads-deletion.service';

const readyAdoption = {
  status: 'ready',
  generation: 1,
  scannedFiles: 0,
  parsedFiles: 0,
  fullyParsedFiles: 0,
  adoptedEdges: 0,
  adoptedVersions: 0,
  topologyOnlyEdges: 0,
  skippedLegacyForks: 0,
  skippedFiles: 0,
  conflicts: 0,
  diagnostics: [],
} satisfies BranchAdoptionStatusDto;

describe('ThreadsDeletionService', () => {
  let service: ThreadsDeletionService;
  let requestLog: string[];
  const mockCodex = { request: jest.fn() };
  const mockAdoption = {
    assertReadyForDeletion: jest.fn(),
    getBlockingDiagnostics: jest.fn(),
    getStatus: jest.fn(),
  };
  const mockBranchMutations = {
    listEdges: jest.fn(),
    reapDeletedThread: jest.fn(),
  };
  const mockPendingApprovals = {
    listPending: jest.fn(),
    cancelPendingForThreads: jest.fn(),
  };
  const mockResumeRegistry = { forget: jest.fn() };
  const mockDeletionRegistry = {
    begin: jest.fn(),
    end: jest.fn(),
  };
  const mockDb = makeDbMock();

  beforeEach(() => {
    requestLog = [];
    const planner = new ThreadsDeletePlannerService(
      mockCodex as unknown as CodexService,
      mockAdoption as unknown as ConversationBranchAdoptionService,
      mockBranchMutations as unknown as ConversationBranchMutationsService,
      mockPendingApprovals as unknown as PendingApprovalsService,
    );
    service = new ThreadsDeletionService(
      mockCodex as unknown as CodexService,
      planner,
      mockBranchMutations as unknown as ConversationBranchMutationsService,
      mockPendingApprovals as unknown as PendingApprovalsService,
      mockResumeRegistry as unknown as ThreadResumeRegistryService,
      mockDeletionRegistry as unknown as ThreadDeletionRegistryService,
      mockDb as unknown as AppDatabase,
    );

    mockCodex.request.mockReset();
    Object.values(mockAdoption).forEach((mock) => mock.mockReset());
    Object.values(mockBranchMutations).forEach((mock) => mock.mockReset());
    Object.values(mockPendingApprovals).forEach((mock) => mock.mockReset());
    Object.values(mockResumeRegistry).forEach((mock) => mock.mockReset());
    Object.values(mockDeletionRegistry).forEach((mock) => mock.mockReset());
    mockDb.delete.mockClear();
    mockAdoption.getStatus.mockReturnValue(readyAdoption);
    mockAdoption.getBlockingDiagnostics.mockReturnValue([]);
    mockBranchMutations.listEdges.mockReturnValue([]);
    mockPendingApprovals.listPending.mockReturnValue([]);
    mockPendingApprovals.cancelPendingForThreads.mockReturnValue([]);
  });

  it('deletes descendants before parents', async () => {
    const deleted: string[] = [];
    mockCodex.request.mockImplementation((method: string, params) => {
      requestLog.push(method);
      if (method === 'thread/list') {
        return Promise.resolve(
          listResponse(params, [
            makeThread('root'),
            makeThread('child', 'root'),
            makeThread('grandchild', 'child'),
          ]),
        );
      }
      if (method === 'thread/delete') {
        deleted.push((params as { threadId: string }).threadId);
        return Promise.resolve({});
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await service.deleteThread('root', {
      expectedThreadIds: ['root', 'child', 'grandchild'],
    });

    expect(result.status).toBe('completed');
    expect(result.deleteOrder).toEqual(['grandchild', 'child', 'root']);
    expect(deleted).toEqual(['grandchild', 'child', 'root']);
    expect(mockBranchMutations.reapDeletedThread).toHaveBeenCalledTimes(3);
  });

  it('returns a conflict when the planned id set changes under the delete guard', async () => {
    let planRead = 0;
    mockCodex.request.mockImplementation((method: string, params) => {
      requestLog.push(method);
      if (method === 'thread/list') {
        if ((params as { archived: boolean }).archived) {
          return Promise.resolve({
            data: [],
            nextCursor: null,
            backwardsCursor: null,
          });
        }
        planRead += 1;
        return Promise.resolve({
          data:
            planRead === 1
              ? [makeThread('root')]
              : [makeThread('root'), makeThread('child', 'root')],
          nextCursor: null,
          backwardsCursor: null,
        });
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await service.deleteThread('root', {
      expectedThreadIds: ['root'],
    });

    expect(result).toMatchObject({
      status: 'conflict',
      destructiveStarted: false,
      plannedThreadIds: ['root', 'child'],
    });
    expect(requestLog).not.toContain('thread/delete');
    expect(mockDeletionRegistry.end).toHaveBeenCalledWith(['root']);
  });

  it('reports partial success after a leaf was deleted and a later delete fails', async () => {
    mockCodex.request.mockImplementation((method: string, params) => {
      requestLog.push(method);
      if (method === 'thread/list') {
        return Promise.resolve(
          listResponse(params, [
            makeThread('root'),
            makeThread('child', 'root'),
          ]),
        );
      }
      if (method === 'thread/delete') {
        const threadId = (params as { threadId: string }).threadId;
        if (threadId === 'root') {
          throw new CodexRpcError({
            code: -32600,
            message:
              'cannot delete thread root: forked history still references it',
          });
        }
        return Promise.resolve({});
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await service.deleteThread('root', {
      expectedThreadIds: ['root', 'child'],
    });

    expect(result).toMatchObject({
      status: 'partial',
      destructiveStarted: true,
      deletedThreadIds: ['child'],
      reapedThreadIds: ['child'],
      remainingThreadIds: ['root'],
      failure: { stage: 'delete' },
    });
  });

  it('cancels pending approvals even when local cleanup then fails', async () => {
    mockCodex.request.mockImplementation((method: string, params) => {
      requestLog.push(method);
      if (method === 'thread/list') {
        return Promise.resolve(listResponse(params, [makeThread('root')]));
      }
      if (method === 'thread/delete') return Promise.resolve({});
      throw new Error(`unexpected ${method}`);
    });
    mockBranchMutations.reapDeletedThread.mockImplementation(() => {
      throw new Error('local topology is inconsistent');
    });
    mockPendingApprovals.cancelPendingForThreads.mockReturnValue([
      { requestId: 'req-1' },
    ]);

    const result = await service.deleteThread('root', {
      expectedThreadIds: ['root'],
    });

    // The conversation is gone on the server, so its requests can never be
    // answered. Leaving them pending because cleanup failed would let the
    // gateway's suppressed-request replay surface a card for a dead thread.
    expect(mockPendingApprovals.cancelPendingForThreads).toHaveBeenCalledWith(
      ['root'],
      'thread deleted',
    );
    expect(result).toMatchObject({
      status: 'partial',
      deletedThreadIds: ['root'],
      cancelledApprovalRequestIds: ['req-1'],
      failure: { stage: 'local_cleanup' },
    });
  });

  it('reports a plain failure when the first delete fails and nothing was destroyed', async () => {
    mockCodex.request.mockImplementation((method: string, params) => {
      requestLog.push(method);
      if (method === 'thread/list') {
        return Promise.resolve(
          listResponse(params, [
            makeThread('root'),
            makeThread('child', 'root'),
          ]),
        );
      }
      if (method === 'thread/delete') {
        throw new CodexRpcError({ code: -32603, message: 'transport failed' });
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await service.deleteThread('root', {
      expectedThreadIds: ['root', 'child'],
    });

    // The leaf delete never landed, so the tree is intact. Calling this
    // `partial` would tell the user their conversation is half-destroyed.
    expect(result).toMatchObject({
      status: 'failed',
      destructiveStarted: false,
      deletedThreadIds: [],
      reapedThreadIds: [],
      remainingThreadIds: ['root', 'child'],
    });
  });

  it('interrupts active turns and cancels pending approvals before deleting', async () => {
    const methods: string[] = [];
    mockPendingApprovals.listPending.mockReturnValue([
      {
        generation: 1,
        requestId: 'approval-1',
        threadId: 'root',
        turnId: 'turn-1',
        itemId: null,
        method: 'approval',
        params: {},
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    mockPendingApprovals.cancelPendingForThreads.mockReturnValue([
      {
        generation: 1,
        requestId: 'approval-1',
        threadId: 'root',
        turnId: 'turn-1',
        itemId: null,
        method: 'approval',
        params: {},
        status: 'cancelled',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    mockCodex.request.mockImplementation((method: string, params) => {
      methods.push(method);
      if (method === 'thread/list') {
        return Promise.resolve(
          listResponse(params, [
            makeThread('root', null, {
              status: { type: 'active', activeFlags: [] },
            }),
          ]),
        );
      }
      if (method === 'thread/read') {
        return Promise.resolve({
          thread: makeThread('root', null, {
            status: { type: 'active', activeFlags: [] },
            turns: [
              {
                id: 'turn-1',
                status: 'inProgress',
                items: [],
                itemsView: 'full',
                error: null,
                startedAt: 1,
                completedAt: null,
                durationMs: null,
              },
            ],
          }),
        });
      }
      if (method === 'turn/interrupt' || method === 'thread/delete') {
        return Promise.resolve({});
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await service.deleteThread('root', {
      expectedThreadIds: ['root'],
    });

    expect(result).toMatchObject({
      status: 'completed',
      interruptedThreadIds: ['root'],
      cancelledApprovalRequestIds: ['approval-1'],
      deletedThreadIds: ['root'],
    });
    expect(methods.indexOf('turn/interrupt')).toBeLessThan(
      methods.indexOf('thread/delete'),
    );
  });
});

function makeThread(
  id: string,
  forkedFromId: string | null = null,
  overrides: Partial<v2.Thread> = {},
): v2.Thread {
  return {
    id,
    sessionId: 'session',
    forkedFromId,
    parentThreadId: null,
    preview: id,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: 'idle' },
    path: null,
    cwd: '/tmp',
    cliVersion: '0.149.1',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function listResponse(
  params: unknown,
  activeThreads: v2.Thread[],
): v2.ThreadListResponse {
  return {
    data: (params as { archived: boolean }).archived ? [] : activeThreads,
    nextCursor: null,
    backwardsCursor: null,
  };
}

function makeDbMock() {
  return {
    delete: jest.fn(() => ({
      where: jest.fn(() => ({
        run: jest.fn(),
      })),
    })),
  };
}
