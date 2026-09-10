/** Backend-owned execution obligations survive child replacement, never a full NestJS restart. */
import { Injectable, Logger } from '@nestjs/common';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type {
  ServerNotification,
  ServerRequest,
  v2,
} from '../codex/codex-schema';
import type { CodexJsonRpcClientEvents } from '../codex/codex-jsonrpc-client';

interface ExecutionObligation {
  parentThreadId: string | null;
  turns: Set<string>;
  /** Prevents a late start response from reviving a turn completed before its acknowledgement. */
  terminalTurns: Set<string>;
  activeGoal: boolean;
  goalSequence: number;
  goalWireSequence: number;
  /** Active status or a request seen before a correlated turn/start. Idle alone cannot clear it. */
  uncorrelatedActivity: boolean;
}

const TERMINAL = new Set(['completed', 'interrupted', 'failed']);

/** Unknown future or malformed goal statuses cannot prove that an obligation ended. */
function activeGoal(status: unknown): boolean | undefined {
  if (typeof status !== 'string') return undefined;
  if (status === 'active') return true;
  if (
    ['paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(
      status,
    )
  )
    return false;
  return undefined;
}

/** Reads optional experimental wire fields without widening the generated protocol types. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Records execution observed on the managed app-server transport.
 * This is separate from the accepted-work restart barrier: autonomous turns and
 * blocked work count, browser subscriptions do not, and child exit retains the
 * last known obligations until reattachment can obtain terminal evidence.
 */
@Injectable()
export class ThreadExecutionInventoryService {
  private readonly logger = new Logger(ThreadExecutionInventoryService.name);
  private readonly threads = new Map<string, ExecutionObligation>();
  private readonly deleted = new Set<string>();
  private readonly goalReads = new Map<string, Promise<void>>();

  constructor(private readonly manager: CodexProcessManager) {
    manager.addListener('notification', (note: ServerNotification) =>
      this.observeNotification(note),
    );
    manager.addListener('serverRequest', (request: ServerRequest) => {
      const params = record(request.params);
      const threadId = text(params.threadId);
      if (!threadId || this.deleted.has(threadId)) return;
      const turnId = text(params.turnId);
      if (turnId) this.observeTurn(threadId, turnId, 'inProgress');
      else this.ensure(threadId).uncorrelatedActivity = true;
    });
    manager.addListener(
      'response',
      (response: CodexJsonRpcClientEvents['response'][0]) =>
        this.observeResponse(response),
    );
    manager.addLifecycleListener((event) => {
      if (event.type !== 'appServerReady') return;
      this.deleted.clear();
      this.goalReads.clear();
      for (const state of this.threads.values()) {
        state.terminalTurns.clear();
        state.goalSequence++;
        state.goalWireSequence = 0;
      }
    });
  }

  /** Returns execution targets independently of the number of connected browsers. */
  snapshot(): string[] {
    return [...this.threads.keys()].filter((id) => this.has(id));
  }

  /** Rechecks a queued recovery target after intervening completion or deletion. */
  has(threadId: string): boolean {
    const state = this.threads.get(threadId);
    return Boolean(
      state &&
      (state.turns.size > 0 || state.activeGoal || state.uncorrelatedActivity),
    );
  }

  /** Returns a spawned child's observed owner, retained even while that child is unloaded. */
  parentOf(threadId: string): string | null {
    return this.threads.get(threadId)?.parentThreadId ?? null;
  }

  /** Rejects a recovery whose target was positively deleted while it was queued. */
  isDeleted(threadId: string): boolean {
    return this.deleted.has(threadId);
  }

  /** Removes a server-confirmed deleted conversation and rejects late responses for it. */
  forget(threadId: string): void {
    this.threads.delete(threadId);
    this.deleted.add(threadId);
  }

  /**
   * Applies only turn headers actually returned by reattachment.
   * Absence from a bounded page is not proof of termination. This never submits
   * user input, restarts a command, or marks an obligation done just because resume succeeded.
   */
  observeRestoredTurns(
    threadId: string,
    turns: Array<{ id: string; status: string }>,
  ): void {
    for (const turn of turns) this.observeTurn(threadId, turn.id, turn.status);
  }

  private ensure(threadId: string): ExecutionObligation {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        parentThreadId: null,
        turns: new Set(),
        terminalTurns: new Set(),
        activeGoal: false,
        goalSequence: 0,
        goalWireSequence: 0,
        uncorrelatedActivity: false,
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private observeTurn(threadId: string, turnId: string, status: string): void {
    if (this.deleted.has(threadId)) return;
    const state = this.ensure(threadId);
    if (TERMINAL.has(status)) {
      state.terminalTurns.add(turnId);
      if (state.turns.delete(turnId)) state.uncorrelatedActivity = false;
    } else if (status === 'inProgress' && !state.terminalTurns.has(turnId)) {
      state.turns.add(turnId);
      state.uncorrelatedActivity = false;
    }
  }

  private observeNotification(note: ServerNotification): void {
    const params = record(note.params);
    const threadId = text(params.threadId);
    if (note.method === 'thread/started') {
      this.observeThread(record(params.thread));
      return;
    }
    if (!threadId || this.deleted.has(threadId)) return;
    if (note.method === 'thread/deleted') {
      this.forget(threadId);
    } else if (note.method === 'thread/closed') {
      const state = this.ensure(threadId);
      for (const turnId of state.turns) state.terminalTurns.add(turnId);
      state.turns.clear();
      state.uncorrelatedActivity = false;
      // Closing the runtime ends its turns, but is not evidence that its
      // independently persisted active goal was paused or completed.
    } else if (
      note.method === 'turn/started' ||
      note.method === 'turn/completed'
    ) {
      const turn = record(params.turn);
      const turnId = text(turn.id);
      if (turnId) this.observeTurn(threadId, turnId, String(turn.status));
    } else if (note.method === 'thread/status/changed') {
      if (record(params.status).type === 'active') {
        const state = this.ensure(threadId);
        if (state.turns.size === 0) state.uncorrelatedActivity = true;
      }
    } else if (
      note.method === 'thread/goal/updated' ||
      note.method === 'thread/goal/cleared'
    ) {
      const state = this.ensure(threadId);
      const active =
        note.method === 'thread/goal/cleared'
          ? false
          : activeGoal(record(params.goal).status);
      if (active === undefined) {
        this.logger.warn(
          `Unrecognized goal state for thread=${threadId}; retaining execution obligation`,
        );
        return;
      }
      state.activeGoal = active;
      state.goalSequence++;
      state.goalWireSequence =
        this.manager.getClient()?.getObservationSequence() ?? 0;
    }
  }

  private observeThread(thread: Record<string, unknown>): void {
    const threadId = text(thread.id);
    if (!threadId || this.deleted.has(threadId)) return;
    const parentThreadId = text(thread.parentThreadId);
    if (parentThreadId) this.ensure(threadId).parentThreadId = parentThreadId;
    if (record(thread.status).type === 'active') {
      const state = this.ensure(threadId);
      if (state.turns.size === 0) state.uncorrelatedActivity = true;
    }
    void this.readGoal(threadId);
  }

  private observeResponse(
    response: CodexJsonRpcClientEvents['response'][0],
  ): void {
    const params = record(response.params);
    const result = record(response.result);
    const threadId = text(params.threadId);
    if (response.method === 'thread/delete' && threadId) {
      this.forget(threadId);
    } else if (
      response.method === 'thread/start' ||
      response.method === 'thread/resume' ||
      response.method === 'thread/fork'
    ) {
      const thread = record(result.thread);
      const id = text(thread.id);
      if (id && !this.deleted.has(id)) {
        const parentThreadId = text(thread.parentThreadId);
        if (parentThreadId) this.ensure(id).parentThreadId = parentThreadId;
        void this.readGoal(id);
      }
      const turns = record(result.initialTurnsPage).data;
      if (id && Array.isArray(turns)) {
        for (const value of turns) {
          const turn = record(value);
          const turnId = text(turn.id);
          if (turnId) this.observeTurn(id, turnId, String(turn.status));
        }
      }
    } else if (
      (response.method === 'turn/start' ||
        response.method === 'review/start') &&
      threadId
    ) {
      const turn = record(result.turn);
      const turnId = text(turn.id);
      if (turnId)
        this.observeTurn(
          text(result.reviewThreadId) ?? threadId,
          turnId,
          String(turn.status),
        );
    } else if (
      (response.method === 'thread/goal/set' ||
        response.method === 'thread/goal/clear') &&
      threadId &&
      !this.deleted.has(threadId)
    ) {
      const state = this.ensure(threadId);
      // A notification may precede the response and already describe a later goal state.
      if (state.goalWireSequence <= response.requestSequence) {
        const active =
          response.method === 'thread/goal/clear'
            ? false
            : activeGoal(record(result.goal).status);
        if (active === undefined) {
          this.logger.warn(
            `Unrecognized goal response for thread=${threadId}; retaining execution obligation`,
          );
          return;
        }
        state.activeGoal = active;
        state.goalSequence++;
        state.goalWireSequence = response.responseSequence;
      }
    }
  }

  /** Reads persisted goal state on attachment; late reads cannot undo live goal changes. */
  private readGoal(threadId: string): Promise<void> {
    const existing = this.goalReads.get(threadId);
    if (existing) return existing;
    const client = this.manager.getClient();
    if (!client) return Promise.resolve();
    const state = this.ensure(threadId);
    const sequence = state.goalSequence;
    const generation = this.manager.getGeneration();
    const task = client
      .request<v2.ThreadGoalGetResponse>('thread/goal/get', { threadId })
      .then((response) => {
        if (
          generation !== this.manager.getGeneration() ||
          this.threads.get(threadId) !== state ||
          state.goalSequence !== sequence
        )
          return;
        const active =
          response.goal === null ? false : activeGoal(response.goal?.status);
        if (active === undefined)
          throw new Error(
            'Goal read did not report a recognized goal or explicit absence',
          );
        state.activeGoal = active;
        state.goalSequence++;
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not observe goal for thread=${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.goalReads.get(threadId) === task)
          this.goalReads.delete(threadId);
      });
    this.goalReads.set(threadId, task);
    return task;
  }
}
