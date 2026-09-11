/**
 * Reconciles a freshly fetched turn page against the timeline already on screen.
 *
 * Opening a thread used to replace the timeline outright whenever the returned
 * page was not wholly subsumed. Subscription and the open request run
 * concurrently, so on a refresh mid-turn the notifications that arrive while the
 * open is in flight were written into the timeline and then thrown away by the
 * response — re-creating the very gap the recovery pass exists to close.
 *
 * The rule is the same one the item merge follows: reconcile by identity, and
 * never let a coarser representation discard a finer one. Absence from a page
 * is not deletion.
 *
 * Reconciliation is done at TURN granularity, not row granularity. One turn
 * contributes several rows — the user message, the assistant turn, a failure —
 * and an earlier version of this file anchored on the turn id while matching on
 * `kind:turnId`. The two granularities disagreed exactly when a page carried a
 * row the live timeline lacked: the row counted as "already represented" for
 * anchoring and was then never emitted, so a refresh could drop the user's own
 * message; and a trailing group was re-emitted after every row sharing its
 * anchor turn, duplicating whole turns.
 */
import { mergeRecoveredItems } from '@/lib/turn-item-merge';
import type { TimelineEntry } from '@/types/timeline';

/** Detail levels ordered so the richer view can be kept. */
const VIEW_RANK: Record<string, number> = { notLoaded: 0, summary: 1, full: 2 };

/** Identity used for anchoring; entries without one cannot be reconciled. */
function entryTurnId(entry: TimelineEntry): string | null {
  return entry.kind === 'system' || entry.kind === 'interaction' ? null : (entry.turnId ?? null);
}

/**
 * Chooses the surviving entry for a row present in both lists.
 *
 * The page comes from persistence, so it may fill gaps and settle turn
 * lifecycle, but the live entry keeps anything it observed first.
 */
function selectEntry(page: TimelineEntry, live: TimelineEntry): TimelineEntry {
  if (page.kind !== 'turn' || live.kind !== 'turn') {
    // A user message already on screen can carry locally attached images and
    // optimistic text the page does not reproduce.
    return live;
  }
  const pageRank = VIEW_RANK[page.itemsView ?? 'notLoaded'] ?? 0;
  const liveRank = VIEW_RANK[live.itemsView ?? 'notLoaded'] ?? 0;
  return {
    ...live,
    // The page is a snapshot fetched at an unknown moment, so it cannot outrank
    // a terminal observation already held; it still repairs fragments.
    items: mergeRecoveredItems(page.items, live.items, { baselineSeq: -1 }),
    // Turn lifecycle only moves forward. Either side reporting completion is
    // enough; neither side reverts the other to running.
    completed: page.completed || live.completed,
    plan: live.plan ?? page.plan,
    diff: live.diff ?? page.diff,
    itemsView: liveRank >= pageRank ? live.itemsView : page.itemsView,
  };
}

/**
 * Merges the rows of one turn, keeping every row either side contributed.
 *
 * Rows are matched by kind, which is what distinguishes a turn's user message
 * from its assistant turn. A kind only the page has is inserted rather than
 * dropped — the page is durable history, and the live timeline may simply never
 * have received that notification.
 *
 * @param pageRows - That turn's rows from the fetched page, in page order
 * @param liveRows - That turn's rows already rendered, in live order
 * @returns The turn's rows in presentation order: prompt, response, then failure
 */
function reconcileTurnRows(
  pageRows: TimelineEntry[],
  liveRows: TimelineEntry[],
): TimelineEntry[] {
  const pageByKind = new Map<string, TimelineEntry>();
  for (const row of pageRows) pageByKind.set(row.kind, row);

  const liveKinds = new Set(liveRows.map((row) => row.kind));
  const merged = liveRows.map((row) => {
    const counterpart = pageByKind.get(row.kind);
    return counterpart ? selectEntry(counterpart, row) : row;
  });

  // Unlike overlapping command items, these rows have a known presentation
  // order. A recovered prompt belongs before its response even if the prompt
  // notification was missed. This does not change item order inside the turn.
  const extras = pageRows.filter((row) => !liveKinds.has(row.kind));
  const rowRank: Record<TimelineEntry['kind'], number> = {
    user: 0,
    turn: 1,
    turnFailure: 2,
    system: 3,
    interaction: 3,
  };
  return [...merged, ...extras].sort(
    (a, b) => rowRank[a.kind] - rowRank[b.kind],
  );
}

/**
 * Merges a chronological turn page into the chronological timeline held.
 *
 * Turns shared by both anchor the result. Turns only the page knows are placed
 * relative to the nearest shared anchor that preceded them, which is the only
 * ordering evidence available — the two views share no sequence.
 *
 * @param page - Entries built from the fetched page, oldest first
 * @param live - Entries currently rendered, oldest first
 * @returns One ordered timeline preserving both inputs' content
 */
export function reconcileTimeline(
  page: TimelineEntry[],
  live: TimelineEntry[],
): TimelineEntry[] {
  if (page.length === 0) return live;
  if (live.length === 0) return page;

  // Live rows grouped by turn, in first-appearance order. The group is emitted
  // once, at the position of its first row, so a turn cannot be split apart or
  // repeated by reconciliation.
  const liveGroups = new Map<string, TimelineEntry[]>();
  const liveOrder: Array<{ turnId: string | null; entry: TimelineEntry }> = [];
  for (const entry of live) {
    const turnId = entryTurnId(entry);
    if (turnId === null) {
      liveOrder.push({ turnId: null, entry });
      continue;
    }
    const group = liveGroups.get(turnId);
    if (group) {
      group.push(entry);
    } else {
      liveGroups.set(turnId, [entry]);
      liveOrder.push({ turnId, entry });
    }
  }

  // Page rows grouped the same way, plus the anchor each unknown turn follows.
  const pageGroups = new Map<string, TimelineEntry[]>();
  const trailing = new Map<string | null, string[]>();
  const seenUnknown = new Set<string>();
  let anchor: string | null = null;
  for (const entry of page) {
    const turnId = entryTurnId(entry);
    if (turnId === null) continue;
    const group = pageGroups.get(turnId);
    if (group) group.push(entry);
    else pageGroups.set(turnId, [entry]);

    if (liveGroups.has(turnId)) {
      anchor = turnId;
    } else if (!seenUnknown.has(turnId)) {
      seenUnknown.add(turnId);
      const bucket = trailing.get(anchor);
      if (bucket) bucket.push(turnId);
      else trailing.set(anchor, [turnId]);
    }
  }

  /** Emits every row of a page-only turn. */
  const emitPageTurns = (
    turnIds: string[] | undefined,
    out: TimelineEntry[],
  ) => {
    for (const turnId of turnIds ?? [])
      out.push(...(pageGroups.get(turnId) ?? []));
  };

  const merged: TimelineEntry[] = [];
  emitPageTurns(trailing.get(null), merged);
  for (const { turnId, entry } of liveOrder) {
    if (turnId === null) {
      merged.push(entry);
      continue;
    }
    const pageRows = pageGroups.get(turnId);
    const liveRows = liveGroups.get(turnId) ?? [entry];
    merged.push(
      ...(pageRows ? reconcileTurnRows(pageRows, liveRows) : liveRows),
    );
    emitPageTurns(trailing.get(turnId), merged);
  }
  return merged;
}

/**
 * Whether a page and the live timeline describe overlapping history.
 *
 * Without a shared turn the two are disconnected windows, and interleaving them
 * would preserve every entry while silently hiding the gap between them.
 */
export function sharesHistory(
  page: TimelineEntry[],
  live: TimelineEntry[],
): boolean {
  const liveTurnIds = new Set(
    live.map(entryTurnId).filter((id): id is string => id !== null),
  );
  return page.some((entry) => {
    const turnId = entryTurnId(entry);
    return turnId !== null && liveTurnIds.has(turnId);
  });
}
