/** Navigation/read failures and editor transactions; pointer geometry lives in browser tests. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { FileTree } from './file-tree';
import { useFilesStore } from '@/stores/files-store';

const api = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn() }));
vi.mock('@/socket', () => ({
  getSocket: () => ({
    connected: false,
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  }),
}));
vi.mock('@dnd-kit/dom', () => ({ Feedback: { configure: () => ({}) } }));
vi.mock('@dnd-kit/react', () => ({
  DragDropProvider: ({ children }: { children: React.ReactNode }) => children,
  useDraggable: () => ({ ref: () => undefined, isDragging: false }),
  useDroppable: () => ({ ref: () => undefined, isDropTarget: false }),
}));
vi.mock('@/generated/api/sdk.gen', async (original) => ({
  ...(await original<typeof import('@/generated/api/sdk.gen')>()),
  filesReadTree: api.read,
  filesCreateDirectory: api.create,
}));

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  api.read.mockReset();
  api.create.mockReset();
  useFilesStore.setState({
    rootDir: '/work',
    selectedFile: '/work/selected.ts',
  });
  api.read.mockImplementation(({ query }: { query: { root: string } }) =>
    query.root === '/work'
      ? Promise.resolve({
          data: [{ path: '/work/a', name: 'a', type: 'directory' }],
        })
      : Promise.reject(new Error('Listing denied')),
  );
});

it('rolls back directory and selection when row-menu navigation cannot list its destination', async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <FileTree />
    </QueryClientProvider>,
  );
  fireEvent.contextMenu(await screen.findByText('a'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New Folder' }));
  await waitFor(() =>
    expect(api.read).toHaveBeenCalledWith(
      expect.objectContaining({ query: { root: '/work/a' } }),
    ),
  );
  await waitFor(() =>
    expect(useFilesStore.getState()).toMatchObject({
      rootDir: '/work',
      selectedFile: '/work/selected.ts',
    }),
  );
  expect(
    screen.queryByRole('textbox', { name: 'File or directory name' }),
  ).not.toBeInTheDocument();
  expect(api.create).not.toHaveBeenCalled();
});

it('creates from the empty listing background without changing the current directory', async () => {
  api.read.mockResolvedValue({ data: [] });
  api.create.mockResolvedValue({ data: { path: '/work/project', ok: true } });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <FileTree />
    </QueryClientProvider>,
  );
  fireEvent.contextMenu(await screen.findByText('Empty directory'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New Folder' }));
  const input = await screen.findByRole('textbox', {
    name: 'File or directory name',
  });
  fireEvent.change(input, { target: { value: 'project' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: { path: '/work/project' } }),
    ),
  );
  expect(useFilesStore.getState().rootDir).toBe('/work');
});

/**
 * Creating does not depend on reading. When the listing itself failed, the
 * background action must still present its editor — rendering it only in the
 * success branch made the menu item silently do nothing.
 */
it('still offers the create row when the current listing cannot be read', async () => {
  api.read.mockRejectedValue(new Error('Listing denied'));
  api.create.mockResolvedValue({ data: { path: '/work/project', ok: true } });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <FileTree />
    </QueryClientProvider>,
  );
  fireEvent.contextMenu(await screen.findByText('Cannot load directories'));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New Folder' }));
  const input = await screen.findByRole('textbox', {
    name: 'File or directory name',
  });
  fireEvent.change(input, { target: { value: 'project' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: { path: '/work/project' } }),
    ),
  );
});
