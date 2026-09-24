/**
 * Real-browser checks for the two platform behaviours the tab shell leans on.
 *
 * The redesign hides inactive surfaces with `visibility` and `inert` rather
 * than unmounting them, and keeps the view selector on a single overflowing
 * row. Both are geometry and hit-testing claims, so jsdom cannot evaluate
 * either: it reports zero-sized rects, and it implements neither `inert`'s
 * effect on focus and pointer targeting nor `elementFromPoint`.
 *
 * The tab-strip test exercises the real component. The `inert` test is
 * deliberately a platform measurement — `inert` is comparatively recent in
 * WebKit, and the whole "retain the layout box instead of unmounting" decision
 * is void if an invisible panel still answers clicks — so it wraps real
 * focusable app content rather than asserting anything about route markup.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { cleanup, render } from '@testing-library/react';
import { page } from 'vitest/browser';
import { WorkspaceControls } from './workspace-controls';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { SurfaceActivityContext } from '@/lib/surface-activity';
import { useTerminalStore } from '@/stores/terminal-store';
import type { WorkspaceContext, WorkspaceTab } from '@/stores/workspace-store';
import '@/index.css';
import '@/i18n';

vi.mock('@/socket', () => ({
  getSocket: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }),
}));

function workspace(count: number, activeId = 'conversation'): WorkspaceContext {
  const tabs: WorkspaceTab[] = Array.from({ length: count }, (_, index) => ({
    id: `file:/repo/src/some/deeply/nested/module-${index}.ts`,
    kind: 'file',
    path: `/repo/src/some/deeply/nested/module-${index}.ts`,
    documentId: `document:${index}`,
  }));
  return { tabs, activeId };
}

export function Controls({
  count,
  activeId,
  width = 900,
}: {
  count: number;
  activeId?: string;
  width?: number;
}) {
  return (
    <div style={{ width }}>
      <WorkspaceControls
        workspace={workspace(count, activeId)}
        running={false}
        pending={0}
        onSelect={() => undefined}
        onClose={() => undefined}
        onExplorer={() => undefined}
        onNewTerminal={() => undefined}
      />
    </div>
  );
}

const strip = () => document.querySelector<HTMLElement>('[role="tablist"]')!;

beforeEach(async () => {
  await page.viewport(1280, 900);
  useTerminalStore.setState({ terminals: {}, contexts: {} });
});

afterEach(cleanup);

test('keeps the view selector on one row however many tabs are open', async () => {
  const view = render(<Controls count={1} />);
  const single = strip().getBoundingClientRect().height;
  expect(single).toBeGreaterThan(0);

  // Long file names, more tabs than fit, and a narrow column: the strip must
  // absorb all of it horizontally. Wrapping to a second row would shorten the
  // transcript underneath, which is the displacement this redesign removes.
  view.rerender(<Controls count={14} width={520} />);
  const crowded = strip();
  expect(crowded.getBoundingClientRect().height).toBeCloseTo(single, 0);
  const scroller = crowded.querySelector<HTMLElement>('.overflow-x-auto')!;
  expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
});

test('gives the tablist exactly one tab stop', async () => {
  render(
    <Controls
      count={3}
      activeId="file:/repo/src/some/deeply/nested/module-1.ts"
    />,
  );
  const stops = [
    ...strip().querySelectorAll<HTMLElement>('[role="tab"]'),
  ].filter((tab) => tab.tabIndex === 0);
  // Roving tabindex: arrow keys move within the tablist, Tab moves past it.
  // The pinned Conversation tab defaulting to 0 made it a second stop.
  expect(stops).toHaveLength(1);
  expect(stops[0].getAttribute('aria-selected')).toBe('true');
});

test('an inert hidden panel answers neither pointers nor focus', async () => {
  render(
    <div style={{ position: 'relative', width: 900, height: 120 }}>
      <div
        data-under
        style={{ position: 'absolute', inset: 0, background: 'black' }}
      />
      <div
        data-panel
        inert
        style={{ position: 'absolute', inset: 0, visibility: 'hidden' }}
      >
        <Controls count={2} />
      </div>
    </div>,
  );
  const panel = document.querySelector<HTMLElement>('[data-panel]')!;
  // The layout box survives — that is the entire reason for preferring
  // `visibility` over `display: none`, since a zero-sized box makes the
  // virtualizer and every ResizeObserver read zeros.
  expect(panel.getBoundingClientRect().height).toBeCloseTo(120, 0);

  const button = panel.querySelector<HTMLElement>('button')!;
  const box = button.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  const hit = document.elementFromPoint(
    box.left + box.width / 2,
    box.top + box.height / 2,
  );
  expect(panel.contains(hit)).toBe(false);

  button.focus();
  expect(document.activeElement).not.toBe(button);

  // visibility:hidden already prevents focus/hits without inert. Test inert
  // independently, then remove it as a positive control for this same button.
  panel.style.visibility = 'visible';
  button.focus();
  expect(document.activeElement).not.toBe(button);
  expect(
    panel.contains(
      document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      ),
    ),
  ).toBe(false);
  panel.inert = false;
  button.focus();
  expect(document.activeElement).toBe(button);
  expect(
    panel.contains(
      document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      ),
    ),
  ).toBe(true);
});

test('a portalled dialog leaves the document when its surface deactivates', async () => {
  const Host = ({ active }: { active: boolean }) => (
    <SurfaceActivityContext value={active}>
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>kept open by a hidden tab</DialogTitle>
        </DialogContent>
      </Dialog>
    </SurfaceActivityContext>
  );
  const title = () =>
    [...document.querySelectorAll('*')].find(
      (node) => node.textContent === 'kept open by a hidden tab',
    );
  const view = render(<Host active />);
  expect(title()).toBeTruthy();
  // Activation is flipped directly rather than through a click: an open modal
  // legitimately blocks every pointer outside it. That is also the reason this
  // test exists — a Radix portal escapes the panel's subtree, so neither
  // `visibility` nor `inert` on a hidden tab reaches it, and a dialog left
  // behind would hold the whole page's pointer input and focus hostage.
  // Withdrawal therefore has to remove the node, not merely hide it.
  view.rerender(<Host active={false} />);
  await expect.poll(() => title()).toBeUndefined();
});
