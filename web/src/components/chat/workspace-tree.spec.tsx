/**
 * Explorer adoption waits for its conversation, then allows free navigation.
 *
 * A gate comparing the tree's current root against the conversation's working
 * directory reads like the safer check and is the opposite: browsing is what
 * moves the root. Entering a folder pushes it below the working directory and
 * "go up" pushes it above, so the first double-click replaced the tree — and
 * its toolbar, leaving no way back — with a spinner nothing could clear.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { WorkspaceTree } from './workspace-tree';
import { useFilesStore } from '@/stores/files-store';
import { useLayoutStore } from '@/stores/layout-store';

const addRoot = vi.hoisted(() => vi.fn());
vi.mock('@/generated/api', () => ({ filesAddRoot: addRoot }));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: () => (
    <div data-testid="file-tree">{useFilesStore((s) => s.rootDir)}</div>
  ),
}));

function renderTree(cwd: string | null = '/w') {
  return render(
    <WorkspaceTree
      cwd={cwd}
      desktop
      mobileOpen={false}
      onMobileClose={() => undefined}
      onFile={() => undefined}
    />,
  );
}

beforeEach(() => {
  addRoot.mockReset().mockResolvedValue({});
  useFilesStore.setState({
    rootDir: null,
    expandedDirs: new Set(),
    selectedFile: null,
  });
  useLayoutStore.setState({
    workspaceTreeCollapsed: false,
    workspaceTreeWidth: 260,
  });
});

describe('explorer readiness gate', () => {
  it('waits while no root has been established', () => {
    useFilesStore.setState({ rootDir: null });
    renderTree(null);
    expect(screen.queryByTestId('file-tree')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it.each([
    ['the conversation working directory', '/w'],
    ['a directory entered from it', '/w/pkg/src'],
    ['a directory above it', '/'],
  ])('shows the tree when the root is %s', async (_label, rootDir) => {
    renderTree();
    await screen.findByTestId('file-tree');
    act(() => useFilesStore.getState().setRootDir(rootDir));
    expect(screen.getByTestId('file-tree')).toHaveTextContent(rootDir);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('withholds an old root during cold metadata and registration without clearing its cache', async () => {
    const expandedDirs = new Set(['/old/pkg']);
    useFilesStore.setState({ rootDir: '/old', expandedDirs });
    let finish!: () => void;
    addRoot.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const view = renderTree(null);
    expect(screen.queryByTestId('file-tree')).toBeNull();
    view.rerender(
      <WorkspaceTree
        cwd="/new"
        desktop
        mobileOpen={false}
        onMobileClose={() => undefined}
        onFile={() => undefined}
      />,
    );
    expect(screen.queryByTestId('file-tree')).toBeNull();
    expect(useFilesStore.getState().expandedDirs).toBe(expandedDirs);
    await act(async () => finish());
    expect(screen.getByTestId('file-tree')).toHaveTextContent('/new');
  });

  it('preserves expansion and selection when the next conversation adopts the same cwd', async () => {
    const first = renderTree();
    await screen.findByTestId('file-tree');
    act(() => {
      useFilesStore.getState().toggleDirectory('/w/pkg');
      useFilesStore.getState().selectFile('/w/file.ts');
    });
    first.unmount();
    renderTree();
    await screen.findByTestId('file-tree');
    expect(useFilesStore.getState().expandedDirs.has('/w/pkg')).toBe(true);
    expect(useFilesStore.getState().selectedFile).toBe('/w/file.ts');
  });

  it('shows a rejected directory and ignores a superseded registration', async () => {
    let finishOld!: () => void;
    addRoot.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishOld = resolve;
      }),
    );
    const view = renderTree('/old');
    addRoot.mockRejectedValueOnce(new Error('directory unavailable'));
    view.rerender(
      <WorkspaceTree
        cwd="/rejected"
        desktop
        mobileOpen={false}
        onMobileClose={() => undefined}
        onFile={() => undefined}
      />,
    );
    await screen.findByTestId('file-tree');
    await act(async () => finishOld());
    expect(screen.getByTestId('file-tree')).toHaveTextContent('/rejected');
  });
});
