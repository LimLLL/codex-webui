/**
 * Recovers state this client may never have received live.
 *
 * Two situations need it, and they need the same thing:
 *
 *  - Opening a thread mid-turn. The open path asks for the cheap `summary`
 *    view, which carries only user messages and a turn's final assistant
 *    message. A running turn has no final message yet, so everything the agent
 *    already produced comes back empty and the transcript looks erased until
 *    the turn ends.
 *  - Reconnecting after a dropped socket. Socket.IO guarantees ordering, not
 *    replay of what was missed while disconnected.
 *
 * In both cases the durable history already holds the answer: app-server
 * persists an item when that item completes, not when its turn does, so a
 * running turn does expose its finished items. What it cannot supply is the
 * item still in flight — that one is repaired by its own terminal payload when
 * it arrives, which carries the whole accumulated result rather than a tail.
 *
 * Reconnect additionally has to repair TURN LIFECYCLE, not just items. Items
 * and lifecycle are separate facts carried by separate notifications, and a
 * turn that started before the gap and finished during it emits its
 * `turn/completed` into the void. Recovering only its items leaves the
 * transcript correct and the composer spinning forever.
 */
import {
  threadsListTurnItems,
  threadsListTurns,
} from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import { currentObservationSeq } from '@/lib/turn-item-merge';
import type { ThreadTurnsPageDto } from '@/generated/api';
import {
  currentRecoveryEpoch,
  supersedeRecovery,
} from './thread-recovery-epoch';
export { supersedeRecovery } from './thread-recovery-epoch';

/**
 * Recoveries currently in flight, keyed by thread, turn and epoch.
 *
 * Opening, reconnecting and re-rendering can all ask for the same repair at
 * once; coalescing them keeps one request per turn rather than a burst that
 * would each apply the same snapshot. The epoch belongs in the key: without it
 * a superseding event left the stale promise indexed, so the replacement
 * recovery joined a request whose response was already destined to be
 * discarded, and the repair never happened at all.
 */
const inFlight = new Map<string, Promise<void>>();

/** Pages one recovery will follow before settling for a partial repair. */
const RECOVERY_PAGE_LIMIT = 10;

/** Turn headers read to settle lifecycle after a gap. */
const LIFECYCLE_PAGE_LIMIT = 20;

/**
 * Fetches and merges one turn's persisted items.
 *
 * @param threadId - Conversation owning the turn
 * @param turnId - Turn to repair
 * @returns Resolves when the snapshot has been applied, or skipped as unusable
 */
export function recoverTurnItems(
  threadId: string,
  turnId: string,
): Promise<void> {
  // Both baselines are captured before the request goes out. The observation
  // counter decides which side of a conflict is newer; the epoch decides
  // whether this recovery still belongs to the current view of the thread.
  const baselineSeq = currentObservationSeq();
  const epoch = currentRecoveryEpoch(threadId);
  const key = `${threadId}:${turnId}:${epoch}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async () => {
    try {
      const items: Array<Record<string, unknown>> = [];
      let cursor: string | undefined;
      // Bounded on purpose. The endpoint reports an explicit incomplete outcome
      // when it stops early, and a partial repair is still worth applying — but
      // a turn whose items outrun this many pages is not something to keep
      // chasing while the user waits for the transcript to paint.
      for (let page = 0; page < RECOVERY_PAGE_LIMIT; page++) {
        const { data } = await threadsListTurnItems({
          path: { threadId, turnId },
          ...(cursor && { query: { cursor } }),
        });
        if (!data) break;
        items.push(...(data.items as Array<Record<string, unknown>>));
        // `complete` is the only completeness signal. A null cursor alone does
        // not mean the history ended — it can also mean paging is unavailable
        // or the response was malformed, and treating those as "that was all"
        // is how a truncated transcript starts looking authoritative.
        if (data.complete || !data.nextCursor) break;
        cursor = data.nextCursor;
      }
      if (items.length === 0) return;
      // Re-validate rather than trusting the pre-request check: the
      // conversation can be deleted, evicted or superseded while this is in
      // flight, and applying then would rebuild state the user discarded.
      if (currentRecoveryEpoch(threadId) !== epoch) return;
      const store = useTimelineStore.getState();
      if (!store.getThreadRuntime(threadId)) return;
      store.applyRecoveredTurnItemsForThread(
        threadId,
        turnId,
        items,
        baselineSeq,
      );
    } catch {
      // A failed read recovers nothing and must not claim otherwise. Leaving
      // the turn as-is keeps it eligible for the next attempt; the completed
      // turn top-up will also cover it once the turn finishes.
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}

/**
 * Reads recent history in page order, including holes between already-held
 * turns. The issue-time anchor prevents a new live row from hiding an older
 * gap. Paging is bounded; disconnected windows retain a real history cursor.
 * Only returned statuses can settle lifecycle: absence is never deletion.
 */
async function recoverTurnLifecycle(
  threadId: string,
  itemTargets: Set<string>,
  initialPage?: ThreadTurnsPageDto,
): Promise<void> {
  const epoch = currentRecoveryEpoch(threadId);
  const before = useTimelineStore.getState().getThreadRuntime(threadId);
  if (!before) return;
  const known = new Set(
    before.timeline.flatMap((entry) =>
      entry.kind === 'turn' ? [entry.turnId] : [],
    ),
  );
  try {
    const turns: ThreadTurnsPageDto['data'] = [];
    let cursor: string | null = null;
    for (let page = 0; page < RECOVERY_PAGE_LIMIT; page++) {
      const data: ThreadTurnsPageDto | undefined =
        page === 0 && initialPage
          ? initialPage
          : (
              await threadsListTurns({
                path: { threadId },
                query: {
                  itemsView: 'summary',
                  limit: LIFECYCLE_PAGE_LIMIT,
                  sortDirection: 'desc',
                  cursor: cursor ?? undefined,
                },
              })
            ).data;
      if (!data) return;
      if (currentRecoveryEpoch(threadId) !== epoch) return;
      const seen = new Set(turns.map((turn) => turn.id));
      turns.push(...data.data.filter((turn) => !seen.has(turn.id)));
      const previous: string | null = cursor;
      cursor = data.nextCursor;
      if (
        known.size === 0 ||
        data.data.some((turn) => known.has(turn.id)) ||
        !cursor ||
        cursor === previous ||
        data.data.length === 0
      )
        break;
    }
    const store = useTimelineStore.getState();
    const runtime = store.getThreadRuntime(threadId);
    if (!runtime || currentRecoveryEpoch(threadId) !== epoch) return;
    if (turns.length === 0) return;
    store.hydrateOpenedThread({
      threadId,
      turnsNewestFirst: turns,
      historyCursor: cursor,
      readOnlyReason: runtime.readOnlyReason,
      knownTurnIdsAtRead: known,
    });
    store.settleTurnLifecycleForThread(threadId, turns);
    const repairs: Promise<void>[] = [];
    for (const turn of turns.slice(0, LIFECYCLE_PAGE_LIMIT)) {
      // Older summary rows use the existing on-demand item top-up when viewed.
      // Summary suffices for older history on a first open. Turns missed from
      // an existing window and running turns also need their completed items.
      if (
        !itemTargets.has(turn.id) &&
        (turn.status === 'inProgress' ||
          (known.size > 0 && !known.has(turn.id)))
      ) {
        itemTargets.add(turn.id);
        repairs.push(recoverTurnItems(threadId, turn.id));
      }
    }
    await Promise.all(repairs);
  } catch {
    // Failure supplies no lifecycle/absence evidence. A subsequent open or
    // reconnect can retry; partially fetched header windows are not adopted.
  }
}

/**
 * Repairs a conversation after a disconnect.
 *
 * Every recovery baselined before the gap is superseded first: it was measured
 * against a state this client can no longer vouch for, and applying it on top
 * of post-gap truth would reintroduce the staleness the recovery exists to
 * remove.
 *
 * The active turn is always an item candidate, including when it completed
 * during the gap. Beyond that, any turn still holding an unfinished item is one
 * whose stream this client may have stopped receiving mid-item.
 *
 * @param threadId - Conversation to repair
 */
export async function recoverThreadAfterReconnect(
  threadId: string,
  initialPage?: ThreadTurnsPageDto,
): Promise<void> {
  const runtime = useTimelineStore.getState().getThreadRuntime(threadId);
  if (!runtime) return;

  supersedeRecovery(threadId);
  useTimelineStore.getState().setHistoryLoadingForThread(threadId, false);

  const targets = new Set<string>();
  if (runtime.activeTurnId) targets.add(runtime.activeTurnId);
  for (const entry of runtime.timeline) {
    if (entry.kind !== 'turn') continue;
    if (
      entry.items.some((item) => !item.completed) ||
      Object.values(entry.plan?.planTextByItemId ?? {}).some(
        (item) => !item.completed,
      )
    ) {
      targets.add(entry.turnId);
    }
  }
  const repairs = [...targets].map((turnId) =>
    recoverTurnItems(threadId, turnId),
  );
  // Runs alongside rather than after: the two repair independent facts, and
  // making lifecycle wait on item paging would keep a finished turn spinning
  // for the length of the slowest transcript repair.
  await Promise.all([
    ...repairs,
    recoverTurnLifecycle(threadId, targets, initialPage),
  ]);
}
