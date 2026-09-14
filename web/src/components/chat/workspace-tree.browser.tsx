/** Real divider geometry with synthetic directory data; no user files are read. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { commands, page } from 'vitest/browser';
import { WorkspaceTree } from './workspace-tree';
import { useLayoutStore } from '@/stores/layout-store';
import '@/index.css';
import '@/i18n';

vi.mock('@/generated/api', () => ({ filesAddRoot: async () => ({}) }));
vi.mock('@/components/files/file-tree', () => ({
  FileTree: () => <div>fixture.ts</div>,
}));

declare module 'vitest/browser' {
  interface BrowserCommands {
    explorerDivider: (
      action: 'start' | 'move' | 'end' | 'cancel',
      delta?: number,
    ) => Promise<void>;
  }
}

export function Fixture({ width = 800 }: { width?: number }) {
  return (
    <div style={{ display: 'flex', width, height: 500 }}>
      <div data-content style={{ flex: 1, minWidth: 0 }} />
      <WorkspaceTree
        cwd="/fixture"
        desktop
        mobileOpen={false}
        onMobileClose={() => undefined}
        onFile={() => undefined}
      />
    </div>
  );
}

const rail = () => document.querySelector('aside')!;
const contentWidth = () =>
  document.querySelector('[data-content]')!.getBoundingClientRect().width;
const preview = () => rail().querySelector<HTMLElement>('.pointer-events-none');

beforeEach(async () => {
  await page.viewport(1280, 900);
  useLayoutStore.setState({
    workspaceTreeCollapsed: false,
    workspaceTreeWidth: 260,
  });
});
afterEach(cleanup);

test('previews without reflow and commits the same constrained width on release', async () => {
  render(<Fixture />);
  const before = contentWidth();
  const limit = 800 * 0.45;
  await commands.explorerDivider('start');
  try {
    await commands.explorerDivider('move', -450);
    await expect.poll(() => preview()?.style.right).toBe(`${limit}px`);
    expect(contentWidth()).toBe(before);
    expect(useLayoutStore.getState().workspaceTreeWidth).toBe(260);
  } finally {
    await commands.explorerDivider('end');
  }
  await expect
    .poll(() => rail().getBoundingClientRect().width)
    .toBeCloseTo(limit, 0);
  expect(useLayoutStore.getState().workspaceTreeWidth).toBe(limit);
  expect(preview()).toBeNull();
});

test('Escape cancels a preview and an unmoved click preserves the preferred width', async () => {
  useLayoutStore.setState({ workspaceTreeWidth: 600 });
  render(<Fixture />);
  expect(rail().getBoundingClientRect().width).toBeCloseTo(360, 0);
  await commands.explorerDivider('start');
  await commands.explorerDivider('end');
  expect(useLayoutStore.getState().workspaceTreeWidth).toBe(600);
  await commands.explorerDivider('start');
  try {
    await commands.explorerDivider('move', 90);
    await expect.poll(() => preview()).not.toBeNull();
  } finally {
    await commands.explorerDivider('cancel');
  }
  expect(useLayoutStore.getState().workspaceTreeWidth).toBe(600);
  expect(preview()).toBeNull();
  expect(rail().getBoundingClientRect().width).toBeCloseTo(360, 0);
});
