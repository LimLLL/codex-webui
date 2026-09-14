/** Conversation timeline failures. */
import { type TimelineEntry, type TurnFailure } from '../types/timeline';
import { mergeTurnFailure } from '../lib/turn-failure';
import { type ThreadRuntimeState } from './timeline-state';

/**
 * Folds failures hydrated before their turn existed into the page that now
 * carries that turn.
 *
 * Auxiliary error hydration covers every failed turn the conversation has,
 * including turns no page has loaded yet. Those failures have no turn to sit
 * beside, so they are parked at the end of the timeline. Loading the page that
 * owns one leaves a duplicate: the parked entry stranded far below, plus a
 * fresh one in its proper place.
 *
 * Parking them is still right — the alternative, treating a failure as evidence
 * its turn is loaded, would make the pager skip that turn's conversation
 * content entirely. So they are reconciled on arrival instead.
 *
 * The parked payload wins the merge: it comes from the structured turn-error
 * record, which carries misalignment detail the paged turn's own error field
 * does not. A parked failure whose page reports no error at all is relocated
 * rather than dropped — the record exists, and it belongs next to its turn.
 *
 * Ownership is decided from the fetched turns rather than from the entries they
 * produced. A turn whose items all normalize away — and whose own `error` field
 * is empty, which is exactly the case the structured record exists to cover —
 * contributes a `user` entry and nothing else, or no entry at all. Reading the
 * arriving ids off `turn` entries would leave that failure parked below the
 * newest turn permanently.
 *
 * @param prepended - Entries built from the newly loaded older page.
 * @param arrivingTurnIds - Ids of the turns in that page, oldest first.
 * @param existing - The timeline this page is being prepended to.
 * @returns Both lists, with parked duplicates absorbed into the new page.
 */
export function absorbStrandedFailures(
  prepended: TimelineEntry[],
  arrivingTurnIds: string[],
  existing: TimelineEntry[],
): { prepended: TimelineEntry[]; existing: TimelineEntry[] } {
  if (arrivingTurnIds.length === 0) return { prepended, existing };
  const arriving = new Set(arrivingTurnIds);

  const parked = new Map<string, TurnFailure>();
  const keptExisting = existing.filter((entry) => {
    if (entry.kind !== 'turnFailure' || !arriving.has(entry.turnId))
      return true;
    parked.set(entry.turnId, entry.failure);
    return false;
  });
  if (parked.size === 0) return { prepended, existing };

  // Merge into the page's own failure entries first, so a turn that reported
  // its error on both paths ends up with one entry rather than two.
  const merged: TimelineEntry[] = prepended.map((entry) => {
    if (entry.kind !== 'turnFailure') return entry;
    const carried = parked.get(entry.turnId);
    if (!carried) return entry;
    parked.delete(entry.turnId);
    return { ...entry, failure: mergeTurnFailure(entry.failure, carried) };
  });

  // Whatever is left had no counterpart in the page. Place it after the last
  // entry its own turn produced; failing that — a turn that produced none —
  // before the first entry of a later turn, so it still reads in order.
  const rankOf = new Map(arrivingTurnIds.map((id, index) => [id, index]));
  for (const [turnId, failure] of parked) {
    const entry: TimelineEntry = { kind: 'turnFailure', turnId, failure };
    let insertAt = -1;
    for (let i = merged.length - 1; i >= 0; i--) {
      const candidate = merged[i];
      if ('turnId' in candidate && candidate.turnId === turnId) {
        insertAt = i + 1;
        break;
      }
    }
    if (insertAt < 0) {
      const rank = rankOf.get(turnId) ?? Number.MAX_SAFE_INTEGER;
      insertAt = merged.findIndex((candidate) => {
        if (!('turnId' in candidate) || !candidate.turnId) return false;
        const candidateRank = rankOf.get(candidate.turnId);
        return candidateRank !== undefined && candidateRank > rank;
      });
    }
    if (insertAt < 0) merged.push(entry);
    else merged.splice(insertAt, 0, entry);
  }

  return { prepended: merged, existing: keptExisting };
}

/** Inserts or enriches a structured failure next to the turn it belongs to. */
export function upsertRuntimeTurnFailure(
  runtime: ThreadRuntimeState,
  failure: TurnFailure,
): ThreadRuntimeState {
  const existingIndex = runtime.timeline.findIndex(
    (entry) => entry.kind === 'turnFailure' && entry.turnId === failure.turnId,
  );
  if (existingIndex >= 0) {
    const existing = runtime.timeline[existingIndex];
    if (existing.kind !== 'turnFailure') return runtime;
    const timeline = [...runtime.timeline];
    timeline[existingIndex] = {
      ...existing,
      failure: mergeTurnFailure(existing.failure, failure),
    };
    return { ...runtime, timeline };
  }

  const entry: TimelineEntry = {
    kind: 'turnFailure',
    turnId: failure.turnId,
    failure,
  };
  const turnIndex = runtime.timeline.findIndex(
    (candidate) =>
      candidate.kind === 'turn' && candidate.turnId === failure.turnId,
  );
  if (turnIndex < 0) {
    return { ...runtime, timeline: [...runtime.timeline, entry] };
  }
  const timeline = [...runtime.timeline];
  timeline.splice(turnIndex + 1, 0, entry);
  return { ...runtime, timeline };
}
