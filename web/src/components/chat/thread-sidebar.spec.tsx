/** Real query/store orchestration: archive completion must survive changes to the displayed rows. */
import {
  Children,
  isValidElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadSidebar } from './thread-sidebar';
import { WorkspaceDetail } from './sidebar/workspace-detail';
import { WorkspaceOverview } from './sidebar/workspace-overview';
import { ConfirmDialog } from './sidebar/sidebar-dialogs';
import type { ThreadRow } from './sidebar/thread-row';
import type { ThreadOverviewRowDto } from '@/generated/api/types.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import { useLayoutStore } from '@/stores/layout-store';

const transport = vi.hoisted(() => ({
  archive: vi.fn(),
  overview: vi.fn(),
  navigate: vi.fn(),
  emit: vi.fn(),
}));
vi.mock('@/socket', () => ({ getSocket: () => ({ emit: transport.emit, timeout: () => ({ emit: transport.emit }), connected: true }) }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => transport.navigate,
  useRouterState: () => '/t/branch',
}));
vi.mock('@/generated/api/sdk.gen', async (original) => ({
  ...(await original<typeof import('@/generated/api/sdk.gen')>()),
  threadsArchiveThread: transport.archive,
  threadsListOverview: transport.overview,
}));
vi.mock('@/hooks/use-thread-deletion', () => ({
  useBranchAdoptionStatus: () => ({}),
  adoptionBlockReason: () => null,
  useDeletePreview: () => ({}),
  useDeleteThread: () => ({}),
  buildDeleteRequestBody: vi.fn(),
}));

const initialTimeline = useTimelineStore.getState();
const initialLayout = useLayoutStore.getState();

/** Inspect the component's hook wiring without mounting unrelated graph/editor/dialog children. */
function findElement<P>(
  node: ReactNode,
  type: ComponentType<P>,
): ReactElement<P> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === type) return child as ReactElement<P>;
    const found = findElement(child.props.children, type);
    if (found) return found;
  }
}

function row(id: string, members = [id]): ThreadOverviewRowDto {
  return {
    thread: {
      id,
      forkedFromId: null,
      preview: id,
      ephemeral: false,
      modelProvider: 'test',
      model: null,
      reasoningEffort: null,
      createdAt: 1,
      updatedAt: 1,
      status: { type: 'idle' },
      path: null,
      cwd: '/workspace',
      cliVersion: '0.153.2',
      source: 'appServer',
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: id,
      turns: [],
    },
    treeRootThreadId: id,
    openThreadId: members.at(-1)!,
    memberThreadIds: members,
    hiddenThreadIds: members.slice(1),
    hasBranchDescendants: members.length > 1,
    latestActivityAt: 1,
    running: false,
    waitingOnApproval: false,
    waitingOnUserInput: false,
    pendingApprovalCount: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useTimelineStore.setState(initialTimeline, true);
  useLayoutStore.setState(initialLayout, true);
  useLayoutStore
    .getState()
    .setSidebarView({ type: 'workspaceDetail', cwd: '/workspace' });
  useTimelineStore.getState().ensureThreadState({ threadId: 'branch' });
  useTimelineStore.getState().selectThread('branch');
  useTimelineStore.setState({
    subscribedThreadIds: new Set(['root', 'branch']),
  });
});

it.each(['navigation', 'refetch', 'confirmation refetch'] as const)(
  'retains archive membership after %s removes the initiating row',
  async (cause) => {
    const root = row('root', ['root', 'branch']);
    const neighbour = row('neighbour');
    let detailRows = [root, neighbour];
    transport.overview.mockImplementation(
      (options: { query: { cwd?: string; archived?: boolean } }) =>
        Promise.resolve({
          data: {
            data: options.query.cwd
              ? detailRows
              : options.query.archived
                ? []
                : [neighbour],
            nextCursor: null,
          },
        }),
    );
    let finish!: (response: { data: object }) => void;
    transport.archive.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { result, unmount } = renderHook(() => ThreadSidebar(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    try {
      await waitFor(() =>
        expect(
          findElement(result.current, WorkspaceDetail)?.props.threads,
        ).toHaveLength(2),
      );
      const rendered = findElement(
        result.current,
        WorkspaceDetail,
      )!.props.renderThreadRow(root.thread, false);
      expect(isValidElement(rendered)).toBe(true);
      act(() =>
        (
          rendered as ReactElement<React.ComponentProps<typeof ThreadRow>>
        ).props.onArchive(),
      );
      if (cause === 'confirmation refetch') {
        detailRows = [neighbour];
        await act(async () => {
          await client.invalidateQueries();
        });
        await waitFor(() =>
          expect(
            findElement(result.current, WorkspaceDetail)?.props.threads,
          ).toHaveLength(1),
        );
      }
      act(() => findElement(result.current, ConfirmDialog)!.props.onConfirm());
      await waitFor(() => expect(transport.archive).toHaveBeenCalledOnce());
      if (cause === 'navigation') {
        act(() =>
          useLayoutStore.getState().setSidebarView({ type: 'overview' }),
        );
        await waitFor(() =>
          expect(
            findElement(result.current, WorkspaceOverview)?.props
              .workspaceGroups[0]?.threads,
          ).toHaveLength(1),
        );
      } else if (cause === 'refetch') {
        detailRows = [neighbour];
        await act(async () => {
          await client.invalidateQueries();
        });
        await waitFor(() =>
          expect(
            findElement(result.current, WorkspaceDetail)?.props.threads,
          ).toHaveLength(1),
        );
      }
      await act(async () => {
        finish({ data: {} });
      });
      await waitFor(() =>
        expect(transport.emit).toHaveBeenCalledWith('thread.unsubscribe', {
          threadId: 'branch',
        }),
      );
      expect(transport.navigate).toHaveBeenCalledWith({
        to: '/t/$threadId',
        params: { threadId: 'neighbour' },
      });
    } finally {
      unmount();
      client.clear();
    }
  },
);

it('ignores stale active lifecycle cached for an unsubscribed branch member', async () => {
  const root = row('root', ['root', 'branch']);
  transport.overview.mockResolvedValue({ data: { data: [root], nextCursor: null } });
  useTimelineStore.getState().setLoadingForThread('branch', true);
  useTimelineStore.getState().setThreadStatusForThread('branch', { type: 'active', activeFlags: ['waitingOnApproval'] });
  useTimelineStore.setState({ subscribedThreadIds: new Set() });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, unmount } = renderHook(() => ThreadSidebar(), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(findElement(result.current, WorkspaceDetail)?.props.threads).toHaveLength(1));
  const rendered = findElement(result.current, WorkspaceDetail)!.props.renderThreadRow(root.thread, false) as ReactElement<React.ComponentProps<typeof ThreadRow>>;
  expect(rendered.props.running).toBe(false);
  expect(rendered.props.pendingApproval).toBe(false);
  expect(rendered.props.destructiveDisabled).toBe(false);
  unmount();
  client.clear();
});
