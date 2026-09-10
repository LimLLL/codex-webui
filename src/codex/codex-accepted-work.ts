/** Retains only work dispatched through one owned stdio connection until observable termination. */
import type { RequestId } from './codex-schema';

const TURN_METHODS = new Set([
  'turn/start',
  'review/start',
  'thread/queue/start',
]);
/**
 * `thread/shellCommand` returns `{}` and then streams through ordinary turn and
 * item notifications with no dedicated item type, so its output is
 * indistinguishable from an active turn's command executions. It defaults to a
 * one-hour timeout, so guessing termination is not acceptable — these hold
 * until the thread closes or the process exits.
 */
const UNCORRELATED_METHODS = new Set(['thread/shellCommand']);
const COMPACTION_METHOD = 'thread/compact/start';
const TERMINAL_STATUSES = new Set(['completed', 'interrupted', 'failed']);
// A delayed response must not accumulate the thread's complete notification history.
const MAX_EARLY_EVENTS = 32;
// Only has to reach back far enough to cover a compaction that is still opening.
// Forgetting an older turn makes it unattributable, which blocks, never releases.
const MAX_TRACKED_TURN_STARTS = 64;

interface WorkEvent {
  threadId: string;
  turnId: string;
  terminal: boolean;
  clientId: string | null;
}

interface RetainedWork {
  method: string;
  threadId: string | null;
  turnId: string | null;
  clientId: string | null;
  queueId: string | null;
  awaitingResponse: boolean;
  earlyEvents: WorkEvent[];
  correlationLost: boolean;
  /**
   * Turn-start ordinal at acknowledgement time. A compaction can only own a turn
   * that started after this point.
   */
  ackTurnSequence: number | null;
}

/** A turn this connection saw begin, kept to prove a later item postdates a request. */
interface StartedTurn {
  threadId: string;
  sequence: number;
  /** True once any item was seen in this turn, which rules out a compaction turn. */
  sawItem: boolean;
}

export interface AcceptedWorkBlocker {
  threadId: string | null;
  turnId: string | null;
  requestMethod: string;
  reason: string;
}

/** Reads wire records without trusting RPC payloads to have their generated TypeScript shape. */
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class CodexAcceptedWork {
  private readonly entries = new Map<RequestId, RetainedWork>();
  /** Turns seen to begin, keyed by thread and turn; turn ids are not globally unique. */
  private readonly startedTurns = new Map<string, StartedTurn>();
  private turnSequence = 0;

  /** Reserves locally dispatched work before writing to stdin, closing the response/status visibility gap. */
  dispatch(id: RequestId, method: string, params: unknown): void {
    if (
      !TURN_METHODS.has(method) &&
      !UNCORRELATED_METHODS.has(method) &&
      method !== COMPACTION_METHOD &&
      method !== 'thread/goal/set' &&
      method !== 'thread/queue/add'
    )
      return;
    this.entries.set(id, {
      method,
      threadId: text(object(params).threadId),
      turnId: null,
      clientId: null,
      queueId: null,
      awaitingResponse: true,
      earlyEvents: [],
      correlationLost: false,
      ackTurnSequence: null,
    });
  }

  /** Discards a reservation on an explicit upstream invalid-request/invalid-params refusal. */
  refused(id: RequestId): void {
    this.entries.delete(id);
  }

  /** Binds the response before resolving its caller; delayed responses cannot resurrect completed work. */
  response(id: RequestId, result: unknown): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.awaitingResponse = false;
    const payload = object(result);
    if (TURN_METHODS.has(entry.method)) {
      const turn = object(payload.turn);
      entry.turnId = text(turn.id);
      if (entry.method === 'review/start')
        entry.threadId = text(payload.reviewThreadId) ?? entry.threadId;
      if (entry.turnId && TERMINAL_STATUSES.has(String(turn.status))) {
        this.entries.delete(id);
        return;
      }
    } else if (entry.method === 'thread/queue/add') {
      const submission = object(payload.queuedSubmission);
      entry.clientId = text(submission.clientUserMessageId);
      entry.queueId = text(submission.id);
    } else if (entry.method === COMPACTION_METHOD) {
      // Only a turn that starts after this point can be the one this request
      // created; anything already running is somebody else's work.
      entry.ackTurnSequence = this.turnSequence;
    } else if (entry.method === 'thread/goal/set') {
      const status = object(payload.goal).status;
      // This particular mutation did not enable continuation. It cannot clear an older active-goal reservation.
      if (
        [
          'paused',
          'blocked',
          'usageLimited',
          'budgetLimited',
          'complete',
        ].includes(String(status))
      ) {
        this.entries.delete(id);
        return;
      }
    }
    const events = entry.earlyEvents;
    entry.earlyEvents = [];
    for (const event of events) this.observe(id, entry, event);
  }

  /** An explicit successful deletion terminates only a queued submission that has not become a turn. */
  queueDeleted(params: unknown, result: unknown): void {
    if (object(result).deleted !== true) return;
    const request = object(params);
    for (const [id, entry] of this.entries) {
      if (
        entry.method === 'thread/queue/add' &&
        entry.turnId === null &&
        entry.threadId === request.threadId &&
        entry.queueId === request.queuedSubmissionId
      )
        this.entries.delete(id);
    }
  }

  /** Observes terminal turns and queued-message identity; idle/status snapshots never clear local work. */
  notification(method: string, params: unknown): void {
    const payload = object(params);
    const threadId = text(payload.threadId);
    if (!threadId) return;
    if (method === 'thread/closed') {
      for (const [id, entry] of this.entries) {
        if (
          entry.threadId === threadId &&
          !(entry.method === 'review/start' && entry.awaitingResponse)
        )
          this.entries.delete(id);
      }
      for (const [key, turn] of this.startedTurns)
        if (turn.threadId === threadId) this.startedTurns.delete(key);
      return;
    }
    // A manual compaction opens a turn of its own. Upstream 0.153.2 emits
    // `TurnStarted` explicitly in every manual path (local, remote, remote v2
    // and token-budget) and never emits it for inline automatic compaction,
    // which reuses the enclosing turn's context. So a turn this connection saw
    // *begin* after the acknowledgement, whose very first item is a
    // `contextCompaction`, is a manual compaction turn. That gives compaction
    // the same positive request-to-turn association every other retained method
    // has, and release then runs through the ordinary terminal-turn path.
    if (method === 'turn/started') {
      const turnId = text(object(payload.turn).id);
      if (turnId) this.trackTurnStart(threadId, turnId);
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = object(payload.item);
      const itemTurn = text(payload.turnId);
      if (item.type === 'contextCompaction') {
        if (method === 'item/started')
          this.bindCompactionTurn(threadId, itemTurn);
        return;
      }
      // Any other item proves this turn is doing ordinary work, so a compaction
      // appearing in it later is inline and automatic, not this request's.
      if (itemTurn) this.markTurnHasItem(threadId, itemTurn);
    }
    let event: WorkEvent;
    if (method === 'turn/completed') {
      const turn = object(payload.turn);
      const turnId = text(turn.id);
      if (!turnId || !TERMINAL_STATUSES.has(String(turn.status))) return;
      event = { threadId, turnId, terminal: true, clientId: null };
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = object(payload.item);
      const turnId = text(payload.turnId);
      if (item.type !== 'userMessage' || !turnId || !text(item.clientId))
        return;
      event = {
        threadId,
        turnId,
        terminal: false,
        clientId: text(item.clientId),
      };
    } else return;
    for (const [id, entry] of this.entries) {
      if (
        entry.threadId !== threadId &&
        !(entry.method === 'review/start' && entry.awaitingResponse)
      )
        continue;
      this.observe(id, entry, event);
    }
  }

  /** Actual process exit ends this connection's work. Sending a kill signal alone is insufficient. */
  processExited(): void {
    this.entries.clear();
    this.startedTurns.clear();
  }

  /**
   * Composite key: turn ids are unique per thread, not globally.
   *
   * The separator cannot appear in either id, so `a` + `bc` and `ab` + `c`
   * cannot collide into the same key.
   */
  private turnKey(threadId: string, turnId: string): string {
    return [threadId, turnId].join('::');
  }

  /**
   * Records when a turn began, so a later item can be proved to postdate a request.
   *
   * Idempotent: a repeated `turn/started` must not hand an old turn a newer
   * ordinal, which would make it eligible for a request it predates.
   */
  private trackTurnStart(threadId: string, turnId: string): void {
    const key = this.turnKey(threadId, turnId);
    if (this.startedTurns.has(key)) return;
    if (this.startedTurns.size >= MAX_TRACKED_TURN_STARTS) {
      for (const oldest of this.startedTurns.keys()) {
        this.startedTurns.delete(oldest);
        break;
      }
    }
    this.startedTurns.set(key, {
      threadId,
      sequence: ++this.turnSequence,
      sawItem: false,
    });
  }

  /** Notes that a turn carried ordinary work, disqualifying it as a compaction turn. */
  private markTurnHasItem(threadId: string, turnId: string): void {
    const turn = this.startedTurns.get(this.turnKey(threadId, turnId));
    if (turn) turn.sawItem = true;
  }

  /**
   * Binds a compaction reservation to the turn its item is running in.
   *
   * Three independent conditions, all required. The turn must have been seen to
   * begin after the acknowledgement, which excludes inline automatic compaction
   * (upstream never emits `TurnStarted` for it). The compaction item must be
   * that turn's first item, which excludes an ordinary turn that compacts part
   * way through. And the turn must be unclaimed, so one turn can never release
   * two reservations. Anything unknown, forgotten or out of order loses
   * confidence rather than granting it: the reservation simply stays blocked.
   *
   * @param threadId - Thread the compaction item belongs to.
   * @param turnId - Turn carried by the `contextCompaction` item.
   */
  private bindCompactionTurn(threadId: string, turnId: string | null): void {
    if (!turnId) return;
    const turn = this.startedTurns.get(this.turnKey(threadId, turnId));
    if (!turn || turn.sawItem) return;
    // Claimed for this turn's lifetime, whether or not that entry is still held.
    turn.sawItem = true;
    for (const entry of this.entries.values()) {
      if (
        entry.method === COMPACTION_METHOD &&
        entry.threadId === threadId &&
        !entry.awaitingResponse &&
        entry.turnId === null &&
        entry.ackTurnSequence !== null &&
        turn.sequence > entry.ackTurnSequence
      ) {
        entry.turnId = turnId;
        return;
      }
    }
  }

  /** Reports only local dispatch reservations; absence says nothing about another client's work. */
  blockers(): AcceptedWorkBlocker[] {
    return [...this.entries.values()].map((entry) => ({
      threadId: entry.threadId,
      turnId: entry.turnId,
      requestMethod: entry.method,
      reason:
        entry.turnId && !entry.correlationLost
          ? `Locally dispatched ${entry.method} has no observed terminal transition`
          : `Cannot establish idle: locally dispatched ${entry.method} has no attributable terminal turn`,
    }));
  }

  private observe(id: RequestId, entry: RetainedWork, event: WorkEvent): void {
    if (entry.correlationLost || !this.entries.has(id)) return;
    if (
      UNCORRELATED_METHODS.has(entry.method) ||
      entry.method === 'thread/goal/set'
    )
      return;
    // A compaction only participates once it owns a turn; until then no
    // terminal turn on this thread can be evidence about it.
    if (entry.method === COMPACTION_METHOD && entry.turnId === null) return;
    if (!entry.awaitingResponse && entry.threadId === event.threadId) {
      if (
        entry.method === 'thread/queue/add' &&
        entry.clientId &&
        entry.clientId === event.clientId
      ) {
        entry.turnId = event.turnId;
        if (
          entry.earlyEvents.some(
            (early) =>
              early.terminal &&
              early.turnId === event.turnId &&
              early.threadId === event.threadId,
          )
        ) {
          this.entries.delete(id);
          return;
        }
        entry.earlyEvents = [];
      }
      if (event.terminal && entry.turnId === event.turnId) {
        this.entries.delete(id);
        return;
      }
    }
    if (
      entry.awaitingResponse ||
      (entry.method === 'thread/queue/add' && !entry.turnId)
    ) {
      if (entry.earlyEvents.length === MAX_EARLY_EVENTS) {
        entry.correlationLost = true;
        entry.earlyEvents = [];
      } else entry.earlyEvents.push(event);
    }
  }
}
