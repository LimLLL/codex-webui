/** Decides when approaching the top of a transcript should fetch older history. */

/**
 * Distance from the top, in px, at which the next page of older history is
 * fetched. Deliberately larger than the "at end" threshold: this is a prefetch
 * margin meant to hide latency before the reader reaches the top, not a test
 * for having arrived somewhere.
 */
export const PREFETCH_OLDER_PX = 240;

/** Scroll geometry and history state a prefetch decision is made from. */
export interface PrefetchOlderInput {
  /** The scroll offset the event being handled reports. */
  scrollTop: number;
  /** The offset the previous scroll event reported. */
  previousScrollTop: number;
  /** Whether the conversation still has an older page to fetch. */
  hasCursor: boolean;
  /** Whether a page is already in flight. */
  loading: boolean;
}

/**
 * Reports whether this scroll event should request the next older page.
 *
 * Requires upward movement rather than only proximity to the top. Every
 * deliberate write this client makes moves the offset down or leaves it
 * unchanged — landing on open, returning to latest, following an append, and
 * the anchor restoration that runs after a prepend — so without the direction
 * test a short-but-scrollable transcript would fetch a page on every one of
 * them, and returning to the latest message would page in history the reader
 * never asked for.
 *
 * @param input - Scroll geometry and history state.
 * @returns True when an older page should be requested.
 */
export function shouldPrefetchOlder({
  scrollTop,
  previousScrollTop,
  hasCursor,
  loading,
}: PrefetchOlderInput): boolean {
  if (!hasCursor || loading) return false;
  if (scrollTop >= previousScrollTop) return false;
  return scrollTop <= PREFETCH_OLDER_PX;
}
