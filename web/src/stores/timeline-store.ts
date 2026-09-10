/**
 * Zustand store for multi-thread chat timeline state.
 * The selected thread only controls visibility; live thread state is isolated by threadId.
 */
import { create } from 'zustand';
import { getSocket } from '../socket';
import { forgetThreadPolicy } from './thread-policy-store';
import type {
  TimelineEntry,
  TurnFailure,
  TurnItem,
  TurnPlanState,
} from '../types/timeline';
import type {
  ApprovalRequest,
  ResolvableApprovalDecision,
  UserInputRequest,
} from '../types/approval';
import type {
  PersistedTurnErrorDto,
  ThreadDto,
  TurnDto,
} from '../generated/api';
import type {
  ThreadTokenUsage,
  ThreadStatusType,
} from '../types/codex-notifications';
import {
  normalizeThreadItem,
  type ThreadItemNormalization,
} from '../lib/thread-item-normalizer';
import {
  mergeTurnFailure,
  normalizeLiveTurnFailure,
  normalizePersistedTurnFailure,
} from '../lib/turn-failure';
import {
  mergeRecoveredItems,
  nextObservationSeq,
} from '../lib/turn-item-merge';
import { reconcileTimeline, sharesHistory } from '../lib/timeline-reconcile';

const DEFAULT_MAX_IDLE_SUBSCRIPTIONS = 30;
const MIN_MAX_IDLE_SUBSCRIPTIONS = 5;
const MAX_MAX_IDLE_SUBSCRIPTIONS = 200;
const IDLE_SUBSCRIPTION_TTL_MS = 15 * 60 * 1000;

/** Keeps the store-side fallback aligned with the backend runtime setting. */
function normalizeMaxIdleSubscriptions(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_MAX_IDLE_SUBSCRIPTIONS;
  return Math.min(
    MAX_MAX_IDLE_SUBSCRIPTIONS,
    Math.max(MIN_MAX_IDLE_SUBSCRIPTIONS, Math.trunc(limit)),
  );
}

export type ThreadMode = 'live' | 'readOnly';

export interface ThreadRuntimeState {
  threadId: string;
  /** Working directory of this thread. */
  threadCwd: string | null;
  /** Display title, falling back to preview/id in UI. */
  threadTitle: string | null;
  /** Live threads are resumable; read-only threads are archived snapshots. */
  threadMode: ThreadMode;
  timeline: TimelineEntry[];
  loading: boolean;
  expandedReasoning: Set<string>;
  approvals: Record<string, ApprovalRequest>;
  userInputRequests: Record<string, UserInputRequest>;
  tokenUsageByTurn: Record<string, ThreadTokenUsage>;
  latestTokenUsage: ThreadTokenUsage | null;
  threadStatus: ThreadStatusType | null;
  activeTurnId: string | null;
  pendingResolvedRequestIds: Set<string>;
  hydrated: boolean;
  /**
   * Cursor for the next *older* page of turns, or null when history is complete.
   *
   * Opening a thread no longer materializes its whole history: the server
   * returns metadata plus the most recent page. Everything before that is
   * fetched on demand, so the timeline can be complete-but-truncated rather
   * than simply empty, and the two states must stay distinguishable.
   */
  historyCursor: string | null;
  /** True while an older-history page is being fetched. */
  historyLoading: boolean;
  /**
   * Why this thread cannot be written to, or null when it is writable.
   *
   * Only one app-server process may hold a paginated thread open for writing.
   * Losing that race is not a failure to open — the history is still readable —
   * so it degrades to a read-only view that says why rather than an error.
   */
  readOnlyReason: string | null;
  /**
   * True once this conversation is known to have been destroyed elsewhere.
   *
   * The transcript is deliberately kept — see the `thread/deleted` handler — but
   * keeping it must not leave the conversation writable: every send would fail
   * against a thread that no longer exists. Distinct from
   * {@link readOnlyReason} because the cause and the remedy differ, and telling
   * a user their deleted conversation is "open in another client" is worse than
   * saying nothing.
   */
  deletedRemotely: boolean;
  /** Millisecond timestamp for LRU-style idle subscription cleanup. */
  lastActivityAt: number;
}

interface ThreadRuntimeInput {
  threadId: string;
  cwd?: string | null;
  title?: string | null;
  mode?: ThreadMode;
}

/** Extracts persisted plan text from shared normalizer outcomes. */
function normalizedPlan(
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
function mergePersistedPlan(
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
function turnsToTimeline(turns: TurnDto[]): TimelineEntry[] {
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

    // A summary turn may look empty here purely because app-server withheld
    // its reasoning and plan items, so it still needs an entry to hang the
    // on-demand top-up off.
    const itemsView = turn.itemsView as
      | 'notLoaded'
      | 'summary'
      | 'full'
      | undefined;
    if (turnItems.length > 0 || plan || itemsView === 'summary') {
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
function collectKnownTurnIds(timeline: TimelineEntry[]): Set<string> {
  const turnIds = new Set<string>();
  for (const entry of timeline) {
    if (entry.kind !== 'user' && entry.kind !== 'turn') continue;
    if (entry.turnId) turnIds.add(entry.turnId);
  }
  return turnIds;
}

function createRuntime(input: ThreadRuntimeInput): ThreadRuntimeState {
  return {
    threadId: input.threadId,
    threadCwd: input.cwd ?? null,
    threadTitle: input.title ?? null,
    threadMode: input.mode ?? 'live',
    timeline: [],
    loading: false,
    expandedReasoning: new Set<string>(),
    approvals: {},
    userInputRequests: {},
    tokenUsageByTurn: {},
    latestTokenUsage: null,
    threadStatus: null,
    activeTurnId: null,
    pendingResolvedRequestIds: new Set<string>(),
    hydrated: false,
    historyCursor: null,
    historyLoading: false,
    readOnlyReason: null,
    deletedRemotely: false,
    lastActivityAt: Date.now(),
  };
}

function runtimeFromSelected(state: TimelineState): ThreadRuntimeState | null {
  if (!state.threadId) return null;
  return {
    threadId: state.threadId,
    threadCwd: state.threadCwd,
    threadTitle: state.threadTitle,
    threadMode: state.threadMode,
    timeline: state.timeline,
    loading: state.loading,
    expandedReasoning: state.expandedReasoning,
    approvals: state.approvals,
    userInputRequests: state.userInputRequests,
    tokenUsageByTurn: state.tokenUsageByTurn,
    latestTokenUsage: state.latestTokenUsage,
    threadStatus: state.threadStatus,
    activeTurnId: state.activeTurnId,
    pendingResolvedRequestIds: state.pendingResolvedRequestIds,
    hydrated: true,
    historyCursor: state.historyCursor,
    historyLoading: state.historyLoading,
    readOnlyReason: state.readOnlyReason,
    deletedRemotely: state.deletedRemotely,
    lastActivityAt: state.lastActivityAt,
  };
}

function readRuntime(
  state: TimelineState,
  threadId: string,
): ThreadRuntimeState | null {
  if (state.threadId === threadId) return runtimeFromSelected(state);
  return state.threadsById[threadId] ?? null;
}

function selectedFields(
  runtime: ThreadRuntimeState | null,
): Partial<TimelineState> {
  if (!runtime) {
    return {
      threadId: null,
      threadCwd: null,
      threadTitle: null,
      threadMode: 'live',
      timeline: [],
      loading: false,
      expandedReasoning: new Set<string>(),
      approvals: {},
      userInputRequests: {},
      tokenUsageByTurn: {},
      latestTokenUsage: null,
      threadStatus: null,
      activeTurnId: null,
      pendingResolvedRequestIds: new Set<string>(),
      historyCursor: null,
      historyLoading: false,
      readOnlyReason: null,
      deletedRemotely: false,
      lastActivityAt: 0,
    };
  }
  return {
    threadId: runtime.threadId,
    threadCwd: runtime.threadCwd,
    threadTitle: runtime.threadTitle,
    threadMode: runtime.threadMode,
    timeline: runtime.timeline,
    loading: runtime.loading,
    expandedReasoning: runtime.expandedReasoning,
    approvals: runtime.approvals,
    userInputRequests: runtime.userInputRequests,
    tokenUsageByTurn: runtime.tokenUsageByTurn,
    latestTokenUsage: runtime.latestTokenUsage,
    threadStatus: runtime.threadStatus,
    activeTurnId: runtime.activeTurnId,
    pendingResolvedRequestIds: runtime.pendingResolvedRequestIds,
    historyCursor: runtime.historyCursor,
    historyLoading: runtime.historyLoading,
    readOnlyReason: runtime.readOnlyReason,
    deletedRemotely: runtime.deletedRemotely,
    lastActivityAt: runtime.lastActivityAt,
  };
}

function persistSelectedRuntime(
  state: TimelineState,
): Record<string, ThreadRuntimeState> {
  const selected = runtimeFromSelected(state);
  if (!selected) return state.threadsById;
  return { ...state.threadsById, [selected.threadId]: selected };
}

function hasPendingApproval(runtime: ThreadRuntimeState | null): boolean {
  if (!runtime) return false;
  const flagBlocked =
    runtime.threadStatus?.type === 'active' &&
    runtime.threadStatus.activeFlags.includes('waitingOnApproval');
  const cardBlocked = Object.values(runtime.approvals).some(
    (approval) => approval.status === 'pending',
  );
  return flagBlocked || cardBlocked;
}

function hasPendingUserInput(runtime: ThreadRuntimeState | null): boolean {
  if (!runtime) return false;
  return Object.values(runtime.userInputRequests).some(
    (request) => request.status === 'pending',
  );
}

function touchRuntime(runtime: ThreadRuntimeState): ThreadRuntimeState {
  return { ...runtime, lastActivityAt: Date.now() };
}

function isSafeToCleanupIdleRuntime(
  runtime: ThreadRuntimeState | null,
  selectedThreadId: string | null,
): runtime is ThreadRuntimeState {
  return Boolean(
    runtime &&
    runtime.threadId !== selectedThreadId &&
    !runtime.loading &&
    !runtime.activeTurnId &&
    runtime.pendingResolvedRequestIds.size === 0 &&
    runtime.threadStatus?.type !== 'active' &&
    !hasPendingApproval(runtime) &&
    !hasPendingUserInput(runtime),
  );
}

function compareIdleCleanupCandidates(
  now: number,
  a: { lastActivityAt: number },
  b: { lastActivityAt: number },
): number {
  const aExpired = now - a.lastActivityAt >= IDLE_SUBSCRIPTION_TTL_MS;
  const bExpired = now - b.lastActivityAt >= IDLE_SUBSCRIPTION_TTL_MS;
  if (aExpired !== bExpired) return aExpired ? -1 : 1;
  return a.lastActivityAt - b.lastActivityAt;
}

/** Ensures a turn entry exists in timeline for a given turnId (needed for request-only cards). */
function ensureTurnEntry(
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
function bindPendingUserMessage(
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
function ensureRequestTurnEntries(
  timeline: TimelineEntry[],
  approvals: Record<string, ApprovalRequest>,
  userInputs: Record<string, UserInputRequest>,
): TimelineEntry[] {
  const withApprovals = Object.values(approvals).reduce(
    (next, approval) => ensureTurnEntry(next, approval.turnId),
    timeline,
  );
  return Object.values(userInputs).reduce(
    (next, request) => ensureTurnEntry(next, request.turnId),
    withApprovals,
  );
}

function updateRuntimeCurrentTurn(
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

function updateRuntimeTurnItem(
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
function absorbStrandedFailures(
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
function upsertRuntimeTurnFailure(
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

interface PersistedItemsOptions {
  /** Observation counter captured when the request was issued. */
  baselineSeq: number;
  /** Whether to refuse turns that are not sitting at the cheap `summary` view. */
  requireSummaryView: boolean;
  /** Whether the turn may be marked as holding every persisted item. */
  markFull: boolean;
}

/**
 * Folds a persisted item page into one turn under the shared authority rules.
 *
 * Shared by the completed-turn top-up and by recovery because the merge itself
 * is identical; only the preconditions and whether the turn may be declared
 * complete differ, and encoding those as flags keeps one implementation of the
 * ordering and payload-selection rules.
 */
function applyPersistedItems(
  runtime: ThreadRuntimeState,
  turnId: string,
  items: Array<Record<string, unknown>>,
  { baselineSeq, requireSummaryView, markFull }: PersistedItemsOptions,
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
      if (requireSummaryView && entry.itemsView !== 'summary') return entry;
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
function setRuntimePlanText(
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

function updateRuntimeDiff(
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

function updateRuntimePlan(
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

interface TimelineState {
  selectedThreadId: string | null;
  threadsById: Record<string, ThreadRuntimeState>;
  subscribedThreadIds: Set<string>;
  maxIdleSubscriptions: number;

  threadId: string | null;
  threadCwd: string | null;
  threadTitle: string | null;
  threadMode: ThreadMode;
  timeline: TimelineEntry[];
  loading: boolean;
  expandedReasoning: Set<string>;
  approvals: Record<string, ApprovalRequest>;
  userInputRequests: Record<string, UserInputRequest>;
  tokenUsageByTurn: Record<string, ThreadTokenUsage>;
  latestTokenUsage: ThreadTokenUsage | null;
  threadStatus: ThreadStatusType | null;
  activeTurnId: string | null;
  pendingResolvedRequestIds: Set<string>;
  historyCursor: string | null;
  historyLoading: boolean;
  readOnlyReason: string | null;
  deletedRemotely: boolean;
  lastActivityAt: number;

  ensureThreadState: (input: ThreadRuntimeInput) => void;
  selectThread: (threadId: string | null) => void;
  resubscribeAll: () => void;
  unsubscribeThread: (threadId: string) => void;
  forgetThreads: (threadIds: string[]) => void;
  setMaxIdleSubscriptions: (limit: number) => void;
  cleanupIdleThreadSubscriptions: (limit?: number) => void;
  getThreadTitle: (threadId: string) => string;
  getThreadRuntime: (threadId: string) => ThreadRuntimeState | null;
  isThreadLoading: (threadId: string) => boolean;
  hasPendingApproval: (threadId: string) => boolean;

  setActiveThread: (
    threadId: string,
    cwd?: string | null,
    title?: string | null,
  ) => void;
  setReadOnlyThread: (thread: ThreadDto) => void;
  clearThread: () => void;
  hydrateTimeline: (turns: TurnDto[], cwd?: string | null) => void;
  setThreadTitle: (title: string | null) => void;
  addUserMessage: (text: string, images?: string[]) => void;
  addSystemError: (message: string) => void;
  addSystemMessage: (
    message: string,
    severity?: 'info' | 'warning' | 'error',
  ) => void;
  upsertTurnFailure: (failure: TurnFailure) => void;

  toggleReasoning: (itemId: string) => void;
  updateCurrentTurn: (
    turnId: string,
    updater: (
      items: TurnItem[],
      completed: boolean,
    ) => { items: TurnItem[]; completed: boolean },
  ) => void;
  updateTurnItem: (
    turnId: string,
    itemId: string,
    updater: (existing: TurnItem | undefined) => TurnItem,
  ) => void;
  updateTurnDiff: (turnId: string, diff: string) => void;
  updateTurnPlan: (turnId: string, plan: TurnPlanState) => void;
  appendPlanDelta: (turnId: string, itemId: string, delta: string) => void;
  setLoading: (loading: boolean) => void;
  expandReasoning: (itemId: string) => void;
  collapseReasoning: (itemId: string) => void;
  addApproval: (approval: ApprovalRequest) => void;
  addUserInputRequest: (request: UserInputRequest) => void;
  resolveApproval: (
    requestId: string | number,
    decision: ResolvableApprovalDecision,
  ) => void;
  resolveUserInputRequest: (requestId: string | number) => void;
  setTokenUsage: (turnId: string, usage: ThreadTokenUsage) => void;
  setThreadStatus: (status: ThreadStatusType | null) => void;
  setActiveTurnId: (turnId: string | null) => void;
  clearActiveTurn: () => void;
  hydrateTokenUsage: (
    turns: Array<{ turnId: string; usage: ThreadTokenUsage }>,
  ) => void;
  hydrateTurnDiffs: (turns: Array<{ turnId: string; diff: string }>) => void;
  resolveApprovalByRequestId: (requestId: string | number) => void;

  hydrateTimelineForThread: (
    threadId: string,
    turns: TurnDto[],
    cwd?: string | null,
  ) => void;
  hydrateOpenedThread: (params: {
    threadId: string;
    turnsNewestFirst: TurnDto[];
    historyCursor: string | null;
    readOnlyReason: string | null;
    cwd?: string | null;
  }) => void;
  prependHistoryForThread: (
    threadId: string,
    turnsNewestFirst: TurnDto[],
    nextCursor: string | null,
  ) => void;
  setHistoryLoadingForThread: (threadId: string, loading: boolean) => void;
  markThreadDeletedRemotely: (threadId: string, message: string) => void;
  hydrateTokenUsageForThread: (
    threadId: string,
    turns: Array<{ turnId: string; usage: ThreadTokenUsage }>,
  ) => void;
  hydrateTurnDiffsForThread: (
    threadId: string,
    turns: Array<{ turnId: string; diff: string }>,
  ) => void;
  hydrateTurnErrorsForThread: (
    threadId: string,
    errors: PersistedTurnErrorDto[],
  ) => void;
  updateCurrentTurnForThread: (
    threadId: string,
    turnId: string,
    updater: (
      items: TurnItem[],
      completed: boolean,
    ) => { items: TurnItem[]; completed: boolean },
  ) => void;
  updateTurnItemForThread: (
    threadId: string,
    turnId: string,
    itemId: string,
    updater: (existing: TurnItem | undefined) => TurnItem,
  ) => void;
  /** Tops a completed summary turn up with the full set fetched on demand. */
  applyFullTurnItemsForThread: (
    threadId: string,
    turnId: string,
    items: Array<Record<string, unknown>>,
  ) => void;
  /**
   * Repairs a turn from persisted items without declaring its history complete.
   *
   * Used for a turn that is still running and for turns repaired after a
   * reconnect, where more items may still arrive.
   */
  applyRecoveredTurnItemsForThread: (
    threadId: string,
    turnId: string,
    items: Array<Record<string, unknown>>,
    baselineSeq: number,
  ) => void;
  /**
   * Settles turn lifecycle from freshly read turn headers.
   *
   * Items and lifecycle are separate facts on separate notifications, so
   * repairing a transcript after a disconnect does not repair the spinner. Only
   * turns the headers actually name are touched, and only forwards.
   */
  settleTurnLifecycleForThread: (
    threadId: string,
    turns: Array<{ id: string; status: TurnDto['status'] }>,
  ) => void;
  updateTurnDiffForThread: (
    threadId: string,
    turnId: string,
    diff: string,
  ) => void;
  updateTurnPlanForThread: (
    threadId: string,
    turnId: string,
    plan: TurnPlanState,
  ) => void;
  appendPlanDeltaForThread: (
    threadId: string,
    turnId: string,
    itemId: string,
    delta: string,
  ) => void;
  /**
   * Replaces one plan item's text with its authoritative accumulated value.
   *
   * Plan text streams as deltas like any other item, so a fragment missed
   * during a disconnect leaves a truncated plan on screen. The terminal payload
   * carries the whole text rather than a tail, which makes repair a
   * replacement — appending it would duplicate everything received so far.
   */
  setPlanTextForThread: (
    threadId: string,
    turnId: string,
    itemId: string,
    text: string,
  ) => void;
  setLoadingForThread: (threadId: string, loading: boolean) => void;
  addApprovalForThread: (threadId: string, approval: ApprovalRequest) => void;
  addUserInputRequestForThread: (
    threadId: string,
    request: UserInputRequest,
  ) => void;
  resolveApprovalForThread: (
    threadId: string,
    requestId: string | number,
    decision: ResolvableApprovalDecision,
  ) => void;
  resolveUserInputRequestForThread: (
    threadId: string,
    requestId: string | number,
  ) => void;
  setTokenUsageForThread: (
    threadId: string,
    turnId: string,
    usage: ThreadTokenUsage,
  ) => void;
  setThreadStatusForThread: (
    threadId: string,
    status: ThreadStatusType | null,
  ) => void;
  setActiveTurnIdForThread: (threadId: string, turnId: string | null) => void;
  clearActiveTurnForThread: (threadId: string) => void;
  addSystemMessageForThread: (
    threadId: string,
    message: string,
    severity?: 'info' | 'warning' | 'error',
    turnId?: string,
  ) => void;
  addSystemErrorForThread: (threadId: string, message: string) => void;
  upsertTurnFailureForThread: (threadId: string, failure: TurnFailure) => void;
  setThreadTitleForThread: (threadId: string, title: string | null) => void;
  resolveApprovalByRequestIdForThread: (
    threadId: string,
    requestId: string | number,
  ) => void;
}

export const useTimelineStore = create<TimelineState>((set, get) => {
  const applyThreadUpdate = (
    threadId: string,
    updater: (runtime: ThreadRuntimeState) => ThreadRuntimeState,
  ) => {
    set((state) => {
      const base = readRuntime(state, threadId) ?? createRuntime({ threadId });
      const runtime = touchRuntime(updater(base));
      const threadsById = {
        ...persistSelectedRuntime(state),
        [threadId]: runtime,
      };
      const patch: Partial<TimelineState> = { threadsById };
      if (state.threadId === threadId)
        Object.assign(patch, selectedFields(runtime));
      return patch;
    });
  };

  const selectedThread = (): string | null => get().threadId;

  return {
    selectedThreadId: null,
    threadsById: {},
    subscribedThreadIds: new Set<string>(),
    maxIdleSubscriptions: DEFAULT_MAX_IDLE_SUBSCRIPTIONS,

    threadId: null,
    threadCwd: null,
    threadTitle: null,
    threadMode: 'live',
    timeline: [],
    loading: false,
    expandedReasoning: new Set<string>(),
    approvals: {},
    userInputRequests: {},
    tokenUsageByTurn: {},
    latestTokenUsage: null,
    threadStatus: null,
    activeTurnId: null,
    pendingResolvedRequestIds: new Set(),
    historyCursor: null,
    historyLoading: false,
    readOnlyReason: null,
    deletedRemotely: false,
    lastActivityAt: 0,

    ensureThreadState: (input) => {
      set((state) => {
        const existing = readRuntime(state, input.threadId);
        if (existing) return {};
        return {
          threadsById: {
            ...persistSelectedRuntime(state),
            [input.threadId]: createRuntime(input),
          },
        };
      });
    },

    selectThread: (threadId) => {
      set((state) => {
        const threadsById = persistSelectedRuntime(state);
        if (!threadId) {
          return {
            ...selectedFields(null),
            selectedThreadId: null,
            threadsById,
          };
        }
        const runtime = touchRuntime(
          threadsById[threadId] ?? createRuntime({ threadId }),
        );
        return {
          ...selectedFields(runtime),
          selectedThreadId: threadId,
          threadsById: { ...threadsById, [threadId]: runtime },
        };
      });
    },

    resubscribeAll: () => {
      const socket = getSocket();
      for (const threadId of get().subscribedThreadIds) {
        socket.emit('thread.subscribe', { threadId });
      }
    },

    unsubscribeThread: (threadId) => {
      getSocket().emit('thread.unsubscribe', { threadId });
      set((state) => {
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        subscribedThreadIds.delete(threadId);
        return { subscribedThreadIds };
      });
    },

    /**
     * Drops every trace of threads that no longer exist.
     *
     * `unsubscribeThread` only leaves the socket room; the runtime survives in
     * `threadsById` and would be handed straight back to a deep link or a back
     * navigation to a deleted thread, showing content for a conversation that
     * is gone. The selected runtime needs special care: it lives in the
     * top-level fields, and the usual `selectThread(null)` path persists it into
     * `threadsById` on the way out — which would resurrect what we are deleting.
     *
     * @param threadIds - Threads that were destroyed
     */
    forgetThreads: (threadIds) => {
      const doomed = new Set(threadIds);
      if (doomed.size === 0) return;

      const socket = getSocket();
      const subscribed = get().subscribedThreadIds;
      for (const threadId of doomed) {
        if (subscribed.has(threadId)) {
          socket.emit('thread.unsubscribe', { threadId });
        }
      }

      set((state) => {
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        for (const threadId of doomed) subscribedThreadIds.delete(threadId);

        const selectedDoomed =
          state.selectedThreadId !== null && doomed.has(state.selectedThreadId);
        const threadsById = selectedDoomed
          ? { ...state.threadsById }
          : persistSelectedRuntime(state);
        for (const threadId of doomed) delete threadsById[threadId];

        return selectedDoomed
          ? {
              ...selectedFields(null),
              selectedThreadId: null,
              threadsById,
              subscribedThreadIds,
            }
          : { threadsById, subscribedThreadIds };
      });
    },

    setMaxIdleSubscriptions: (limit) => {
      const maxIdleSubscriptions = normalizeMaxIdleSubscriptions(limit);
      set({ maxIdleSubscriptions });
      get().cleanupIdleThreadSubscriptions(maxIdleSubscriptions);
    },

    cleanupIdleThreadSubscriptions: (limit) => {
      const maxIdleSubscriptions = normalizeMaxIdleSubscriptions(
        limit ?? get().maxIdleSubscriptions,
      );
      const evictedThreadIds: string[] = [];

      set((state) => {
        const candidates: Array<{ threadId: string; lastActivityAt: number }> =
          [];
        for (const threadId of state.subscribedThreadIds) {
          const runtime = readRuntime(state, threadId);
          if (isSafeToCleanupIdleRuntime(runtime, state.threadId)) {
            candidates.push({
              threadId,
              lastActivityAt: runtime.lastActivityAt,
            });
          }
        }

        if (candidates.length <= maxIdleSubscriptions) return {};

        const now = Date.now();
        candidates.sort((a, b) => compareIdleCleanupCandidates(now, a, b));
        const evictCount = candidates.length - maxIdleSubscriptions;
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        const threadsById = { ...persistSelectedRuntime(state) };

        for (const candidate of candidates.slice(0, evictCount)) {
          subscribedThreadIds.delete(candidate.threadId);
          delete threadsById[candidate.threadId];
          evictedThreadIds.push(candidate.threadId);
        }

        return { subscribedThreadIds, threadsById };
      });

      const socket = getSocket();
      for (const threadId of evictedThreadIds) {
        forgetThreadPolicy(threadId);
        socket.emit('thread.unsubscribe', { threadId });
      }
    },

    getThreadTitle: (threadId) => {
      const runtime = readRuntime(get(), threadId);
      return runtime?.threadTitle ?? threadId.slice(0, 8);
    },

    getThreadRuntime: (threadId) => readRuntime(get(), threadId),
    isThreadLoading: (threadId) =>
      readRuntime(get(), threadId)?.loading ?? false,
    hasPendingApproval: (threadId) =>
      hasPendingApproval(readRuntime(get(), threadId)),

    setActiveThread: (threadId, cwd, title) => {
      get().ensureThreadState({ threadId, cwd, title, mode: 'live' });
      get().selectThread(threadId);
      getSocket().emit('thread.subscribe', { threadId });
      set((state) => ({
        subscribedThreadIds: new Set(state.subscribedThreadIds).add(threadId),
      }));
      get().cleanupIdleThreadSubscriptions();
    },

    setReadOnlyThread: (thread) => {
      const title = thread.name ?? thread.preview ?? null;
      get().unsubscribeThread(thread.id);
      get().ensureThreadState({
        threadId: thread.id,
        cwd: thread.cwd,
        title,
        mode: 'readOnly',
      });
      // The failed writable open creates a live runtime before this degraded
      // path runs. `ensureThreadState` intentionally preserves existing state,
      // so the mode must be changed explicitly before selecting the snapshot.
      //
      // The timeline is deliberately untouched here. History now arrives as a
      // page through `hydrateOpenedThread`, which refuses to shrink a transcript
      // the user has already paged backwards through; seeding an empty timeline
      // first would discard those earlier pages and defeat that guard.
      applyThreadUpdate(thread.id, (runtime) => ({
        ...runtime,
        threadMode: 'readOnly',
      }));
      get().selectThread(thread.id);
    },

    clearThread: () => get().selectThread(null),

    hydrateTimeline: (turns, cwd) => {
      const threadId = selectedThread();
      if (threadId) get().hydrateTimelineForThread(threadId, turns, cwd);
    },

    setThreadTitle: (title) => {
      const threadId = selectedThread();
      if (threadId) get().setThreadTitleForThread(threadId, title);
    },

    addUserMessage: (text, images) => {
      const threadId = selectedThread();
      if (!threadId) return;
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: [
          ...runtime.timeline,
          {
            kind: 'user' as const,
            content: text,
            ...(images?.length && { images }),
          },
        ],
        loading: true,
      }));
    },

    addSystemError: (message) => {
      const threadId = selectedThread();
      if (threadId) get().addSystemErrorForThread(threadId, message);
    },

    addSystemMessage: (message, severity = 'info') => {
      const threadId = selectedThread();
      if (threadId)
        get().addSystemMessageForThread(threadId, message, severity);
    },

    upsertTurnFailure: (failure) => {
      const threadId = selectedThread();
      if (threadId) get().upsertTurnFailureForThread(threadId, failure);
    },

    toggleReasoning: (itemId) => {
      const threadId = selectedThread();
      if (!threadId) return;
      applyThreadUpdate(threadId, (runtime) => {
        const expandedReasoning = new Set(runtime.expandedReasoning);
        if (expandedReasoning.has(itemId)) expandedReasoning.delete(itemId);
        else expandedReasoning.add(itemId);
        return { ...runtime, expandedReasoning };
      });
    },

    updateCurrentTurn: (turnId, updater) => {
      const threadId = selectedThread();
      if (threadId) get().updateCurrentTurnForThread(threadId, turnId, updater);
    },

    updateTurnItem: (turnId, itemId, updater) => {
      const threadId = selectedThread();
      if (threadId)
        get().updateTurnItemForThread(threadId, turnId, itemId, updater);
    },

    updateTurnDiff: (turnId, diff) => {
      const threadId = selectedThread();
      if (threadId) get().updateTurnDiffForThread(threadId, turnId, diff);
    },

    updateTurnPlan: (turnId, plan) => {
      const threadId = selectedThread();
      if (threadId) get().updateTurnPlanForThread(threadId, turnId, plan);
    },

    appendPlanDelta: (turnId, itemId, delta) => {
      const threadId = selectedThread();
      if (threadId)
        get().appendPlanDeltaForThread(threadId, turnId, itemId, delta);
    },

    setLoading: (loading) => {
      const threadId = selectedThread();
      if (threadId) get().setLoadingForThread(threadId, loading);
    },

    expandReasoning: (itemId) => {
      const threadId = selectedThread();
      if (!threadId) return;
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        expandedReasoning: new Set(runtime.expandedReasoning).add(itemId),
      }));
    },

    collapseReasoning: (itemId) => {
      const threadId = selectedThread();
      if (!threadId) return;
      applyThreadUpdate(threadId, (runtime) => {
        const expandedReasoning = new Set(runtime.expandedReasoning);
        expandedReasoning.delete(itemId);
        return { ...runtime, expandedReasoning };
      });
    },

    addApproval: (approval) =>
      get().addApprovalForThread(approval.threadId, approval),

    addUserInputRequest: (request) =>
      get().addUserInputRequestForThread(request.threadId, request),

    resolveApproval: (requestId, decision) => {
      const threadId = selectedThread();
      if (threadId)
        get().resolveApprovalForThread(threadId, requestId, decision);
    },

    resolveUserInputRequest: (requestId) => {
      const threadId = selectedThread();
      if (threadId) get().resolveUserInputRequestForThread(threadId, requestId);
    },

    setTokenUsage: (turnId, usage) => {
      const threadId = selectedThread();
      if (threadId) get().setTokenUsageForThread(threadId, turnId, usage);
    },

    setThreadStatus: (status) => {
      const threadId = selectedThread();
      if (threadId) get().setThreadStatusForThread(threadId, status);
    },

    setActiveTurnId: (turnId) => {
      const threadId = selectedThread();
      if (threadId) get().setActiveTurnIdForThread(threadId, turnId);
    },

    clearActiveTurn: () => {
      const threadId = selectedThread();
      if (threadId) get().clearActiveTurnForThread(threadId);
    },

    hydrateTokenUsage: (turns) => {
      const threadId = selectedThread();
      if (threadId) get().hydrateTokenUsageForThread(threadId, turns);
    },

    hydrateTurnDiffs: (turns) => {
      const threadId = selectedThread();
      if (threadId) get().hydrateTurnDiffsForThread(threadId, turns);
    },

    resolveApprovalByRequestId: (requestId) => {
      const threadId = selectedThread();
      if (threadId)
        get().resolveApprovalByRequestIdForThread(threadId, requestId);
    },

    hydrateTimelineForThread: (threadId, turns, cwd) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        threadCwd: cwd ?? runtime.threadCwd,
        loading: false,
        timeline: ensureRequestTurnEntries(
          turnsToTimeline(turns),
          runtime.approvals,
          runtime.userInputRequests,
        ),
        activeTurnId: null,
        hydrated: true,
      }));
    },

    /**
     * Seeds a thread from a metadata-first open.
     *
     * The server returns the most recent page of turns newest-first, because
     * that is the end the user is looking at; the timeline renders oldest-first,
     * so the page is reversed here rather than at every read site.
     */
    hydrateOpenedThread: ({
      threadId,
      turnsNewestFirst,
      historyCursor,
      readOnlyReason,
      cwd,
    }) => {
      const turns = [...turnsNewestFirst].reverse();
      applyThreadUpdate(threadId, (runtime) => {
        // Reopening must not undo paging. An open returns only the most recent
        // page, so replacing the timeline with it would discard every earlier
        // page the user had loaded — leave the conversation and come back and
        // the history silently shrinks again.
        //
        // The page is kept only when it introduces nothing this client does not
        // already hold.
        const knownTurnIds = collectKnownTurnIds(runtime.timeline);
        const pageIsSubsumed =
          runtime.hydrated &&
          turns.length > 0 &&
          turns.every((turn) => knownTurnIds.has(turn.id));

        const pageEntries = ensureRequestTurnEntries(
          turnsToTimeline(turns),
          runtime.approvals,
          runtime.userInputRequests,
        );
        // A thread not yet hydrated can still hold entries: subscription and
        // this request run concurrently, so notifications for a turn that is
        // running right now may already have been written. Replacing wholesale
        // here is what erased them on a refresh mid-turn.
        //
        // Once hydrated, the two are reconciled only when they overlap. Without
        // a shared turn they are disconnected windows of a thread that moved on
        // elsewhere, and interleaving them would keep every entry while hiding
        // the gap between them — so the server's view still wins outright, as
        // it did before, and its cursor is adopted so the gap stays pageable.
        const reconcilable =
          !runtime.hydrated || sharesHistory(pageEntries, runtime.timeline);

        return {
          ...runtime,
          threadCwd: cwd ?? runtime.threadCwd,
          loading: false,
          // Known turn ids do not imply known contents or lifecycle. Keep the
          // paging cursor below, but still reconcile a repeat open's evidence.
          timeline: reconcilable
            ? reconcileTimeline(pageEntries, runtime.timeline)
            : pageEntries,
          // Left to the caller, which can compare the page against what is
          // already known. Clearing it here dropped a `turn/started` that
          // arrived while this request was in flight.
          hydrated: true,
          // Keeping the existing cursor matters as much as keeping the entries:
          // the cursor from a fresh open points just before the newest page, so
          // adopting it would offer to re-fetch history already on screen.
          historyCursor: pageIsSubsumed ? runtime.historyCursor : historyCursor,
          historyLoading: false,
          readOnlyReason,
        };
      });
    },

    /**
     * Adds an older page of history above what is already rendered.
     *
     * Guards against double-application: a turn already present is skipped
     * rather than duplicated, because the cursor page is inclusive of its
     * anchor row and a retry can overlap what the previous page delivered.
     */
    prependHistoryForThread: (threadId, turnsNewestFirst, nextCursor) => {
      applyThreadUpdate(threadId, (runtime) => {
        const knownTurnIds = collectKnownTurnIds(runtime.timeline);
        const older = [...turnsNewestFirst]
          .reverse()
          .filter((turn) => !knownTurnIds.has(turn.id));
        // Failures hydrated before their turn was paged in are parked at the
        // end; this page may be the one that owns them.
        const { prepended, existing } = absorbStrandedFailures(
          turnsToTimeline(older),
          older.map((turn) => turn.id),
          runtime.timeline,
        );
        return {
          ...runtime,
          timeline: [...prepended, ...existing],
          historyCursor: nextCursor,
          historyLoading: false,
        };
      });
    },

    setHistoryLoadingForThread: (threadId, historyLoading) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        historyLoading,
      }));
    },

    /**
     * Marks a conversation destroyed elsewhere while keeping its transcript.
     *
     * Keeping what the user is reading is deliberate, but it must stop being
     * interactive in the same step: a preserved transcript that still accepts
     * messages is a conversation that fails on every send. Any in-flight turn
     * state is cleared too — it can no longer complete, and leaving it would
     * show a spinner that never resolves.
     */
    markThreadDeletedRemotely: (threadId, message) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        deletedRemotely: true,
        loading: false,
        activeTurnId: null,
        historyCursor: null,
        historyLoading: false,
        timeline: [
          ...runtime.timeline,
          { kind: 'system', content: message, severity: 'error' },
        ],
      }));
    },

    // Token usage and turn diffs are not app-server state this client reads a
    // second view of: app-server exposes no historical read for either, and the
    // rows come from this project's own database, written by the backend from
    // the same notifications the browser receives. The stored copy is therefore
    // a RECORDING of live, one hop behind it, and can never hold something the
    // socket did not already deliver. Its whole purpose is to survive a refresh
    // or a disconnected window.
    //
    // So the rule is fill-only, and no ordering machinery is needed to justify
    // it. Both of these used to replace instead, which reverted a value that
    // arrived while the request was in flight. `hydrateTurnErrorsForThread`
    // below already merged, which is why it never had the bug.
    hydrateTokenUsageForThread: (threadId, turns) => {
      applyThreadUpdate(threadId, (runtime) => {
        const tokenUsageByTurn = { ...runtime.tokenUsageByTurn };
        let filled = false;
        for (const turn of turns) {
          if (turn.turnId in tokenUsageByTurn) continue;
          tokenUsageByTurn[turn.turnId] = turn.usage;
          filled = true;
        }
        return {
          ...runtime,
          tokenUsageByTurn,
          // The newest turn's usage drives the context gauge. A live value is
          // already the newest by construction, so the recording only supplies
          // one when there is nothing to supersede.
          latestTokenUsage:
            runtime.latestTokenUsage ??
            (filled ? (turns.at(-1)?.usage ?? null) : null),
        };
      });
    },

    hydrateTurnDiffsForThread: (threadId, turns) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: runtime.timeline.map((entry) => {
          if (entry.kind !== 'turn' || entry.diff !== undefined) return entry;
          const match = turns.find((turn) => turn.turnId === entry.turnId);
          return match ? { ...entry, diff: match.diff } : entry;
        }),
      }));
    },

    hydrateTurnErrorsForThread: (threadId, errors) => {
      if (errors.length === 0) return;
      applyThreadUpdate(threadId, (runtime) => {
        let next = runtime;
        for (const error of errors) {
          next = upsertRuntimeTurnFailure(
            next,
            normalizePersistedTurnFailure(error),
          );
        }
        return next;
      });
    },

    updateCurrentTurnForThread: (threadId, turnId, updater) => {
      applyThreadUpdate(threadId, (runtime) =>
        updateRuntimeCurrentTurn(runtime, turnId, updater),
      );
    },

    updateTurnItemForThread: (threadId, turnId, itemId, updater) => {
      applyThreadUpdate(threadId, (runtime) =>
        updateRuntimeTurnItem(runtime, turnId, itemId, (existing) => {
          const next = updater(existing);
          // Stamp only a write that actually changed something. A guarded delta
          // returns `existing` untouched, and re-stamping that would make a
          // stale event look to a recovery merge like fresh evidence that
          // outranks the snapshot.
          return next === existing
            ? next
            : { ...next, observedSeq: nextObservationSeq() };
        }),
      );
    },

    applyFullTurnItemsForThread: (threadId, turnId, items) => {
      applyThreadUpdate(threadId, (runtime) =>
        applyPersistedItems(runtime, turnId, items, {
          // This snapshot was fetched at an unknown moment, so it cannot claim
          // to be newer than a terminal observation already on screen. It still
          // repairs fragments, which is the point of topping a turn up.
          baselineSeq: -1,
          requireSummaryView: true,
          markFull: true,
        }),
      );
    },

    applyRecoveredTurnItemsForThread: (
      threadId,
      turnId,
      items,
      baselineSeq,
    ) => {
      applyThreadUpdate(threadId, (runtime) =>
        applyPersistedItems(runtime, turnId, items, {
          baselineSeq,
          // A running turn holds no `summary` marker, and a reconnect repairs
          // turns at every detail level, so the top-up's precondition would
          // reject exactly the cases recovery exists for.
          requireSummaryView: false,
          // More items will still stream into a running turn. Calling it `full`
          // is what stops the completed-turn top-up firing later, and this
          // snapshot is not that.
          markFull: false,
        }),
      );
    },
    updateTurnDiffForThread: (threadId, turnId, diff) => {
      applyThreadUpdate(threadId, (runtime) =>
        updateRuntimeDiff(runtime, turnId, diff),
      );
    },

    updateTurnPlanForThread: (threadId, turnId, plan) => {
      applyThreadUpdate(threadId, (runtime) =>
        updateRuntimePlan(runtime, turnId, plan),
      );
    },

    appendPlanDeltaForThread: (threadId, turnId, itemId, delta) => {
      if (!delta) return;
      applyThreadUpdate(threadId, (runtime) => {
        const patchPlan = (plan?: TurnPlanState): TurnPlanState => {
          const held = plan?.planTextByItemId?.[itemId];
          return {
            explanation: plan?.explanation ?? null,
            steps: plan?.steps ?? [],
            planTextByItemId: {
              ...(plan?.planTextByItemId ?? {}),
              [itemId]: {
                text: `${held?.text ?? ''}${delta}`,
                completed: false,
                observedSeq: nextObservationSeq(),
              },
            },
          };
        };
        const idx = runtime.timeline.findIndex(
          (entry) => entry.kind === 'turn' && entry.turnId === turnId,
        );
        if (idx >= 0) {
          const entry = runtime.timeline[idx];
          if (entry.kind !== 'turn') return runtime;
          // A delta that arrives after the terminal payload is stale by
          // construction: that payload already carries the whole accumulated
          // text, so appending would duplicate its tail and reopen a finished
          // plan item. This is `acceptsStreamedUpdate` applied to plan text.
          if (entry.plan?.planTextByItemId?.[itemId]?.completed) return runtime;
          const timeline = [...runtime.timeline];
          timeline[idx] = { ...entry, plan: patchPlan(entry.plan) };
          return { ...runtime, timeline };
        }
        return {
          ...runtime,
          timeline: [
            ...runtime.timeline,
            {
              kind: 'turn' as const,
              turnId,
              items: [],
              completed: false,
              plan: patchPlan(),
            },
          ],
        };
      });
    },

    setPlanTextForThread: (threadId, turnId, itemId, text) => {
      applyThreadUpdate(threadId, (runtime) =>
        setRuntimePlanText(runtime, turnId, itemId, text),
      );
    },

    setLoadingForThread: (threadId, loading) => {
      applyThreadUpdate(threadId, (runtime) => ({ ...runtime, loading }));
    },

    addApprovalForThread: (threadId, approval) => {
      applyThreadUpdate(threadId, (runtime) => {
        const requestKey = String(approval.requestId);
        const alreadyResolved =
          runtime.pendingResolvedRequestIds.has(requestKey);
        const finalApproval = alreadyResolved
          ? { ...approval, status: 'resolved' as const }
          : approval;
        const pendingResolvedRequestIds = new Set(
          runtime.pendingResolvedRequestIds,
        );
        if (alreadyResolved) pendingResolvedRequestIds.delete(requestKey);
        return {
          ...runtime,
          timeline: ensureTurnEntry(runtime.timeline, approval.turnId),
          approvals: { ...runtime.approvals, [requestKey]: finalApproval },
          pendingResolvedRequestIds,
        };
      });
    },

    addUserInputRequestForThread: (threadId, request) => {
      applyThreadUpdate(threadId, (runtime) => {
        const requestKey = String(request.requestId);
        const alreadyResolved =
          runtime.pendingResolvedRequestIds.has(requestKey);
        const finalRequest: UserInputRequest = alreadyResolved
          ? { ...request, status: 'resolved' }
          : request;
        const pendingResolvedRequestIds = new Set(
          runtime.pendingResolvedRequestIds,
        );
        if (alreadyResolved) pendingResolvedRequestIds.delete(requestKey);
        return {
          ...runtime,
          timeline: ensureTurnEntry(runtime.timeline, request.turnId),
          userInputRequests: {
            ...runtime.userInputRequests,
            [requestKey]: finalRequest,
          },
          pendingResolvedRequestIds,
        };
      });
    },

    resolveApprovalForThread: (threadId, requestId, decision) => {
      const requestKey = String(requestId);
      applyThreadUpdate(threadId, (runtime) => {
        const existing = runtime.approvals[requestKey];
        if (!existing) return runtime;
        return {
          ...runtime,
          approvals: {
            ...runtime.approvals,
            [requestKey]: { ...existing, status: decision },
          },
        };
      });
    },

    resolveUserInputRequestForThread: (threadId, requestId) => {
      const requestKey = String(requestId);
      applyThreadUpdate(threadId, (runtime) => {
        const existing = runtime.userInputRequests[requestKey];
        if (!existing) return runtime;
        const resolved: UserInputRequest = { ...existing, status: 'resolved' };
        return {
          ...runtime,
          userInputRequests: {
            ...runtime.userInputRequests,
            [requestKey]: resolved,
          },
        };
      });
    },

    setTokenUsageForThread: (threadId, turnId, usage) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        tokenUsageByTurn: { ...runtime.tokenUsageByTurn, [turnId]: usage },
        latestTokenUsage: usage,
      }));
    },

    setThreadStatusForThread: (threadId, status) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        threadStatus: status,
      }));
    },

    setActiveTurnIdForThread: (threadId, turnId) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        activeTurnId: turnId,
        timeline: turnId
          ? bindPendingUserMessage(runtime.timeline, turnId)
          : runtime.timeline,
      }));
    },

    clearActiveTurnForThread: (threadId) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        activeTurnId: null,
        loading: false,
      }));
    },

    settleTurnLifecycleForThread: (threadId, turns) => {
      applyThreadUpdate(threadId, (runtime) => {
        const statusById = new Map(turns.map((turn) => [turn.id, turn.status]));
        const timeline = runtime.timeline.map((entry) => {
          if (entry.kind !== 'turn') return entry;
          const status = statusById.get(entry.turnId);
          // A turn the headers do not mention is not evidence of anything: the
          // read is bounded, so an older turn is simply out of range.
          if (status === undefined || status === 'inProgress') return entry;
          // Forward-only, like every other lifecycle write. Marking an already
          // completed turn completed is a no-op worth skipping so the entry
          // keeps its identity and the transcript does not re-render.
          return entry.completed ? entry : { ...entry, completed: true };
        });

        // The active pointer is only cleared on evidence about that exact turn.
        // The headers name the turns that exist; one this read did not return
        // says nothing, and clearing on that would resurrect the stuck-spinner
        // bug in the opposite direction — a turn that started during the gap
        // and is genuinely running would be declared finished.
        const activeStatus = runtime.activeTurnId
          ? statusById.get(runtime.activeTurnId)
          : undefined;
        const activeEnded =
          activeStatus !== undefined && activeStatus !== 'inProgress';
        // A turn reported running that this client does not know about started
        // during the gap. Adopting it restores the composer's running state.
        const terminalTurnIds = new Set(
          timeline.flatMap((entry) =>
            entry.kind === 'turn' && entry.completed ? [entry.turnId] : [],
          ),
        );
        const running = turns.find(
          (turn) =>
            turn.status === 'inProgress' && !terminalTurnIds.has(turn.id),
        );
        const activeTurnId = activeEnded
          ? (running?.id ?? null)
          : (runtime.activeTurnId ?? running?.id ?? null);

        return {
          ...runtime,
          timeline: activeTurnId
            ? ensureTurnEntry(timeline, activeTurnId)
            : timeline,
          activeTurnId,
          loading: activeTurnId !== null,
        };
      });
    },

    addSystemMessageForThread: (
      threadId,
      message,
      severity = 'info',
      turnId?,
    ) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: [
          ...runtime.timeline,
          { kind: 'system' as const, content: message, severity, turnId },
        ],
      }));
    },

    addSystemErrorForThread: (threadId, message) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: [
          ...runtime.timeline,
          {
            kind: 'system' as const,
            content: `Error: ${message}`,
            severity: 'error' as const,
          },
        ],
        loading: false,
      }));
    },

    upsertTurnFailureForThread: (threadId, failure) => {
      applyThreadUpdate(threadId, (runtime) =>
        upsertRuntimeTurnFailure(runtime, failure),
      );
    },

    setThreadTitleForThread: (threadId, title) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        threadTitle: title,
      }));
    },

    resolveApprovalByRequestIdForThread: (threadId, requestId) => {
      const requestKey = String(requestId);
      applyThreadUpdate(threadId, (runtime) => {
        const approval = runtime.approvals[requestKey];
        if (approval) {
          return {
            ...runtime,
            approvals: {
              ...runtime.approvals,
              [requestKey]: { ...approval, status: 'resolved' },
            },
          };
        }

        const userInput = runtime.userInputRequests[requestKey];
        if (userInput) {
          const resolved: UserInputRequest = {
            ...userInput,
            status: 'resolved',
          };
          return {
            ...runtime,
            userInputRequests: {
              ...runtime.userInputRequests,
              [requestKey]: resolved,
            },
          };
        }

        return {
          ...runtime,
          pendingResolvedRequestIds: new Set(
            runtime.pendingResolvedRequestIds,
          ).add(requestKey),
        };
      });
    },
  };
});

/** Selects data from the currently visible thread runtime. */
export function useSelectedThreadState<T>(
  selector: (runtime: ThreadRuntimeState | null) => T,
): T {
  return useTimelineStore((state) =>
    selector(state.threadId ? readRuntime(state, state.threadId) : null),
  );
}

/** Selects data from a specific thread runtime. */
export function useThreadState<T>(
  threadId: string | null | undefined,
  selector: (runtime: ThreadRuntimeState | undefined) => T,
): T {
  return useTimelineStore((state) =>
    selector(threadId ? state.threadsById[threadId] : undefined),
  );
}
