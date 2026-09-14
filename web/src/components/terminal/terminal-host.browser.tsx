/**
 * Real-browser geometry for the terminal presentation overlay.
 *
 * Terminals are not rendered where they appear. They live in a fixed-position
 * layer at the layout root so an xterm instance and its PTY attachment survive
 * route changes and sibling-tab switches, and a route-owned placeholder only
 * publishes the rectangle they should occupy. Nothing about that arrangement is
 * observable in jsdom: `getBoundingClientRect` returns zeros, so "the overlay
 * is where the placeholder is" is vacuously true there, and `ResizeObserver`
 * is a stub, so the overlay would never be measured as following anything.
 *
 * What this file proves: the published rectangle is actually tracked, a hidden
 * retained terminal is neither visible nor hit-testable, and only a visibly
 * presented terminal reports dimensions to the shared PTY. What it does not
 * prove: that the conversation route publishes the right rectangle — that is
 * markup, and a fixture reproducing it would only be testing itself.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { page } from 'vitest/browser';
import type { TerminalAck, TerminalMetadata } from '@/types/terminal';
import { TerminalHost, TerminalSurface } from './terminal-host';
import { useTerminalViewStore } from '@/stores/terminal-view-store';
import { useTerminalStore } from '@/stores/terminal-store';
import '@/index.css';
import '@/i18n';

// Static imports on purpose: `vi.mock` is hoisted above them, while a
// top-level `await import()` here is pre-bundled separately and hands the
// component a second copy of React, whose hooks then dispatch against nothing.
const emit = vi.fn();
const socket = {
  on: vi.fn(),
  off: vi.fn(),
  emit,
  timeout: () => ({
    emit: (
      _event: string,
      _payload: unknown,
      ack: (error: Error | null, response?: TerminalAck<unknown>) => void,
    ) => ack(null, { ok: true, state: '', terminal: metadata('a') } as never),
  }),
};
vi.mock('@/socket', () => ({ getSocket: () => socket }));

function metadata(id: string): TerminalMetadata {
  return {
    id,
    contextKey: 'thread:t',
    title: `Terminal ${id}`,
    cwd: '/tmp',
    shell: '/bin/zsh',
    status: 'running',
    exitCode: null,
    signal: null,
    attachedCount: 1,
    cols: 80,
    rows: 24,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** One route-owned placeholder, sized and positioned like a workspace tab panel. */
export function Panel({
  terminalId,
  active = true,
  width = 600,
  height = 320,
  offset = 40,
}: {
  terminalId: string | null;
  active?: boolean;
  width?: number;
  height?: number;
  offset?: number;
}) {
  return (
    <>
      <div style={{ height: offset }} />
      <div data-placeholder style={{ width, height }}>
        {terminalId && (
          <TerminalSurface
            terminalId={terminalId}
            contextKey="thread:t"
            active={active}
          />
        )}
      </div>
      <TerminalHost />
    </>
  );
}

const placeholder = () =>
  document.querySelector<HTMLElement>('[data-placeholder]')!;
/** The overlay wrapper `TerminalHost` positions for a given retained terminal. */
const overlay = (terminalId: string) =>
  document
    .querySelector<HTMLElement>(`[data-terminal-overlay="${terminalId}"]`)
    ?.getBoundingClientRect();
const resizes = () =>
  emit.mock.calls.filter(([event]) => event === 'terminal.resize');

/** Lets the presentation effect, the ResizeObserver and xterm's fit settle. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 120));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

beforeEach(async () => {
  await page.viewport(1280, 900);
  emit.mockClear();
  useTerminalStore.setState({
    terminals: { a: metadata('a'), b: metadata('b') },
    contexts: {
      'thread:t': {
        terminalIds: ['a', 'b'],
        activeTerminalId: 'a',
        hydrated: true,
      },
    },
  });
  useTerminalViewStore.setState({ retained: {}, target: null });
});

afterEach(() => {
  cleanup();
  useTerminalViewStore.setState({ retained: {}, target: null });
});

test('positions the overlay on the placeholder and follows it when it resizes', async () => {
  const view = render(<Panel terminalId="a" />);
  await settle();
  const before = placeholder().getBoundingClientRect();
  const painted = overlay('a')!;
  expect(painted.width).toBeCloseTo(before.width, 0);
  expect(painted.height).toBeCloseTo(before.height, 0);
  expect(painted.left).toBeCloseTo(before.left, 0);
  expect(painted.top).toBeCloseTo(before.top, 0);

  // The explorer rail commits a new width, or the window changes: the panel
  // moves and shrinks without the terminal's own React tree being touched.
  view.rerender(<Panel terminalId="a" width={380} height={500} offset={90} />);
  await settle();
  const after = placeholder().getBoundingClientRect();
  const moved = overlay('a')!;
  expect(moved.width).toBeCloseTo(after.width, 0);
  expect(moved.height).toBeCloseTo(after.height, 0);
  expect(moved.top).toBeCloseTo(after.top, 0);
});

test('keeps an unpresented terminal mounted, invisible and out of hit testing', async () => {
  render(<Panel terminalId="a" />);
  useTerminalViewStore.getState().retain('b', 'thread:t');
  await settle();

  // Retained means still mounted and still attached, not still shown.
  const hidden = document.querySelector<HTMLElement>(
    '[data-terminal-overlay="b"]',
  )!;
  expect(hidden).toBeTruthy();
  expect(getComputedStyle(hidden).visibility).toBe('hidden');
  expect(hidden.hasAttribute('inert')).toBe(true);

  // Both overlays occupy the same published rectangle, so "invisible" has to
  // mean untouchable too — otherwise the hidden terminal would swallow every
  // click meant for the visible one.
  const centre = overlay('a')!;
  const hit = document.elementFromPoint(
    centre.left + centre.width / 2,
    centre.top + centre.height / 2,
  );
  expect(hidden.contains(hit)).toBe(false);
});

test('reports dimensions only for the visibly presented terminal', async () => {
  const view = render(<Panel terminalId="a" />);
  await settle();
  expect(resizes().length).toBeGreaterThan(0);
  expect(
    resizes().every(
      ([, payload]) => (payload as { terminalId: string }).terminalId === 'a',
    ),
  ).toBe(true);

  // Switching to a sibling tab withdraws presentation. A hidden pane must not
  // resize the shared PTY: the terminal is attached elsewhere too, and its
  // dimensions are the process's, not this view's.
  emit.mockClear();
  view.rerender(
    <Panel terminalId="a" active={false} width={200} height={120} />,
  );
  await settle();
  expect(resizes()).toHaveLength(0);
  expect(document.querySelector('[data-terminal-overlay="a"]')).toBeTruthy();
});

test('withdrawing every placeholder retains the instance without presenting it', async () => {
  const view = render(<Panel terminalId="a" />);
  await settle();
  view.rerender(<Panel terminalId={null} />);
  await settle();
  const retained = document.querySelector<HTMLElement>(
    '[data-terminal-overlay="a"]',
  )!;
  expect(retained).toBeTruthy();
  expect(getComputedStyle(retained).visibility).toBe('hidden');
  expect(useTerminalViewStore.getState().retained.a).toBe('thread:t');
  expect(useTerminalViewStore.getState().target).toBeNull();
});
