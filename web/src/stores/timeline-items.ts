/** Conversation timeline items. */
import { ensureInteractionEntry } from '@/lib/interaction-timeline';
import {
  type TimelineEntry,
  type TurnItem,
  type TurnPlanState,
} from '../types/timeline';
import { type ApprovalRequest, type UserInputRequest } from '../types/approval';
import { normalizeThreadItem } from '../lib/thread-item-normalizer';
import {
  mergeRecoveredItems,
  nextObservationSeq,
} from '../lib/turn-item-merge';
import { type ThreadRuntimeState } from './timeline-state';
import { mergePersistedPlan } from './timeline-history-entries';

/** Ensures a turn entry exists in timeline for a given turnId (needed for request-only cards). */
export function ensureTurnEntry(
  timeline: TimelineEntry[],
  turnId: string,
): TimelineEntry[] {
  if (
    timeline.some((entry) => entry.kind === 'turn' && entry.turnId === turnId)
  ) {
    return timeline;
  }
  return [...timeline, { kind: 'turn', turnId, items: [], completed: false }];
}

/**
 * Binds a started turn to the optimistically appended user message.
 *
 * Messages are rendered before `turn/start` returns, so the newest unbound user
 * entry is the one this turn belongs to. Without the binding the message would
 * carry no turn id until the next hydration, and could not be branched.
 */
export function bindPendingUserMessage(
  timeline: TimelineEntry[],
  turnId: string,
): TimelineEntry[] {
  if (
    timeline.some((entry) => entry.kind === 'user' && entry.turnId === turnId)
  ) {
    return timeline;
  }
  const index = timeline.findLastIndex(
    (entry) => entry.kind === 'user' && entry.turnId === undefined,
  );
  if (index < 0) return timeline;

  const next = [...timeline];
  next[index] = { ...next[index], turnId } as TimelineEntry;
  return next;
}

/** After hydration, preserve turn entries for blocking request-only cards. */
export function ensureRequestTurnEntries(
  timeline: TimelineEntry[],
  approvals: Record<string, ApprovalRequest>,
  userInputs: Record<string, UserInputRequest>,
): TimelineEntry[] {
  const withApprovals = Object.values(approvals).reduce(
    (next, approval) =>
      approval.kind === 'permissions' || approval.kind === 'elicitation'
        ? ensureInteractionEntry(next, approval)
        : approval.turnId
          ? ensureTurnEntry(next, approval.turnId)
          : next,
    timeline,
  );
  return Object.values(userInputs).reduce(
    (next, request) => ensureTurnEntry(next, request.turnId),
    withApprovals,
  );
}

export function updateRuntimeCurrentTurn(
  runtime: ThreadRuntimeState,
  turnId: string,
  updater: (
    items: TurnItem[],
    completed: boolean,
  ) => { items: TurnItem[]; completed: boolean },
): ThreadRuntimeState {
  const idx = runtime.timeline.findIndex(
    (entry) => entry.kind === 'turn' && entry.turnId === turnId,
  );

  if (idx >= 0) {
    const entry = runtime.timeline[idx];
    if (entry.kind !== 'turn') return runtime;
    const result = updater(entry.items, entry.completed);
    const timeline = [...runtime.timeline];
    timeline[idx] = {
      ...entry,
      items: result.items,
      completed: result.completed,
    };
    return { ...runtime, timeline };
  }

  const result = updater([], false);
  return {
    ...runtime,
    timeline: [
      ...runtime.timeline,
      { kind: 'turn' as const, turnId, ...result },
    ],
  };
}

export function updateRuntimeTurnItem(
  runtime: ThreadRuntimeState,
  turnId: string,
  itemId: string,
  updater: (existing: TurnItem | undefined) => TurnItem,
): ThreadRuntimeState {
  return updateRuntimeCurrentTurn(runtime, turnId, (items, completed) => {
    const idx = items.findIndex((it) => it.itemId === itemId);
    if (idx >= 0) {
      const updated = [...items];
      updated[idx] = updater(updated[idx]);
      return { items: updated, completed };
    }
    return { items: [...items, updater(undefined)], completed };
  });
}

export interface PersistedItemsOptions {
  /** Observation counter captured when the request was issued. */
  baselineSeq: number;
  /** Whether the turn may be marked as holding every persisted item. */
  markFull: boolean;
}

/**
 * Folds a persisted item page into one turn under the shared authority rules.
 *
 * Shared by explicit full-item application and recovery because the merge itself
 * is identical; only whether the read establishes full detail differs. Both
 * paths use the same ordering and payload-selection rules.
 */
export function applyPersistedItems(
  runtime: ThreadRuntimeState,
  turnId: string,
  items: Array<Record<string, unknown>>,
  { baselineSeq, markFull }: PersistedItemsOptions,
): ThreadRuntimeState {
  const normalized = items.map((item, index) =>
    // Page-local ids must not collide with another turn's fallback ids.
    normalizeThreadItem(item, true, `${turnId}:${index}`),
  );
  const timeline = [...runtime.timeline];
  const turnIndex = timeline.findIndex(
    (entry) => entry.kind === 'turn' && entry.turnId === turnId,
  );
  const user = normalized.find((item) => item.kind === 'userMessage');
  // A turn adopted after reconnect can also have missed its prompt. Keep the
  // prompt before its response, preserving any optimistic user row already held.
  if (
    turnIndex >= 0 &&
    user?.kind === 'userMessage' &&
    !timeline.some((entry) => entry.kind === 'user' && entry.turnId === turnId)
  ) {
    timeline.splice(turnIndex, 0, {
      kind: 'user',
      turnId,
      content: user.message.text,
      ...(user.message.images.length > 0 && { images: user.message.images }),
    });
  }
  return {
    ...runtime,
    timeline: timeline.map((entry) => {
      if (entry.kind !== 'turn' || entry.turnId !== turnId) return entry;
      const persisted = normalized.flatMap((item) =>
        item.kind === 'render' || item.kind === 'unknown' ? [item.item] : [],
      );
      return {
        ...entry,
        items: mergeRecoveredItems(persisted, entry.items, { baselineSeq }),
        // Plan text is repaired per item, not per turn. Skipping the whole plan
        // whenever the turn already had one meant a plan truncated mid-stream
        // by a disconnect could never be repaired: the streamed prefix counted
        // as "already have it". Each persisted plan item carries its own whole
        // accumulated text, so it replaces that item's fragment and leaves
        // items this snapshot does not mention alone.
        plan: mergePersistedPlan(entry.plan, normalized, baselineSeq),
        ...(markFull && { itemsView: 'full' as const }),
      };
    }),
  };
}

/**
 * Writes one plan item's text into a turn, replacing whatever it held.
 *
 * @param runtime - Thread runtime to update
 * @param turnId - Turn owning the plan
 * @param itemId - Plan item whose text is authoritative
 * @param text - The whole accumulated text for that item
 * @returns The runtime with that plan item replaced, creating its turn if needed
 */
export function setRuntimePlanText(
  runtime: ThreadRuntimeState,
  turnId: string,
  itemId: string,
  text: string,
): ThreadRuntimeState {
  // The terminal event can be the first one seen after a disconnect.
  const timeline = [...ensureTurnEntry(runtime.timeline, turnId)];
  const idx = timeline.findIndex(
    (entry) => entry.kind === 'turn' && entry.turnId === turnId,
  );
  if (idx < 0) return runtime;
  const entry = timeline[idx];
  if (entry.kind !== 'turn') return runtime;
  const held = entry.plan?.planTextByItemId?.[itemId];
  if (held?.completed && held.text === text) return runtime;
  timeline[idx] = {
    ...entry,
    plan: {
      explanation: entry.plan?.explanation ?? null,
      steps: entry.plan?.steps ?? [],
      planTextByItemId: {
        ...(entry.plan?.planTextByItemId ?? {}),
        // A terminal plan payload carries the whole accumulated text, so this
        // is a replacement. Stamping it is what lets a later snapshot tell that
        // this was observed after the snapshot's request went out.
        [itemId]: {
          text,
          completed: true,
          observedSeq: nextObservationSeq(),
        },
      },
    },
  };
  return { ...runtime, timeline };
}

export function updateRuntimeDiff(
  runtime: ThreadRuntimeState,
  turnId: string,
  diff: string,
): ThreadRuntimeState {
  const timeline = runtime.timeline.map((entry) =>
    entry.kind === 'turn' && entry.turnId === turnId
      ? { ...entry, diff }
      : entry,
  );
  return { ...runtime, timeline };
}

export function updateRuntimePlan(
  runtime: ThreadRuntimeState,
  turnId: string,
  plan: TurnPlanState,
): ThreadRuntimeState {
  const idx = runtime.timeline.findIndex(
    (entry) => entry.kind === 'turn' && entry.turnId === turnId,
  );
  if (idx >= 0) {
    const entry = runtime.timeline[idx];
    if (entry.kind !== 'turn') return runtime;
    const timeline = [...runtime.timeline];
    timeline[idx] = {
      ...entry,
      plan: {
        ...plan,
        // A progress update owns steps/explanation, not model plan-item text.
        planTextByItemId: plan.planTextByItemId ?? entry.plan?.planTextByItemId,
      },
    };
    return { ...runtime, timeline };
  }
  return {
    ...runtime,
    timeline: [
      ...runtime.timeline,
      { kind: 'turn' as const, turnId, items: [], completed: false, plan },
    ],
  };
}
