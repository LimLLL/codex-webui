/**
 * Regression tests for the four outcomes a cascade delete can settle into.
 *
 * The mutation's job after the request is to reconcile local state with what the
 * server *actually* removed, which differs per status: `completed` removes the
 * plan, `conflict` removes nothing, and `partial` removes some — with a further
 * split on whether a post-delete tree came back, which decides how wide the cache
 * invalidation has to be.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadDeleteResultDto } from '@/generated/api/types.gen';

const navigate = vi.fn();
const showSnackbar = vi.fn();
const invalidateBranchTreeMembersSoon = vi.fn();
const invalidateBranchTreesSoon = vi.fn();
const invalidateThreadListSoon = vi.fn();
const emit = vi.fn();

let deleteResult: ThreadDeleteResultDto;

vi.mock('../socket', () => ({
  getSocket: () => ({ emit, on: vi.fn(), off: vi.fn() }),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/stores/snackbar-store', () => ({ showSnackbar }));

vi.mock('@/lib/api-error', () => ({ getApiErrorMessage: () => 'boom' }));

vi.mock('@/lib/query-invalidation', () => ({
  invalidateBranchTreeMembersSoon,
  invalidateBranchTreesSoon,
  invalidateThreadListSoon,
}));

vi.mock('@/generated/api/@tanstack/react-query.gen', () => ({
  threadsDeletionDeleteThreadMutation: () => ({
    mutationFn: () => Promise.resolve(deleteResult),
  }),
  threadsDeletionPreviewDeleteOptions: () => ({ queryKey: ['preview'] }),
  threadsDeletionReadBranchAdoptionStatusOptions: () => ({
    queryKey: ['adoption'],
  }),
  threadsReadBranchTreeQueryKey: ({ path }: { path: { threadId: string } }) => [
    'branch-tree',
    path.threadId,
  ],
}));

const { useDeleteThread } = await import('./use-thread-deletion');
const { useTimelineStore } = await import('@/stores/timeline-store');

const pristine = useTimelineStore.getState();

/** Minimal result; every test overrides the fields its status cares about. */
function makeResult(
  overrides: Partial<ThreadDeleteResultDto>,
): ThreadDeleteResultDto {
  return {
    targetThreadId: 'doomed',
    status: 'completed',
    destructiveStarted: true,
    expectedThreadIds: ['doomed'],
    plannedThreadIds: ['doomed'],
    deleteOrder: ['doomed'],
    interruptedThreadIds: [],
    cancelledApprovalRequestIds: [],
    deletedThreadIds: ['doomed'],
    reapedThreadIds: [],
    remainingThreadIds: [],
    diagnostics: [],
    ...overrides,
  } as ThreadDeleteResultDto;
}

function makeTree(rootId: string, memberIds: string[]) {
  return {
    treeRootThreadId: rootId,
    members: memberIds.map((threadId) => ({ threadId })),
  };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/** Drives the mutation to settlement and returns the query client used. */
async function runDelete(options?: Parameters<typeof useDeleteThread>[0]) {
  const { result } = renderHook(() => useDeleteThread(options), { wrapper });
  await act(async () => {
    result.current.mutate({
      path: { threadId: 'doomed' },
      body: {},
    } as never);
  });
  await waitFor(() => expect(result.current.isPending).toBe(false));
}

beforeEach(() => {
  vi.clearAllMocks();
  useTimelineStore.setState(pristine, true);
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
});

describe('useDeleteThread', () => {
  it('completed: leaves the destroyed thread for the chosen survivor', async () => {
    deleteResult = makeResult({
      status: 'completed',
      deletedThreadIds: ['doomed'],
      updatedTree: makeTree('root', ['survivor']) as never,
    });
    useTimelineStore.getState().setActiveThread('doomed');

    await runDelete({ resolveSurvivor: () => 'survivor' });

    expect(navigate).toHaveBeenCalledWith({
      to: '/t/$threadId',
      params: { threadId: 'survivor' },
    });
    // Local caches for the destroyed thread must not survive it.
    expect(useTimelineStore.getState().threadsById['doomed']).toBeUndefined();
    expect(showSnackbar).toHaveBeenCalledWith(
      expect.stringContaining('Deleted'),
      'success',
    );
  });

  it('completed: falls back to the empty state when nothing in the group survives', async () => {
    deleteResult = makeResult({ status: 'completed' });
    useTimelineStore.getState().setActiveThread('doomed');

    await runDelete({ resolveSurvivor: () => null });

    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });

  it("completed: writes the server's post-delete tree into surviving members' caches", async () => {
    const tree = makeTree('root', ['survivor', 'doomed']);
    deleteResult = makeResult({ status: 'completed', updatedTree: tree as never });

    await runDelete();

    expect(queryClient.getQueryData(['branch-tree', 'survivor'])).toBe(tree);
    expect(queryClient.getQueryData(['branch-tree', 'root'])).toBe(tree);
    // The removed member must not be handed a tree it is no longer part of.
    expect(queryClient.getQueryData(['branch-tree', 'doomed'])).toBeUndefined();
  });

  it('conflict: removes nothing, so the user is not moved', async () => {
    deleteResult = makeResult({
      status: 'conflict',
      destructiveStarted: false,
      deletedThreadIds: [],
      remainingThreadIds: ['doomed'],
      failure: { message: 'plan changed' } as never,
    });
    useTimelineStore.getState().setActiveThread('doomed');

    await runDelete({ resolveSurvivor: () => 'survivor' });

    expect(navigate).not.toHaveBeenCalled();
    expect(useTimelineStore.getState().threadId).toBe('doomed');
    expect(showSnackbar).toHaveBeenCalledWith(
      expect.stringContaining('Nothing was deleted'),
      'warning',
    );
  });

  it('partial with a tree: refreshes only what was removed', async () => {
    deleteResult = makeResult({
      status: 'partial',
      deletedThreadIds: ['doomed'],
      plannedThreadIds: ['doomed', 'child'],
      remainingThreadIds: ['child'],
      updatedTree: makeTree('root', ['child']) as never,
      failure: { message: 'stopped' } as never,
    });

    await runDelete();

    expect(invalidateBranchTreeMembersSoon).toHaveBeenCalledWith(
      expect.anything(),
      ['doomed'],
    );
    expect(showSnackbar).toHaveBeenCalledWith(
      expect.stringContaining('Deletion stopped partway'),
      'error',
    );
  });

  it('partial without a tree: refreshes everything the plan touched', async () => {
    // No tree means either the root is gone or the server aborted before it
    // could report one; survivors may still be holding a pre-delete topology.
    deleteResult = makeResult({
      status: 'partial',
      deletedThreadIds: ['doomed'],
      plannedThreadIds: ['doomed', 'child'],
      remainingThreadIds: ['child'],
      updatedTree: null,
      failure: { message: 'stopped' } as never,
    });

    await runDelete();

    // Asserted as a set: the real invalidator dedupes, so pinning the duplicate
    // ids this call happens to produce would fix an implementation detail.
    const [, threadIds] = vi
      .mocked(invalidateBranchTreeMembersSoon)
      .mock.calls.at(-1)!;
    expect(new Set(threadIds as string[])).toEqual(
      new Set(['doomed', 'child']),
    );
  });

  it('settles the sidebar and tree caches on every outcome', async () => {
    deleteResult = makeResult({ status: 'completed' });

    await runDelete();

    expect(invalidateThreadListSoon).toHaveBeenCalled();
    expect(invalidateBranchTreesSoon).toHaveBeenCalled();
  });
});
