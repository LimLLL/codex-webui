/**
 * Owns whether the transcript is showing the latest output, and every scroll
 * write this client makes.
 *
 * The virtualizer keeps the end pinned while a row grows (`anchorTo: 'end'`),
 * but it is deliberately not asked to follow appends: its own append-follow
 * routes through `scrollToIndex`, which leaves a target it re-derives for up to
 * five seconds and re-applies whenever that target moves — which, during
 * streaming, is every frame. Following an append is therefore done here with a
 * single fixed-offset write, so nothing in the system ever holds an indexed
 * scroll target.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { TimelineEntry } from '@/types/timeline';

/**
 * Distance from the end, in px, within which the transcript counts as showing
 * the latest output.
 *
 * Shared with the virtualizer's `scrollEndThreshold` so the return control and
 * the library's own end-holding cannot disagree. That equivalence only holds
 * because the scroller contains nothing outside the virtualizer's measured
 * extent: the library measures against `getTotalSize()` while this measures
 * against `scrollHeight`, so any unmeasured element in the scroller would
 * offset the two by its own height. The "load earlier" control is kept inside
 * reserved leading space for exactly this reason.
 */
export const AT_END_THRESHOLD_PX = 80;

interface Params {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollRef: RefObject<HTMLDivElement | null>;
  timeline: TimelineEntry[];
  threadId: string | null;
  /** Space reserved for a composer floating over the transcript. */
  bottomInset: number;
  /** Increments on each accepted send or steer. */
  scrollToLatestSignal: number;
}

interface Result {
  /** Whether the transcript is showing the latest output. */
  atEnd: boolean;
  /** Attach to the scroll container's `onScroll`. */
  handleScroll: () => void;
  /** Returns to the latest output and resumes following. */
  returnToLatest: () => void;
}

/**
 * Tracks and controls the transcript's follow state.
 *
 * @param params - Virtualizer, scroller, and the store state the decisions read.
 * @returns Follow state plus the handlers the transcript binds.
 */
export function useTranscriptFollow({
  virtualizer,
  scrollRef,
  timeline,
  threadId,
  bottomInset,
  scrollToLatestSignal,
}: Params): Result {
  const [atEnd, setAtEnd] = useState(true);

  // Adjusted during render rather than in an effect: in an effect, a
  // conversation switch would render one frame still offering to return to the
  // previous conversation's end, and correctness would depend on effect order.
  const [seenThreadId, setSeenThreadId] = useState(threadId);
  if (threadId !== seenThreadId) {
    setSeenThreadId(threadId);
    setAtEnd(true);
  }

  // Mirrors `atEnd` for the effects that must not re-run when it flips. An
  // effect depending on the state would fire the moment the reader crosses back
  // inside the threshold and snap away the remaining distance — the same yank
  // this hook exists to remove, just in the last 80px.
  const atEndRef = useRef(true);
  const pendingInitialRef = useRef(true);
  const lastThreadIdRef = useRef(threadId);
  const lastCountRef = useRef(timeline.length);
  const lastSignalRef = useRef(scrollToLatestSignal);
  const lastInsetRef = useRef(bottomInset);

  /**
   * Reads the end state from live DOM geometry.
   *
   * Deliberately not `virtualizer.isAtEnd()`: React's `onScroll` prop runs
   * before the listener the virtualizer registers on the same element, so the
   * library's cached offset is still the previous one at that point and the
   * control would settle on a stale answer until the next scroll.
   */
  const readAtEndFromDom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return (
      el.scrollHeight - el.scrollTop - el.clientHeight <= AT_END_THRESHOLD_PX
    );
  }, [scrollRef]);

  const applyAtEnd = useCallback((next: boolean) => {
    atEndRef.current = next;
    setAtEnd(next);
  }, []);

  /**
   * Moves to the end with a one-shot offset write.
   *
   * An offset target is fixed: reconciliation compares it against the live
   * offset and never re-derives it, so it cannot chase a growing transcript and
   * cannot fight a reader who scrolled away. An indexed target — what
   * `scrollToEnd()`/`scrollToIndex()` install — re-derives every frame for five
   * seconds, which is the defect this whole change exists to remove.
   */
  const pinToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // The library's own maximum is private; this is the same quantity, and
    // `scrollToOffset` clamps to the real maximum anyway, so an overshoot from
    // a mid-layout read lands at the end rather than past it.
    virtualizer.scrollToOffset(el.scrollHeight - el.clientHeight);
    applyAtEnd(true);
  }, [virtualizer, scrollRef, applyAtEnd]);

  const handleScroll = useCallback(() => {
    applyAtEnd(readAtEndFromDom());
  }, [applyAtEnd, readAtEndFromDom]);

  const returnToLatest = useCallback(() => {
    pinToEnd();
  }, [pinToEnd]);

  // Landing and append-following, both before paint.
  //
  // Landing is navigation-scoped and deferred: opening a conversation renders
  // an empty, *different* container that carries no scroller, so there is
  // nothing to scroll until the first page commits. The pending flag is raised
  // here rather than in its own effect so a conversation switch cannot be
  // serviced out of order relative to the landing it requests.
  //
  // Appending is followed here rather than by `followOnAppend` because the
  // library's version installs an indexed target. Gated on the entry count
  // growing — an in-place delta needs no write, since the library already holds
  // the end through its own size compensation — and on having been at the end
  // *before* the append, read from the ref so a reader inside the threshold is
  // never dragged the rest of the way.
  useLayoutEffect(() => {
    const prevCount = lastCountRef.current;
    const threadChanged = threadId !== lastThreadIdRef.current;
    lastThreadIdRef.current = threadId;
    lastCountRef.current = timeline.length;
    if (threadChanged) {
      pendingInitialRef.current = true;
      // Matches the render-time reset, so an incoming conversation is never
      // treated as detached in the window before its first page commits.
      atEndRef.current = true;
    }

    if (timeline.length === 0 || !scrollRef.current) return;
    if (pendingInitialRef.current) {
      pendingInitialRef.current = false;
      pinToEnd();
      return;
    }
    if (timeline.length > prevCount && atEndRef.current) pinToEnd();
  }, [timeline, threadId, scrollRef, pinToEnd]);

  // The composer growing changes the scroll range without moving `scrollTop`
  // and without emitting a scroll event, so a reader who was following would
  // silently fall outside the threshold and stop being followed.
  useEffect(() => {
    if (bottomInset === lastInsetRef.current) return;
    lastInsetRef.current = bottomInset;
    if (atEndRef.current) pinToEnd();
    // Reading committed layout is precisely what an effect is for: the new
    // `scrollHeight` does not exist until the composer's new height has been
    // laid out, so there is no render-time answer to derive this from.
    else applyAtEnd(readAtEndFromDom());
  }, [bottomInset, pinToEnd, applyAtEnd, readAtEndFromDom]);

  // The same hazard from the other direction: the viewport, a split pane or an
  // in-flow composer can shrink the scroller itself. That changes the distance
  // to the end without moving `scrollTop` and without a scroll event, so a
  // follower would be stranded just outside the threshold with the return
  // control still hidden.
  const hasScroller = timeline.length > 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !hasScroller || typeof ResizeObserver === 'undefined') return;
    let lastHeight = el.clientHeight;
    const observer = new ResizeObserver(() => {
      // Only the scroller's own box matters. Content growth is already handled
      // by the virtualizer, and reacting to it here would re-pin on every
      // streaming delta.
      if (el.clientHeight === lastHeight) return;
      lastHeight = el.clientHeight;
      if (atEndRef.current) pinToEnd();
      else applyAtEnd(readAtEndFromDom());
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef, hasScroller, pinToEnd, applyAtEnd, readAtEndFromDom]);

  // An accepted send or steer resumes following, on the composer's explicit
  // signal rather than on the timeline growing.
  useEffect(() => {
    if (scrollToLatestSignal === lastSignalRef.current) return;
    lastSignalRef.current = scrollToLatestSignal;
    pinToEnd();
  }, [scrollToLatestSignal, pinToEnd]);

  return { atEnd, handleScroll, returnToLatest };
}
