/** Nested expansion identity; portal focus and row geometry live in browser tests. */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DirectorySelectionTree } from './directory-selection-tree';

const api = vi.hoisted(() => ({ roots: vi.fn(), read: vi.fn() }));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    connected: false,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  }),
}));
vi.mock('@/generated/api/sdk.gen', async (original) => ({
  ...(await original<typeof import('@/generated/api/sdk.gen')>()),
  filesGetRoots: api.roots,
  filesReadTree: api.read,
}));

/** Two real levels below the root, so a child row can be told apart from its parent. */
const TREE: Record<string, Array<{ path: string; name: string }>> = {
  '/work': [{ path: '/work/alpha', name: 'alpha' }],
  '/work/alpha': [{ path: '/work/alpha/beta', name: 'beta' }],
  '/work/alpha/beta': [],
};

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  api.roots.mockReset();
  api.read.mockReset();
  api.roots.mockResolvedValue({ data: { roots: ['/work'], homeDir: '/work' } });
  api.read.mockImplementation(({ query }: { query: { root: string } }) =>
    Promise.resolve({
      data: (TREE[query.root] ?? []).map((entry) => ({
        ...entry,
        type: 'directory' as const,
      })),
    }),
  );
});

/** Drives selection the way both dialog wrappers do, so selection stays caller-owned. */
function Host() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DirectorySelectionTree
        selectedPath={selected}
        onSelectedPathChange={setSelected}
        showSelectedPath
      />
    </QueryClientProvider>
  );
}

/**
 * A child row must render its own entry rather than inheriting the row that
 * rendered it. When identity leaked through the forwarded prop bag, every child
 * re-read its parent's path, stayed expanded because the parent was expanded,
 * and recursed until the renderer died — which no type check could see, because
 * JSX spread performs no excess-property check, and which every listing-empty
 * test missed because the recursion needs at least one subdirectory to exist.
 */
it('renders descendants under their own identity instead of re-expanding the parent', async () => {
  render(<Host />);

  const root = await screen.findByText('work');
  fireEvent.doubleClick(root);

  const child = await screen.findByText('alpha');
  expect(screen.getAllByText('alpha')).toHaveLength(1);

  fireEvent.doubleClick(child);

  const grandchild = await screen.findByText('beta');
  expect(screen.getAllByText('beta')).toHaveLength(1);
  expect(screen.getAllByText('alpha')).toHaveLength(1);

  // Expanding the third level proves each row listed its own path: a leaked
  // identity would have re-read '/work/alpha' here instead.
  fireEvent.doubleClick(grandchild);
  await waitFor(() =>
    expect(
      api.read.mock.calls.some(
        (call) =>
          (call[0] as { query: { root: string } }).query.root ===
          '/work/alpha/beta',
      ),
    ).toBe(true),
  );

  fireEvent.click(grandchild);
  expect(await screen.findByText('/work/alpha/beta')).toBeInTheDocument();
});
