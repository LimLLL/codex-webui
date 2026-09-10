/**
 * Item authority and merge rules shared by live streaming and history recovery.
 *
 * Three things the codebase previously conflated are separated here: item
 * lifecycle (fragment vs terminal), turn lifecycle, and history coverage. The
 * separation is forced by measured app-server behaviour:
 *
 *  - Persistence happens at item completion, not turn completion, so a running
 *    turn does expose its already-finished items. Recovering them is possible.
 *  - A terminal payload carries the whole accumulated result (`aggregatedOutput`
 *    and friends), never a tail. So repairing a fragment is a REPLACEMENT, and
 *    concatenating a snapshot onto streamed deltas would duplicate content.
 *  - Persisted order is completion order while live order is start order. When
 *    two items overlap in time the two lists genuinely disagree, and nothing can
 *    align them: items carry no timestamp and no sequence field, only the turn
 *    does. Live order is therefore authoritative for anything live has seen, and
 *    persisted adjacency only places items live never saw.
 */
import { mergeTurnItem } from '@/lib/thread-item-normalizer';
import type { TurnItem } from '@/types/timeline';

/**
 * Whether a streamed update may still be applied to an item already held.
 *
 * A delta that arrives after the terminal payload is stale by construction —
 * the terminal payload already contains what that delta carried. Appending it
 * would duplicate text and reopen a finished item.
 */
export function acceptsStreamedUpdate(existing: TurnItem | undefined): boolean {
  return !existing?.completed;
}

/**
 * Monotonic counter stamped onto every item a live notification writes.
 *
 * Deliberately module-global rather than per-thread runtime state: it only ever
 * has to be monotonic, comparisons are always between items of the same thread,
 * and a field on the runtime would have to be mirrored through the store's
 * selected-thread projection or be silently dropped on every round trip.
 */
let observationSeq = 0;

/** Advances and returns the counter for a live write. */
export function nextObservationSeq(): number {
  return ++observationSeq;
}

/** Reads the counter without advancing it, to baseline a recovery request. */
export function currentObservationSeq(): number {
  return observationSeq;
}

export interface RecoveryMergeOptions {
  /**
   * Observation counter captured when the recovery request was issued. Anything
   * stamped above it was written by a notification that arrived while the
   * request was in flight, and therefore outranks the snapshot.
   */
  baselineSeq: number;
}

/**
 * Chooses the surviving payload for an item present in both lists.
 *
 * Encodes the authority table: a terminal snapshot repairs a fragment, a
 * terminal observation that arrived during the fetch outranks the snapshot, and
 * an explicitly non-terminal snapshot may only fill blanks in live content.
 */
function selectPayload(
  persisted: TurnItem,
  live: TurnItem,
  baselineSeq: number,
): TurnItem {
  // Observed after the request went out: the snapshot cannot know about it.
  if (live.completed && (live.observedSeq ?? 0) > baselineSeq) return live;
  // The snapshot is terminal. It holds the accumulated result, so it replaces a
  // fragment outright and supersedes an older terminal observation. Live
  // provenance is preserved so a later merge still ranks this correctly.
  if (persisted.completed) {
    return { ...persisted, observedSeq: live.observedSeq };
  }
  // The snapshot is explicitly unfinished: live content wins, snapshot only
  // contributes fields live never received.
  return mergeTurnItem(persisted, live);
}

/**
 * Merges a persisted item page into the items a thread already holds live.
 *
 * Ordering follows live for every item live knows. Items only persistence knows
 * are inserted after the last live-known item that preceded them in the
 * persisted page, which is the only placement signal available for them.
 *
 * @param persisted - Items from history, in persisted (completion) order
 * @param live - Items currently held, in live (start) order
 * @param options - Recovery baseline used to rank competing observations
 * @returns One ordered, duplicate-free list
 */
export function mergeRecoveredItems(
  persisted: TurnItem[],
  live: TurnItem[],
  { baselineSeq }: RecoveryMergeOptions,
): TurnItem[] {
  if (persisted.length === 0) return live;
  if (live.length === 0) return persisted;

  const liveById = new Map(live.map((item) => [item.itemId, item]));
  // Persisted-only items, grouped by the live-known item they follow. The key
  // `null` collects those preceding every anchor.
  const trailing = new Map<string | null, TurnItem[]>();
  let anchor: string | null = null;
  for (const item of persisted) {
    if (liveById.has(item.itemId)) {
      anchor = item.itemId;
      continue;
    }
    const bucket = trailing.get(anchor);
    if (bucket) bucket.push(item);
    else trailing.set(anchor, [item]);
  }

  const persistedById = new Map(persisted.map((item) => [item.itemId, item]));
  const merged: TurnItem[] = [...(trailing.get(null) ?? [])];
  for (const liveItem of live) {
    const snapshot = persistedById.get(liveItem.itemId);
    merged.push(
      snapshot ? selectPayload(snapshot, liveItem, baselineSeq) : liveItem,
    );
    const after = trailing.get(liveItem.itemId);
    if (after) merged.push(...after);
  }
  return merged;
}
