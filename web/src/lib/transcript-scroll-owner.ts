/** One owner coordinates user intent, hidden-tab restoration, and bounded semantic corrections. */
import type { Virtualizer } from '@tanstack/react-virtual';
import {
  captureReadingAnchor,
  readingAnchorDelta,
  readTranscriptBookmark,
  saveTranscriptBookmark,
  type ReadingAnchor,
} from './transcript-anchor';

/**
 * Distance from the end still counted as "at the end".
 *
 * This is not only the follow heuristic: it is also handed to the virtualizer
 * as `scrollEndThreshold`, which gates the library's own end-anchored
 * compensation during measurement. A tight value limits that branch to the
 * tail; it does not disable it, including on first measurements and backward
 * scrolls. This owner corrects the residual after those library writes. Raising
 * the threshold would also widen the library's compensation region.
 */
export const AT_END_THRESHOLD_PX = 2;

/**
 * Passes one geometry batch may spend chasing its reading point.
 *
 * Bounded rather than looped to convergence: a pathological layout that never
 * settles must give the reader back a usable scroller instead of spinning, and
 * an unbounded retry is the "timer reasserting an anchor" this design rejects.
 */
const CORRECTION_PASSES = 6;

/** Consecutive zero-displacement passes that end a correction transaction. */
const SETTLED_PASSES = 2;

/** Imperative geometry lives outside React render; snapshots are taken only from committed DOM. */
export class TranscriptScrollOwner {
  readonly threadId: string;
  element: HTMLDivElement | null = null;
  virtualizer: Virtualizer<HTMLDivElement, Element> | null = null;
  active = true;
  ready = false;
  following: boolean;
  anchor: ReadingAnchor | null;
  private pending: ReadingAnchor | null = null;
  private restore = true;
  private revealing = true;
  private width: number;
  private offset: number;
  private queued = false;
  /** Corrections spent on the current batch, reset once it converges. */
  private passes = 0;
  /** Consecutive passes that needed no movement, so far, in this batch. */
  private settled = 0;
  private measuring = false;
  private disposed = false;
  private userIntent = false;
  private pointerHeld = false;
  private lastSignal = 0;
  private observedHeight = 0;
  private expectedOffset = 0;
  private onPosition: (atEnd: boolean) => void = () => undefined;

  /** Restores intent without guessing that an old viewport offset still identifies the same text. */
  constructor(threadId: string) {
    this.threadId = threadId;
    const saved = readTranscriptBookmark(threadId);
    this.following = saved?.follow ?? true;
    this.anchor = saved?.anchor ?? null;
    this.width = saved?.width ?? 0;
    this.offset = saved?.offset ?? 0;
  }

  /** Binds the stable scroller. Ref cleanup only saves state; it does not navigate. */
  bind(element: HTMLDivElement | null): void {
    if (!element && this.element) this.save();
    this.element = element;
    if (element) this.expectedOffset = element.scrollTop;
  }

  /** Captures before React mutation; subsequent changes in the same batch keep the first point. */
  beforeCommit(): void {
    if (
      !this.active ||
      this.following ||
      this.userIntent ||
      this.restore ||
      this.pending ||
      !this.element
    )
      return;
    this.pending = captureReadingAnchor(this.element) ?? this.anchor;
  }

  /** A measurement callback only schedules: resizeItem has not yet consumed its returned size. */
  rowResized(): void {
    if (this.measuring || this.disposed || this.userIntent || !this.active)
      return;
    if (!this.pending && !this.following) this.pending = this.anchor;
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.disposed) this.correct();
    });
  }

  /** Commits after the adapter's layout effects, with synchronous measurements for React changes. */
  commit(
    virtualizer: Virtualizer<HTMLDivElement, Element>,
    options: {
      active: boolean;
      ready: boolean;
      signal: number;
      onPosition: (atEnd: boolean) => void;
    },
  ): void {
    this.disposed = false;
    this.virtualizer = virtualizer;
    this.onPosition = options.onPosition;
    if (this.active && !options.active) {
      this.save();
      this.anchor = this.pending ?? this.anchor;
      this.resetCorrection();
      this.userIntent = false;
      this.pointerHeld = false;
    }
    if (!this.active && options.active) {
      this.restore = true;
      this.revealing = true;
    }
    this.active = options.active;
    if (!this.ready && options.ready) {
      const saved = readTranscriptBookmark(this.threadId);
      if (saved) {
        this.anchor = saved.anchor;
        this.following = saved.follow;
        this.offset = saved.offset;
      }
    }
    this.ready = options.ready;
    if (options.signal !== this.lastSignal) {
      this.following = true;
      this.resetCorrection();
      this.anchor = null;
      this.restore = true;
    }
    this.lastSignal = options.signal;
    this.checkGeometry();
    this.correct();
  }

  /** Invalidates widths only when actual text-column geometry changes, never simply on activation. */
  private checkGeometry(): boolean {
    const element = this.element;
    if (!element || !this.virtualizer) return false;
    const width =
      element.querySelector<HTMLElement>('[data-transcript-column]')
        ?.clientWidth ?? element.clientWidth;
    const changed = this.width !== 0 && width !== this.width;
    if (changed) {
      if (!this.pending && !this.following) this.pending = this.anchor;
      // Every cached row was measured at the old common column width.
      this.virtualizer.measure();
    }
    const heightChanged = element.clientHeight !== this.observedHeight;
    this.width = width;
    this.observedHeight = element.clientHeight;
    if (changed || heightChanged) this.expectedOffset = element.scrollTop;
    return changed || heightChanged;
  }

  /** Handles real viewport/font events without waiting for an unrelated React render. */
  geometryChanged(fonts = false): void {
    if (!this.pending && !this.following) this.pending = this.anchor;
    if (fonts) this.virtualizer?.measure();
    if (this.checkGeometry() && this.following) this.restore = true;
    this.rowResized();
  }

  /** Corrects one geometry batch; its only scroll command is an absolute, nonanimated offset. */
  private correct(): void {
    const element = this.element;
    const virtualizer = this.virtualizer;
    if (
      !element ||
      !virtualizer ||
      !this.ready ||
      !this.active ||
      this.userIntent ||
      element.clientHeight === 0
    )
      return;
    // Browser navigation can update scrollTop before dispatching its scroll
    // event. Do not let an intervening streaming commit undo that move.
    if (!this.restore && this.hasNavigationOffset()) {
      this.scrolled();
      return;
    }
    this.measuring = true;
    for (const row of element.querySelectorAll<HTMLElement>(
      '[data-transcript-row]',
    ))
      virtualizer.measureElement(row);
    this.measuring = false;
    if (this.following) {
      // Following means "stay at the end", so every geometry batch re-pins.
      // Gating this on an append or a viewport change missed the batch that
      // actually moves the end: rows replacing their estimated height with a
      // measured one grow the extent without changing the count or the
      // viewport, which is exactly how a cold open settles. User input is
      // excluded above; native scroll attribution also handles focus/search
      // navigation that arrived without a preceding wheel or pointer event.
      virtualizer.scrollToOffset(
        Math.max(0, element.scrollHeight - element.clientHeight),
      );
    } else {
      const anchor = this.pending ?? (this.restore ? this.anchor : null);
      const delta = anchor ? readingAnchorDelta(element, anchor) : null;
      let retain = false;
      if (anchor) this.passes++;
      if (delta !== null && Math.abs(delta) > 0.5) {
        const requested = element.scrollTop + delta;
        const target = Math.max(
          0,
          Math.min(element.scrollHeight - element.clientHeight, requested),
        );
        virtualizer.scrollToOffset(target);
        this.settled = 0;
        // An unreachable point accepts clamping rather than spending another
        // pass writing the same edge. Subpixel rounding is not clamping.
        retain = Math.abs(element.scrollTop - requested) <= 1;
      } else if (delta !== null) {
        // One zero-displacement pass is a sample, not convergence. Measured
        // over an 800→430 column change: invalidating the width cache puts
        // every unmounted row back on its estimate, the anchor is restored
        // exactly, the next pass reads zero — and then the rows above it mount
        // and measure taller, moving the point by ~950px. Releasing on that
        // first zero re-anchored to a half-converged position and then
        // "corrected" towards it, walking the reader away from the sentence
        // that had just been put back. The transaction is the batch, so it
        // survives until two consecutive passes need no movement.
        retain = ++this.settled < SETTLED_PASSES;
      } else if (this.restore && !anchor)
        virtualizer.scrollToOffset(this.offset);
      // Missing geometry is not a zero-displacement sample. Only real commit
      // or measurement notifications advance this bounded batch; no timer
      // waits for fonts/images or reasserts a target after it is released.
      if (retain && this.passes < CORRECTION_PASSES) {
        this.pending = anchor;
        this.offset = element.scrollTop;
        this.expectedOffset = element.scrollTop;
        this.onPosition(this.atEnd());
        this.save();
        return;
      }
    }
    this.resetCorrection();
    this.restore = false;
    if (!this.following)
      this.anchor = captureReadingAnchor(element) ?? this.anchor;
    this.offset = element.scrollTop;
    this.expectedOffset = element.scrollTop;
    this.onPosition(this.atEnd());
    this.save();
  }

  /** A cold reveal waits until measured rows cover the actual usable viewport, not an estimated range. */
  rangeMeasured(inset: number): boolean {
    const element = this.element;
    const virtualizer = this.virtualizer;
    if (!this.active || !element?.clientHeight || !virtualizer) return false;
    if (!this.revealing) return true;
    if (virtualizer.options.count === 0) {
      this.revealing = false;
      return true;
    }
    const viewport = element.getBoundingClientRect();
    const start =
      viewport.top - element.scrollTop + virtualizer.options.paddingStart;
    const end =
      viewport.top - element.scrollTop + virtualizer.getTotalSize() - inset;
    let covered = Math.max(viewport.top, start);
    const needed = Math.min(viewport.bottom - inset, end);
    const rows = [
      ...element.querySelectorAll<HTMLElement>('[data-transcript-row]'),
    ]
      .map((row) => row.getBoundingClientRect())
      .sort((a, b) => a.top - b.top);
    for (const row of rows) {
      if (row.bottom <= covered) continue;
      if (row.top > covered + 1) break;
      covered = row.bottom;
      if (covered >= needed - 1) {
        this.revealing = false;
        return true;
      }
    }
    if (covered >= needed) this.revealing = false;
    return !this.revealing;
  }

  /** Real input cancels the old correction; library scroll events alone do not change user intent. */
  beginInput(pointer = false): void {
    if (!this.active) return;
    this.userIntent = true;
    this.pointerHeld ||= pointer;
    this.resetCorrection();
    this.restore = false;
  }

  /** Ends pointer capture; inertia is still tracked by the virtualizer's scrolling lifecycle. */
  endPointer(): void {
    this.pointerHeld = false;
    this.endInput();
  }

  /** Called from scroll-end/virtualizer notifications, never from a timer that writes an offset. */
  endInput(): void {
    // A non-scrolling measurement notification is not the end of an input
    // gesture. Clearing its pending anchor would discard a resize transaction.
    if (!this.userIntent || this.pointerHeld || this.virtualizer?.isScrolling)
      return;
    if (this.active && this.element && this.hasNavigationOffset())
      this.scrolled();
    this.userIntent = false;
    this.resetCorrection();
    if (this.active && this.element) this.offset = this.element.scrollTop;
    if (this.active && this.element && !this.following)
      this.anchor = captureReadingAnchor(this.element);
    this.save();
    if (this.following) this.correct();
  }

  /** Returns whether this event represents user scrolling eligible to request older history. */
  scrolled(): boolean {
    if (!this.active || !this.ready || !this.element) return false;
    if (!this.hasNavigationOffset()) return false;
    // All library/application writes are recorded by scrollToFn. A different
    // visible offset is browser/user navigation, including focus and find-in-page.
    if (!this.userIntent) this.beginInput();
    this.expectedOffset = this.element.scrollTop;
    this.following = this.atEnd();
    this.offset = this.element.scrollTop;
    if (!this.following) this.anchor = captureReadingAnchor(this.element);
    this.onPosition(this.following);
    this.save();
    return true;
  }

  /** Records actual (possibly clamped) geometry after every library or application scroll write. */
  programmaticScroll(): void {
    if (this.element) this.expectedOffset = this.element.scrollTop;
  }

  /** Extent shrinkage clamps offsets without navigation, even if viewport size is unchanged. */
  private hasNavigationOffset(): boolean {
    const element = this.element;
    if (!element || Math.abs(element.scrollTop - this.expectedOffset) < 0.5)
      return false;
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    const clamped = Math.max(0, Math.min(maximum, this.expectedOffset));
    if (Math.abs(element.scrollTop - clamped) < 0.5) {
      this.expectedOffset = element.scrollTop;
      return false;
    }
    return true;
  }

  /** An explicit user action resumes following, unlike incoming output or tab activation. */
  jumpToLatest(): void {
    this.following = true;
    this.userIntent = false;
    this.pointerHeld = false;
    this.anchor = null;
    this.resetCorrection();
    this.restore = true;
    this.correct();
  }

  /** Uses live DOM geometry, since the library's cached offset may lag the current scroll event. */
  private atEnd(): boolean {
    const el = this.element;
    return (
      !el ||
      el.scrollHeight - el.scrollTop - el.clientHeight <= AT_END_THRESHOLD_PX
    );
  }

  /** Persists only a semantic bookmark and user intent for this browser session. */
  save(): void {
    saveTranscriptBookmark(this.threadId, {
      follow: this.following,
      anchor: this.pending ?? this.anchor,
      offset: this.offset,
      width: this.width,
    });
  }

  /** Cancels queued DOM work when changing conversations; retained bookmarks remain valid identities. */
  dispose(): void {
    this.save();
    this.resetCorrection();
    this.disposed = true;
  }

  /** Releases the complete batch budget along with its semantic target. */
  private resetCorrection(): void {
    this.pending = null;
    this.passes = 0;
    this.settled = 0;
  }
}
