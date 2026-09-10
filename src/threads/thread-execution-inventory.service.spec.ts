/** Obligations come from execution evidence and survive socket absence and child replacement. */
import { ThreadExecutionInventoryService } from './thread-execution-inventory.service';
import {
  managedTransportFixture,
  executionGoal,
  executionTurn,
} from './thread-execution.testing';
import { makeThreadFixture } from './threads.testing';
import { permissionApprovalFixture } from '../pending-approvals/pending-approvals.testing';
import type { v2 } from '../codex/codex-schema';

describe('ThreadExecutionInventoryService', () => {
  let source: ReturnType<typeof managedTransportFixture>;
  let inventory: ThreadExecutionInventoryService;
  beforeEach(() => {
    source = managedTransportFixture();
    inventory = new ThreadExecutionInventoryService(source.manager);
  });

  it('retains active and blocked turns across child replacement', () => {
    source.events.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'active', turn: executionTurn('a') },
    });
    source.events.emit('serverRequest', permissionApprovalFixture());
    const targets = inventory.snapshot();
    source.restart();
    expect(inventory.snapshot()).toEqual(targets);
    expect(targets).toContain('active');
    expect(targets).toContain('t1');
  });

  it('does not let a late start acknowledgement revive a completed turn', () => {
    source.events.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 't', turn: executionTurn('a', 'completed') },
    });
    source.events.emit('response', {
      requestSequence: 0,
      responseSequence: 1,
      method: 'turn/start',
      params: { threadId: 't' },
      result: { turn: executionTurn('a') },
    });
    expect(inventory.snapshot()).toEqual([]);
  });

  it('does not let idle or the completion of an earlier turn retire current work', () => {
    for (const id of ['old', 'new'])
      source.events.emit('notification', {
        method: 'turn/started',
        params: { threadId: 't', turn: executionTurn(id) },
      });
    source.events.emit('notification', {
      method: 'thread/status/changed',
      params: { threadId: 't', status: { type: 'idle' } },
    });
    source.events.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 't', turn: executionTurn('old', 'completed') },
    });
    expect(inventory.has('t')).toBe(true);
    source.events.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 't', turn: executionTurn('new', 'failed') },
    });
    expect(inventory.has('t')).toBe(false);
  });

  it('keeps active goals between turns, then removes them on pause or clear', () => {
    source.events.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'goal',
        turnId: null,
        goal: executionGoal('goal', 'active'),
      },
    });
    source.events.emit('notification', {
      method: 'turn/started',
      params: { threadId: 'goal', turn: executionTurn('turn') },
    });
    source.events.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 'goal', turn: executionTurn('turn', 'completed') },
    });
    expect(inventory.has('goal')).toBe(true);
    source.restart();
    expect(inventory.has('goal')).toBe(true);
    source.events.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 'goal',
        turnId: null,
        goal: executionGoal('goal', 'paused'),
      },
    });
    expect(inventory.has('goal')).toBe(false);
  });

  it('seeds a persisted active goal when a session is attached without a goal notification', async () => {
    source.request.mockResolvedValue({ goal: executionGoal('t', 'active') });
    source.events.emit('response', {
      requestSequence: 0,
      responseSequence: 1,
      method: 'thread/resume',
      params: { threadId: 't' },
      result: { thread: makeThreadFixture({ id: 't' }) },
    });
    await Promise.resolve();
    expect(inventory.has('t')).toBe(true);
  });

  it('rejects a goal read superseded by a live clear or by deletion', async () => {
    let finish!: (response: v2.ThreadGoalGetResponse) => void;
    source.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    source.events.emit('response', {
      requestSequence: 0,
      responseSequence: 1,
      method: 'thread/resume',
      params: { threadId: 't' },
      result: { thread: makeThreadFixture({ id: 't' }) },
    });
    source.events.emit('notification', {
      method: 'thread/goal/cleared',
      params: { threadId: 't', turnId: null },
    });
    finish({ goal: executionGoal('t', 'active') });
    await Promise.resolve();
    expect(inventory.has('t')).toBe(false);
    inventory.forget('t');
    source.events.emit('response', {
      requestSequence: 0,
      responseSequence: 1,
      method: 'turn/start',
      params: { threadId: 't' },
      result: { turn: executionTurn('late') },
    });
    expect(inventory.has('t')).toBe(false);
  });

  it('does not retire an uncovered turn merely because reattachment succeeds', () => {
    source.events.emit('notification', {
      method: 'turn/started',
      params: { threadId: 't', turn: executionTurn('old') },
    });
    source.restart();
    inventory.observeRestoredTurns('t', []);
    expect(inventory.has('t')).toBe(true);
    inventory.observeRestoredTurns('t', [executionTurn('old', 'interrupted')]);
    expect(inventory.has('t')).toBe(false);
  });

  it('keeps a native goal continuation when the resume page retires only the crashed turn', () => {
    source.events.emit('notification', {
      method: 'turn/started',
      params: { threadId: 't', turn: executionTurn('crashed') },
    });
    source.events.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 't',
        turnId: null,
        goal: executionGoal('t', 'active'),
      },
    });
    source.restart();
    // Native continuation can begin while the resume response is in flight.
    source.events.emit('notification', {
      method: 'turn/started',
      params: { threadId: 't', turn: executionTurn('continuation') },
    });
    inventory.observeRestoredTurns('t', [
      executionTurn('crashed', 'interrupted'),
    ]);
    source.events.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 't',
        turnId: null,
        goal: executionGoal('t', 'paused'),
      },
    });
    expect(inventory.has('t')).toBe(true);
    source.events.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 't',
        turn: executionTurn('continuation', 'completed'),
      },
    });
    expect(inventory.has('t')).toBe(false);
  });

  it('does not use historical completion to retire activity with no known turn id', () => {
    source.events.emit('notification', {
      method: 'thread/status/changed',
      params: { threadId: 't', status: { type: 'active', activeFlags: [] } },
    });
    source.restart();
    inventory.observeRestoredTurns('t', [
      executionTurn('historical', 'completed'),
    ]);
    expect(inventory.has('t')).toBe(true);
    // A running header can identify the obligation; its own terminal evidence
    // can then retire it. An arbitrary completed header cannot do either.
    inventory.observeRestoredTurns('t', [executionTurn('current')]);
    source.events.emit('notification', {
      method: 'turn/completed',
      params: { threadId: 't', turn: executionTurn('current', 'completed') },
    });
    expect(inventory.has('t')).toBe(false);
  });

  it('shares goal discovery while a thread introduction and attachment response overlap', async () => {
    let finish!: (value: v2.ThreadGoalGetResponse) => void;
    source.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const thread = makeThreadFixture({ id: 't' });
    source.events.emit('notification', {
      method: 'thread/started',
      params: { thread },
    });
    source.events.emit('response', {
      method: 'thread/resume',
      params: { threadId: 't' },
      result: { thread },
      requestSequence: 0,
      responseSequence: 2,
    });
    expect(source.request).toHaveBeenCalledTimes(1);
    finish({ goal: executionGoal('t', 'active') });
    await Promise.resolve();
    expect(inventory.has('t')).toBe(true);
  });
  it('records an accepted goal mutation even when an earlier goal read returned first', async () => {
    source.events.emit('response', {
      method: 'thread/resume',
      params: { threadId: 't' },
      result: { thread: makeThreadFixture({ id: 't' }) },
      requestSequence: 0,
      responseSequence: 1,
    });
    await Promise.resolve();
    source.events.emit('response', {
      method: 'thread/goal/set',
      params: { threadId: 't' },
      result: { goal: executionGoal('t', 'active') },
      requestSequence: 0,
      responseSequence: 2,
    });
    expect(inventory.has('t')).toBe(true);
  });

  it('does not let a delayed goal mutation response undo a later clear notification', () => {
    source.events.emit('notification', {
      method: 'thread/goal/cleared',
      params: { threadId: 't', turnId: null },
    });
    source.events.emit('response', {
      method: 'thread/goal/set',
      params: { threadId: 't' },
      result: { goal: executionGoal('t', 'active') },
      requestSequence: 0,
      responseSequence: 2,
    });
    expect(inventory.has('t')).toBe(false);
  });

  it('retains an active persisted goal when its runtime closes', () => {
    source.events.emit('notification', {
      method: 'thread/goal/updated',
      params: {
        threadId: 't',
        turnId: null,
        goal: executionGoal('t', 'active'),
      },
    });
    source.events.emit('notification', {
      method: 'thread/closed',
      params: { threadId: 't' },
    });
    expect(inventory.has('t')).toBe(true);
    source.events.emit('notification', {
      method: 'thread/goal/cleared',
      params: { threadId: 't', turnId: null },
    });
    expect(inventory.has('t')).toBe(false);
  });
});
