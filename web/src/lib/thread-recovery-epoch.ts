/** Invalidates asynchronous history work on reopen, deletion and eviction. */
const epochs = new Map<string, { thread: number; recovery: number }>();
let sequence = 0;

/** Captures which incarnation of a retained conversation a read belongs to. */
export function currentRecoveryEpoch(threadId: string): number {
  return epochs.get(threadId)?.recovery ?? 0;
}

/** Opens survive a transport repair, but not another open/deletion/restart. */
export function currentThreadEpoch(threadId: string): number {
  return epochs.get(threadId)?.thread ?? 0;
}

/** Invalidates all work for a discarded or replaced conversation incarnation. */
export function invalidateThreadEpoch(threadId: string): void {
  const next = ++sequence;
  epochs.set(threadId, { thread: next, recovery: next });
}

/** A replacement read must not join or apply an older incarnation's work. */
export function supersedeRecovery(threadId: string): void {
  epochs.set(threadId, {
    thread: currentThreadEpoch(threadId),
    recovery: ++sequence,
  });
}
