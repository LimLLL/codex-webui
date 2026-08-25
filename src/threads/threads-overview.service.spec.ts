import type { v2 } from '../codex/codex-schema';
import { CodexService } from '../codex/codex.service';
import { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadsOverviewService } from './threads-overview.service';

describe('ThreadsOverviewService', () => {
  const mockCodex = { request: vi.fn() };
  const mockBranchMutations = { listEdges: vi.fn() };
  const mockBranches = { listActiveMembers: vi.fn() };
  const mockPendingApprovals = { listPending: vi.fn() };
  let service: ThreadsOverviewService;

  beforeEach(() => {
    service = new ThreadsOverviewService(
      mockCodex as unknown as CodexService,
      mockBranchMutations as unknown as ConversationBranchMutationsService,
      mockBranches as unknown as ConversationBranchesService,
      mockPendingApprovals as unknown as PendingApprovalsService,
    );
    mockCodex.request.mockReset();
    mockBranchMutations.listEdges.mockReset();
    mockBranches.listActiveMembers.mockReset();
    mockPendingApprovals.listPending.mockReset();
    mockBranchMutations.listEdges.mockReturnValue([
      {
        childThreadId: 'child',
        parentThreadId: 'root',
        treeRootThreadId: 'root',
        source: 'local',
      },
    ]);
    mockBranches.listActiveMembers.mockReturnValue(
      new Map([
        ['root', { treeRootThreadId: 'root', activeThreadId: 'child' }],
      ]),
    );
    mockPendingApprovals.listPending.mockReturnValue([]);
  });

  it('folds branch members into one row and sorts by lifted activity', async () => {
    mockCodex.request.mockImplementation((_method: string, params) =>
      Promise.resolve(
        listResponse(
          (params as { archived: boolean }).archived
            ? []
            : [makeThread('root', 10), makeThread('child', 20, 'root')],
        ),
      ),
    );

    const result = await service.listOverview({ archived: false, limit: 20 });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      treeRootThreadId: 'root',
      openThreadId: 'child',
      memberThreadIds: ['root', 'child'],
      hiddenThreadIds: ['child'],
      latestActivityAt: 20,
      hasBranchDescendants: true,
    });
    expect(result.data[0].thread.id).toBe('root');
    expect(result.data[0].thread.updatedAt).toBe(20);
  });

  it('enumerates each archived state once when no filter is applied', async () => {
    // A full enumeration costs one round trip per 200 stored threads and this
    // projection runs on every sidebar refresh, so re-listing the state the
    // caller already holds doubles the cost of the whole sidebar. Measured at
    // ~900 ms for 154 stored conversations before this was fixed.
    const archivedFlags: boolean[] = [];
    mockCodex.request.mockImplementation((_method: string, params) => {
      const archived = (params as { archived: boolean }).archived;
      archivedFlags.push(archived);
      return Promise.resolve(
        listResponse(archived ? [] : [makeThread('root', 10)]),
      );
    });

    await service.listOverview({ archived: false, limit: 20 });

    expect(archivedFlags.filter((archived) => !archived)).toHaveLength(1);
    expect(archivedFlags.filter((archived) => archived)).toHaveLength(1);
  });

  it('re-enumerates the filtered state rather than reusing a subset', async () => {
    // A `cwd`/`searchTerm` page is a subset, so standing it in for the whole
    // archived state would drop the parent links of everything filtered out and
    // un-collapse branches whose ancestor lies outside the filter.
    const calls: Array<{ archived: boolean; cwd?: string }> = [];
    mockCodex.request.mockImplementation((_method: string, params) => {
      const typed = params as { archived: boolean; cwd?: string };
      calls.push({ archived: typed.archived, cwd: typed.cwd });
      return Promise.resolve(
        listResponse(typed.archived ? [] : [makeThread('root', 10)]),
      );
    });

    await service.listOverview({ archived: false, limit: 20, cwd: '/work' });

    // One filtered read for the page, plus an unfiltered read of each state for
    // topology.
    expect(calls.filter((call) => call.cwd === '/work')).toHaveLength(1);
    expect(
      calls.filter((call) => call.cwd === undefined && !call.archived),
    ).toHaveLength(1);
  });

  it('keeps a branch reachable when the filtered view excludes its root', async () => {
    let call = 0;
    mockCodex.request.mockImplementation((_method: string, params) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(listResponse([makeThread('child', 20, 'root')]));
      }
      return Promise.resolve(
        listResponse(
          (params as { archived: boolean }).archived
            ? []
            : [makeThread('root', 10), makeThread('child', 20, 'root')],
        ),
      );
    });

    const result = await service.listOverview({
      archived: false,
      cwd: '/branch-only',
      limit: 20,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      treeRootThreadId: 'root',
      openThreadId: 'child',
      memberThreadIds: ['child'],
      hiddenThreadIds: [],
      latestActivityAt: 20,
    });
    expect(result.data[0].thread.id).toBe('child');
  });
});

function listResponse(data: v2.Thread[]): v2.ThreadListResponse {
  return { data, nextCursor: null, backwardsCursor: null };
}

function makeThread(
  id: string,
  updatedAt: number,
  forkedFromId: string | null = null,
): v2.Thread {
  return {
    id,
    sessionId: id,
    forkedFromId,
    parentThreadId: null,
    preview: id,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt,
    recencyAt: updatedAt,
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
  };
}
