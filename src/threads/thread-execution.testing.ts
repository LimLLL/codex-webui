/** Typed managed-transport events shared by execution inventory and recovery tests. */
import { EventEmitter } from 'node:events';
import type { v2 } from '../codex/codex-schema';
import type { CodexJsonRpcClientEvents } from '../codex/codex-jsonrpc-client';
import type {
  CodexLifecycleEvent,
  CodexProcessManager,
} from '../codex/codex-process-manager.service';

/** Supplies a controllable child generation without involving any browser registry. */
export function managedTransportFixture() {
  const events = new EventEmitter<
    CodexJsonRpcClientEvents & { lifecycle: [CodexLifecycleEvent] }
  >();
  let generation = 1;
  let observationSequence = 0;
  events.on('notification', () => observationSequence++);
  events.on('response', () => observationSequence++);
  const request = vi
    .fn<
      (method: string, params: unknown) => Promise<v2.ThreadGoalGetResponse>
    >()
    .mockResolvedValue({ goal: null });
  const manager = {
    addListener: (
      event: keyof CodexJsonRpcClientEvents,
      handler: (...args: unknown[]) => void,
    ) => events.on(event, handler),
    addLifecycleListener: (handler: (event: CodexLifecycleEvent) => void) =>
      events.on('lifecycle', handler),
    getGeneration: () => generation,
    getClient: () => ({
      request,
      getObservationSequence: () => observationSequence,
    }),
  } as unknown as CodexProcessManager;
  return {
    events,
    manager,
    request,
    restart: () => {
      events.emit('lifecycle', {
        type: 'appServerUnavailable',
        generation,
        message: 'child exited',
      });
      generation++;
      events.emit('lifecycle', {
        type: 'appServerReady',
        generation,
        restarted: true,
      });
    },
  };
}

/** Builds a fully typed turn lifecycle payload without duplicating protocol fields in each case. */
export function executionTurn(
  id: string,
  status: v2.TurnStatus = 'inProgress',
): v2.Turn {
  return {
    id,
    status,
    items: [],
    itemsView: 'notLoaded',
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

/** Builds persisted goal evidence; tests choose only the status under discussion. */
export function executionGoal(
  threadId: string,
  status: v2.ThreadGoalStatus,
): v2.ThreadGoal {
  return {
    threadId,
    status,
    objective: 'test goal',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}
