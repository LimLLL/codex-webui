/**
 * Repairs missed lifecycle and late items on open, reconnect, and app-server recovery.
 * Full history pages repair the turns they cover. Only retained turns outside that
 * window need per-turn reads; rendering or scrolling never initiates hydration.
 * Live observations made after a request outrank its persisted snapshot.
 */
import {
  threadsListTurnItems,
  threadsListTurns,
} from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import { currentObservationSeq } from '@/lib/turn-item-merge';
import type { ThreadTurnsPageDto } from '@/generated/api';
import { HISTORY_PAGE_SIZE } from './history-prefetch';
import {
  readTranscriptBookmark,
  readingAnchorTurnId,
} from './transcript-anchor';
import { assertFullHistoryPage } from './full-history';
import { getApiErrorMessage } from './api-error';
import i18n from '@/i18n';
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
const inFlight = new Map<string, Promise<boolean>>();

/** Pages one recovery will follow before settling for a partial repair. */
const RECOVERY_PAGE_LIMIT = 10;

/** Per-turn item reads issued at once, so one repair cannot saturate the socket. */
const RECOVERY_CONCURRENCY = 4;

/**
 * Retained completed turns re-read for late sub-agent items per recovery.
 *
 * Nothing marks these turns as repaired — late items may always arrive — so an
 * unbounded sweep is re-issued in full on every reconnect and grows with every
 * page of history the reader loads. Bounding it trades coverage of the oldest
 * retained turns for an open that does not wait on dozens of serial reads.
 */
const STALE_SWEEP_LIMIT = 8;

/**
 * Fetches and merges one turn's persisted items.
 *
 * @param threadId - Conversation owning the turn
 * @param turnId - Turn to repair
 * @returns Whether the complete persisted item list was recovered in the current epoch
 */
export function recoverTurnItems(
  threadId: string,
  turnId: string,
  reportError = true,
): Promise<boolean> {
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
      let complete = false;
      const cursors = new Set<string>();
      // Bounded on purpose. The endpoint reports an explicit incomplete outcome
      // when it stops early, and a partial repair is still worth applying — but
      // a turn whose items outrun this many pages is not something to keep
      // chasing while the user waits for the transcript to paint.
      for (let page = 0; page < RECOVERY_PAGE_LIMIT; page++) {
        const { data } = await threadsListTurnItems({
          path: { threadId, turnId },
          ...(cursor && { query: { cursor } }),
        });
        if (currentRecoveryEpoch(threadId) !== epoch) return false;
        if (!data)
          throw new Error(i18n.t('Failed to recover conversation items.'));
        items.push(...(data.items as Array<Record<string, unknown>>));
        // `complete` is the only completeness signal. A null cursor alone does
        // not mean the history ended — it can also mean paging is unavailable
        // or the response was malformed, and treating those as "that was all"
        // is how a truncated transcript starts looking authoritative.
        complete = data.complete;
        if (complete || !data.nextCursor || cursors.has(data.nextCursor)) break;
        cursor = data.nextCursor;
        cursors.add(cursor);
      }
      // Re-validate rather than trusting the pre-request check: the
      // conversation can be deleted, evicted or superseded while this is in
      // flight, and applying then would rebuild state the user discarded.
      if (currentRecoveryEpoch(threadId) !== epoch) return false;
      const store = useTimelineStore.getState();
      if (!store.getThreadRuntime(threadId)) return false;
      store.applyRecoveredTurnItemsForThread(
        threadId,
        turnId,
        items,
        baselineSeq,
      );
      if (!complete)
        throw new Error(
          i18n.t(
            'Conversation item recovery returned incomplete data. Retry refreshing history.',
          ),
        );
      return true;
    } catch (error) {
      if (reportError && currentRecoveryEpoch(threadId) === epoch)
        useTimelineStore.getState().setOpenStateForThread(threadId, {
          historyError: getApiErrorMessage(error),
          historyRequest: 'error',
        });
      return false;
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
  initialBaseline?: number,
): Promise<boolean> {
  const baselineSeq = initialPage
    ? (initialBaseline ?? 0)
    : currentObservationSeq();
  const epoch = currentRecoveryEpoch(threadId);
  const before = useTimelineStore.getState().getThreadRuntime(threadId);
  if (!before) return false;
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
                  itemsView: 'full',
                  limit: HISTORY_PAGE_SIZE,
                  sortDirection: 'desc',
                  cursor: cursor ?? undefined,
                },
              })
            ).data;
      if (!data)
        throw new Error(i18n.t('Failed to recover conversation history.'));
      assertFullHistoryPage(data);
      if (currentRecoveryEpoch(threadId) !== epoch) return false;
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
    if (!runtime || currentRecoveryEpoch(threadId) !== epoch) return false;
    store.hydrateOpenedThread({
      threadId,
      turnsNewestFirst: turns,
      historyCursor: cursor,
      readOnlyReason: runtime.readOnlyReason,
      knownTurnIdsAtRead: known,
    });
    store.settleTurnLifecycleForThread(threadId, turns);
    // These pages already carry full item lists. Apply recovery authority to
    // repair pre-gap live prefixes, then avoid a redundant per-turn request.
    for (const turn of turns) {
      itemTargets.delete(turn.id);
      store.applyRecoveredTurnItemsForThread(
        threadId,
        turn.id,
        turn.items as Array<Record<string, unknown>>,
        baselineSeq,
      );
    }
    return true;
  } catch (error) {
    // Retained full data remains readable, but failed recovery is visible.
    if (currentRecoveryEpoch(threadId) === epoch)
      useTimelineStore.getState().setOpenStateForThread(threadId, {
        historyError: getApiErrorMessage(error),
        historyRequest: 'error',
      });
    return false;
  }
}

/** Concurrent open/reconnect callers wait for the latest repair of the same conversation. */
const recovering = new Map<
  string,
  { latest: Promise<boolean>; callers: number }
>();

/**
 * Runs a replacement repair and reports the newest one's outcome to every caller.
 *
 * Each call does issue its own read, deliberately: a reconnect arriving during
 * an open carries post-gap truth that the open's pre-gap snapshot cannot, so
 * superseding is the correct resolution rather than joining. What is shared is
 * the *answer* — an open awaiting an older repair must not fail its loading
 * gate merely because a newer read replaced it, so callers keep following the
 * latest handle until it settles. Deletion is still rejected by thread epoch.
 */
export async function recoverThreadAfterReconnect(
  threadId: string,
  initialPage?: ThreadTurnsPageDto,
  initialBaseline?: number,
): Promise<boolean> {
  const task = runThreadRecovery(threadId, initialPage, initialBaseline);
  const batch = recovering.get(threadId) ?? { latest: task, callers: 0 };
  batch.latest = task;
  batch.callers++;
  recovering.set(threadId, batch);
  try {
    let observed = task;
    let complete = await observed;
    while (batch.latest !== observed) {
      observed = batch.latest;
      complete = await observed;
    }
    return complete;
  } finally {
    batch.callers--;
    if (batch.callers === 0) recovering.delete(threadId);
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
async function runThreadRecovery(
  threadId: string,
  initialPage?: ThreadTurnsPageDto,
  initialBaseline?: number,
): Promise<boolean> {
  const runtime = useTimelineStore.getState().getThreadRuntime(threadId);
  if (!runtime) return false;

  supersedeRecovery(threadId);
  const epoch = currentRecoveryEpoch(threadId);
  useTimelineStore.getState().setHistoryLoadingForThread(threadId, false);

  // Two target sets, because they answer to different evidence and carry
  // different consequences.
  //
  // `interrupted` holds turns this client can see are wrong: an item or plan
  // fragment that never terminated, plus the turn it believes is running. The
  // transcript stays visibly broken until they are repaired, so they block the
  // reveal and a failure among them is reported as an incomplete recovery.
  //
  // `stale` holds retained completed turns. A completed turn can still acquire
  // items — a sub-agent's `item/started`/`item/completed` pair arrives after
  // its parent's `turn/completed` — and a gap swallows those. But this is a
  // sweep over turns nothing indicates are wrong, so it is bounded and its
  // failures do not fail the open: one unreadable old turn must not replace a
  // perfectly readable transcript with an error screen, and the set would
  // otherwise grow with every page the reader loads and be re-read in full on
  // every single reconnect.
  const interrupted = new Set<string>();
  const stale: string[] = [];
  if (runtime.activeTurnId) interrupted.add(runtime.activeTurnId);
  for (const entry of runtime.timeline) {
    if (entry.kind !== 'turn') continue;
    if (
      entry.items.some((item) => !item.completed) ||
      Object.values(entry.plan?.planTextByItemId ?? {}).some(
        (item) => !item.completed,
      )
    )
      interrupted.add(entry.turnId);
    else if (entry.completed) stale.push(entry.turnId);
  }
  // Read full pages first, which settles lifecycle and removes covered item
  // targets; anything still listed was never reached by a page.
  // `recoverTurnLifecycle` removes whatever its pages already carried in full,
  // so what remains in the set is precisely what still needs its own read.
  const needsItemRead = new Set([...interrupted, ...stale]);
  const lifecycleComplete = await recoverTurnLifecycle(
    threadId,
    needsItemRead,
    initialPage,
    initialBaseline,
  );
  if (currentRecoveryEpoch(threadId) !== epoch) return false;
  // Newest first: a turn the reader just left is likelier to be both looked at
  // again and still gaining sub-agent output than one from hours ago.
  const sweep = stale
    .filter((turnId) => needsItemRead.has(turnId) && !interrupted.has(turnId))
    .reverse();
  const anchor = readTranscriptBookmark(threadId)?.anchor;
  const readingTurn = anchor ? readingAnchorTurnId(anchor) : null;
  const readingIndex = readingTurn ? sweep.indexOf(readingTurn) : -1;
  if (readingIndex > 0) sweep.unshift(...sweep.splice(readingIndex, 1));
  const dropped = Math.max(0, sweep.length - STALE_SWEEP_LIMIT);
  if (dropped > 0)
    console.info(
      `[thread-recovery] ${threadId}: late-item sweep bounded to ${STALE_SWEEP_LIMIT} of ${sweep.length} retained completed turns; ${dropped} not re-read`,
    );
  /** Runs a bounded queue; background outcomes never mutate first-page readiness. */
  const repairItems = async (
    targets: string[],
    reportError: boolean,
  ): Promise<boolean> => {
    const remaining = [...targets];
    let complete = true;
    await Promise.all(
      Array.from(
        { length: Math.min(RECOVERY_CONCURRENCY, remaining.length) },
        async () => {
          for (
            let turnId = remaining.shift();
            turnId !== undefined;
            turnId = remaining.shift()
          ) {
            if (currentRecoveryEpoch(threadId) !== epoch) return;
            if (!(await recoverTurnItems(threadId, turnId, reportError)))
              complete = false;
          }
        },
      ),
    );
    return complete;
  };
  const required = [...interrupted].filter((turnId) =>
    needsItemRead.has(turnId),
  );
  const itemsComplete = await repairItems(required, true);
  if (currentRecoveryEpoch(threadId) !== epoch) return false;
  // Launch only after required work, and deliberately do not await the sweep.
  // Its aggregate warning is separate from request/error state used by the gate.
  if (lifecycleComplete && itemsComplete)
    void repairItems(sweep.slice(0, STALE_SWEEP_LIMIT), false).then(
      (complete) => {
        if (complete || currentRecoveryEpoch(threadId) !== epoch) return;
        const store = useTimelineStore.getState();
        if (!store.getThreadRuntime(threadId)?.historyError)
          store.setOpenStateForThread(threadId, {
            historyError: i18n.t(
              'Some older messages could not be refreshed. Reopen the conversation to retry.',
            ),
          });
        console.warn(
          `[thread-recovery] ${threadId}: late-item sweep incomplete`,
        );
      },
    );
  return lifecycleComplete && itemsComplete;
}
