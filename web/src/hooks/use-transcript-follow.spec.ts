import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { TimelineEntry } from '@/types/timeline';
import { useTranscriptFollow } from './use-transcript-follow';

/**
 * jsdom performs no layout, so the scroller's geometry is supplied directly —
 * and stays writable, because several of these cases turn on the scroll range
 * changing underneath a stationary `scrollTop`.
 */
function makeScroller(geometry: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}) {
  const el = document.createElement('div');
  Object.defineProperties(el, {
    scrollHeight: {
      value: geometry.scrollHeight,
      writable: true,
      configurable: true,
    },
    clientHeight: {
      value: geometry.clientHeight,
      writable: true,
      configurable: true,
    },
    scrollTop: { value: geometry.scrollTop, writable: true, configurable: true },
  });
  return el as HTMLDivElement & {
    scrollHeight: number;
    clientHeight: number;
  };
}

function turn(turnId: string): TimelineEntry {
  return { kind: 'turn', turnId, items: [], completed: false };
}

let scrollToOffset: ReturnType<typeof vi.fn>;
let virtualizer: Virtualizer<HTMLDivElement, Element>;

beforeEach(() => {
  scrollToOffset = vi.fn();
  virtualizer = { scrollToOffset } as unknown as Virtualizer<
    HTMLDivElement,
    Element
  >;
});

function setup(overrides: {
  timeline: TimelineEntry[];
  scroller: HTMLDivElement | null;
  threadId?: string | null;
  bottomInset?: number;
  scrollToLatestSignal?: number;
}) {
  const scrollRef = { current: overrides.scroller };
  const view = renderHook(
    (props: typeof overrides) =>
      useTranscriptFollow({
        virtualizer,
        scrollRef,
        timeline: props.timeline,
        threadId: props.threadId ?? 't1',
        bottomInset: props.bottomInset ?? 0,
        scrollToLatestSignal: props.scrollToLatestSignal ?? 0,
      }),
    { initialProps: overrides },
  );
  return { view, scrollRef };
}

/** Scrolls the transcript away from the end and reports the detached state. */
function detach(
  view: ReturnType<typeof setup>['view'],
  scroller: HTMLDivElement,
) {
  scroller.scrollTop = 0;
  act(() => view.result.current.handleScroll());
  expect(view.result.current.atEnd).toBe(false);
}

describe('initial landing', () => {
  it('defers landing until content and a scroller both exist', () => {
    // The loading state renders a different container that carries no scroller,
    // so the conversation opens with nothing to scroll. Landing must survive
    // that gap: the virtualizer skips its own end handling while it has no
    // scroll element, and attaching one later does not replay the decision.
    const { view, scrollRef } = setup({ timeline: [], scroller: null });
    expect(scrollToOffset).not.toHaveBeenCalled();

    scrollRef.current = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 0,
    });
    act(() => {
      view.rerender({ timeline: [turn('a'), turn('b')], scroller: null });
    });

    expect(scrollToOffset).toHaveBeenCalledWith(2400);
    expect(view.result.current.atEnd).toBe(true);
  });

  it('lands again on a conversation switch that keeps the entry count', () => {
    // Landing is scoped to navigation, not to the timeline growing: two
    // conversations can present the same number of entries, and the incoming
    // one still has to open at its latest message.
    const scroller = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 0,
    });
    const { view } = setup({ timeline: [turn('a')], scroller });
    expect(scrollToOffset).toHaveBeenCalledTimes(1);

    act(() => {
      view.rerender({ timeline: [turn('x')], scroller, threadId: 't2' });
    });
    expect(scrollToOffset).toHaveBeenCalledTimes(2);
  });
});

describe('following appends', () => {
  it('closes the estimate gap when an entry is appended while following', () => {
    // The virtualizer holds the end as a row grows, but a newly appended row
    // enters at its estimated height, leaving the transcript short of the true
    // bottom. Its own append-follow would close that gap through an indexed
    // scroll target, which chases a growing transcript for five seconds; this
    // is the fixed-offset equivalent.
    const scroller = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2400,
    });
    const { view } = setup({ timeline: [turn('a')], scroller });
    scrollToOffset.mockClear();

    scroller.scrollHeight = 3080;
    act(() => {
      view.rerender({ timeline: [turn('a'), turn('b')], scroller });
    });
    expect(scrollToOffset).toHaveBeenCalledWith(2480);
  });

  it('leaves a detached reader alone when an entry is appended', () => {
    const scroller = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2400,
    });
    const { view } = setup({ timeline: [turn('a')], scroller });
    detach(view, scroller);
    scrollToOffset.mockClear();

    scroller.scrollHeight = 3080;
    act(() => {
      view.rerender({ timeline: [turn('a'), turn('b')], scroller });
    });
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it('does not write for an in-place update, which the virtualizer holds', () => {
    const scroller = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2400,
    });
    const { view } = setup({ timeline: [turn('a')], scroller });
    scrollToOffset.mockClear();

    scroller.scrollHeight = 3200;
    act(() => {
      view.rerender({ timeline: [turn('a2')], scroller });
    });
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it('does not drag a reader who scrolls back inside the threshold', () => {
    // Re-entering the last 80px must not snap away the remaining distance:
    // that is the same yank at small scale, and it fights a slow upward drag.
    // It is why the follow decision reads a ref rather than depending on the
    // `atEnd` state, which would re-run the effect on the crossing itself.
    const scroller = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2400,
    });
    const { view } = setup({ timeline: [turn('a')], scroller });
    detach(view, scroller);
    scrollToOffset.mockClear();

    scroller.scrollTop = 2360;
    act(() => view.result.current.handleScroll());
    expect(view.result.current.atEnd).toBe(true);
    expect(scrollToOffset).not.toHaveBeenCalled();
  });
});

describe('the return control', () => {
  it('is offered while detached and withdrawn on returning to the end', () => {
    const scroller = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2400,
    });
    const { view } = setup({ timeline: [turn('a')], scroller });
    expect(view.result.current.atEnd).toBe(true);
    detach(view, scroller);

    scroller.scrollTop = 2400;
    act(() => view.result.current.handleScroll());
    expect(view.result.current.atEnd).toBe(true);
  });

  it('is not carried across a conversation switch', () => {
    const scroller = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2400,
    });
    const { view } = setup({ timeline: [turn('a')], scroller });
    detach(view, scroller);

    act(() => {
      view.rerender({ timeline: [turn('x')], scroller, threadId: 't2' });
    });
    expect(view.result.current.atEnd).toBe(true);
  });
});

describe('geometry changes that emit no scroll event', () => {
  it('re-pins a follower to the new bottom when the composer grows', () => {
    // Growing the composer enlarges the scroll range without moving scrollTop
    // and without emitting a scroll event, so a follower would silently fall
    // outside the threshold and stop being followed.
    const scroller = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2400,
    });
    const { view } = setup({ timeline: [turn('a')], scroller, bottomInset: 80 });
    scrollToOffset.mockClear();

    scroller.scrollHeight = 3160;
    act(() => {
      view.rerender({ timeline: [turn('a')], scroller, bottomInset: 240 });
    });
    expect(scrollToOffset).toHaveBeenCalledWith(2560);
  });

  it('refreshes the reported distance when the composer grows while detached', () => {
    const scroller = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2400,
    });
    const { view } = setup({ timeline: [turn('a')], scroller, bottomInset: 80 });
    expect(view.result.current.atEnd).toBe(true);
    scroller.scrollTop = 2000;
    act(() => view.result.current.handleScroll());
    scrollToOffset.mockClear();

    scroller.scrollHeight = 3160;
    act(() => {
      view.rerender({ timeline: [turn('a')], scroller, bottomInset: 240 });
    });
    expect(scrollToOffset).not.toHaveBeenCalled();
    expect(view.result.current.atEnd).toBe(false);
  });
});

describe('explicit send', () => {
  it('returns to the latest output when the composer reports a send', () => {
    const scroller = makeScroller({
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2400,
    });
    const { view } = setup({ timeline: [turn('a')], scroller });
    detach(view, scroller);
    scrollToOffset.mockClear();

    act(() => {
      view.rerender({
        timeline: [turn('a')],
        scroller,
        scrollToLatestSignal: 1,
      });
    });
    expect(scrollToOffset).toHaveBeenCalledWith(2400);
    expect(view.result.current.atEnd).toBe(true);
  });
});
