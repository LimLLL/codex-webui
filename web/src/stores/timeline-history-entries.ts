/** Conversation timeline history entries. */
import { type TimelineEntry, type TurnPlanState } from '../types/timeline';
import { type TurnDto } from '../generated/api';
import {
  normalizeThreadItem,
  type ThreadItemNormalization,
} from '../lib/thread-item-normalizer';
import { normalizeLiveTurnFailure } from '../lib/turn-failure';

/** Extracts persisted plan text from shared normalizer outcomes. */
export function normalizedPlan(
  items: ThreadItemNormalization[],
): TurnPlanState | undefined {
  // Hydration and later repair must use the same per-item representation.
  // `explanation` belongs to the structured plan tool, not the model's prose.
  // Nothing is held yet at hydration, so no baseline can be outranked.
  return mergePersistedPlan(undefined, items, -1);
}

/**
 * Folds persisted plan items into a turn's plan, per item.
 *
 * @param existing - Plan already held, possibly assembled from deltas
 * @param normalized - Normalized items from a persisted snapshot
 * @returns The merged plan, or the existing one when the snapshot has no plan
 */
export function mergePersistedPlan(
  existing: TurnPlanState | undefined,
  normalized: ThreadItemNormalization[],
  baselineSeq: number,
): TurnPlanState | undefined {
  const planItems = normalized.filter(
    (item): item is Extract<ThreadItemNormalization, { kind: 'plan' }> =>
      item.kind === 'plan' && Boolean(item.text.trim()),
  );
  if (planItems.length === 0) return existing;
  const planTextByItemId = { ...(existing?.planTextByItemId ?? {}) };
  for (const item of planItems) {
    const live = planTextByItemId[item.itemId];
    // The same authority table `selectPayload` applies to items. A terminal
    // observation made after the request went out cannot be known to this
    // snapshot, so it stands; otherwise the snapshot carries the whole
    // accumulated text and replaces whatever fragment was held.
    if (live?.completed && (live.observedSeq ?? 0) > baselineSeq) continue;
    planTextByItemId[item.itemId] = {
      text: item.text,
      completed: true,
      observedSeq: live?.observedSeq,
    };
  }
  return {
    explanation: existing?.explanation ?? null,
    steps: existing?.steps ?? [],
    planTextByItemId,
  };
}

/** Converts persisted turns into timeline entries. */
export function turnsToTimeline(turns: TurnDto[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const turn of turns) {
    const normalized = (turn.items ?? []).map((item, index) =>
      normalizeThreadItem(item, true, `${turn.id}:${index}`),
    );

    const userMsg = normalized.find(
      (
        item,
      ): item is Extract<ThreadItemNormalization, { kind: 'userMessage' }> =>
        item.kind === 'userMessage',
    );
    if (userMsg) {
      entries.push({
        kind: 'user',
        content: userMsg.message.text,
        turnId: turn.id,
        ...(userMsg.message.images.length > 0 && {
          images: userMsg.message.images,
        }),
      });
    }

    const plan = normalizedPlan(normalized);
    const turnItems = normalized.flatMap((item) =>
      item.kind === 'render' || item.kind === 'unknown' ? [item.item] : [],
    );

    // Retain lifecycle even for an empty full turn: late item events still
    // belong to that completed turn. Presentation filters contentless rows.
    const itemsView = turn.itemsView as
      | 'notLoaded'
      | 'summary'
      | 'full'
      | undefined;
    {
      entries.push({
        kind: 'turn',
        turnId: turn.id,
        plan,
        items: turnItems,
        completed: turn.status !== 'inProgress',
        ...(itemsView && { itemsView }),
      });
    }

    if (turn.status === 'failed' && turn.error) {
      entries.push({
        kind: 'turnFailure',
        turnId: turn.id,
        failure: normalizeLiveTurnFailure(turn.id, turn.error),
      });
    }
  }

  return entries;
}

/**
 * Collects every turn id already represented in a timeline.
 *
 * Must consider `user` entries as well as `turn` entries: a turn carrying only
 * a user message — one that was interrupted, or is still awaiting its first
 * item — produces a `user` entry and no `turn` entry at all. Reading turn ids
 * from `turn` entries alone therefore misses it, which lets a history page
 * re-insert that message on paging and makes an already-loaded page look new
 * on reopen.
 */
export function collectKnownTurnIds(timeline: TimelineEntry[]): Set<string> {
  const turnIds = new Set<string>();
  for (const entry of timeline) {
    if (entry.kind !== 'user' && entry.kind !== 'turn') continue;
    if (entry.turnId) turnIds.add(entry.turnId);
  }
  return turnIds;
}
