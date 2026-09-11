/** Evidence lives only for the duration of its pending-set HTTP read. */
export const activePendingReads = new Set<{
  superseded: boolean;
  excluded: Set<string>;
  retired: Set<string>;
}>();

/**
 * A discarded runtime must not be rebuilt from a pre-discard snapshot, even
 * if navigation recreates its shell before the response arrives. This also
 * preserves a local decision when its now-idle runtime is evicted mid-read.
 */
export function excludePendingReads(threadIds: Iterable<string>): void {
  for (const threadId of threadIds) {
    for (const read of activePendingReads) read.excluded.add(threadId);
  }
}
