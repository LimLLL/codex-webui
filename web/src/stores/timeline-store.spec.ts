/**
 * Regression tests for the timeline store behaviours that manual testing caught
 * but no automated test covered: history dedup across entry kinds, the
 * deleted-elsewhere lockout, and cache eviction for a destroyed conversation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnDto } from '../generated/api';
import type { ApprovalRequest } from '../types/approval';

const emit = vi.fn();

// The store reaches for the socket singleton on subscribe/forget paths; a real
// one would try to open a websocket under jsdom.
vi.mock('../socket', () => ({
  getSocket: () => ({ emit, on: vi.fn(), off: vi.fn() }),
}));

const { useTimelineStore } = await import('./timeline-store');

const pristine = useTimelineStore.getState();

/** A turn carrying only a user message — produces a `user` entry and no `turn` entry. */
function userOnlyTurn(id: string, text: string): TurnDto {
  return {
    id,
    items: [{ type: 'userMessage', content: [{ type: 'text', text }] }],
    status: 'completed',
  } as unknown as TurnDto;
}

/** A turn with an agent reply — produces both a `user` and a `turn` entry. */
function answeredTurn(id: string, text: string): TurnDto {
  return {
    id,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text }] },
      { type: 'agentMessage', text: 'reply' },
    ],
    status: 'completed',
  } as unknown as TurnDto;
}

beforeEach(() => {
  emit.mockClear();
  useTimelineStore.setState(pristine, true);
});

describe('history dedup', () => {
  it('does not re-insert a turn that only ever produced a user entry', () => {
    const store = useTimelineStore.getState();
    const turn = userOnlyTurn('turn-1', 'hello');

    store.hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [turn],
      historyCursor: 'cursor-1',
      readOnlyReason: null,
    });

    const seeded = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(seeded.timeline).toHaveLength(1);
    expect(seeded.timeline[0].kind).toBe('user');

    // The cursor page is inclusive of its anchor, so a retry re-delivers it.
    useTimelineStore.getState().prependHistoryForThread('t1', [turn], null);

    const after = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(after.timeline).toHaveLength(1);
  });

  it('still prepends genuinely older turns', () => {
    const store = useTimelineStore.getState();
    store.hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-2', 'second')],
      historyCursor: 'cursor-1',
      readOnlyReason: null,
    });

    useTimelineStore
      .getState()
      .prependHistoryForThread('t1', [userOnlyTurn('turn-1', 'first')], null);

    const timeline = useTimelineStore.getState().getThreadRuntime('t1')!.timeline;
    expect(timeline.map((entry) => entry.turnId)).toEqual([
      'turn-1',
      'turn-2',
      'turn-2',
    ]);
  });
});

describe('reopening a thread', () => {
  it('keeps paged history when the reopened page adds nothing new', () => {
    const store = useTimelineStore.getState();
    // Two pages already on screen: an older one paged in, plus the newest.
    store.hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-2', 'second')],
      historyCursor: 'cursor-older',
      readOnlyReason: null,
    });
    useTimelineStore
      .getState()
      .prependHistoryForThread('t1', [answeredTurn('turn-1', 'first')], null);

    // Reopening returns only the most recent page.
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-2', 'second')],
      historyCursor: 'cursor-newest',
      readOnlyReason: null,
    });

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(runtime.timeline.map((entry) => entry.turnId)).toEqual([
      'turn-1',
      'turn-1',
      'turn-2',
      'turn-2',
    ]);
    // Adopting the fresh cursor would offer to re-fetch what is already shown.
    expect(runtime.historyCursor).toBeNull();
  });

  it('lets the server view win when the reopened page carries an unseen turn', () => {
    const store = useTimelineStore.getState();
    store.hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-1', 'first')],
      historyCursor: 'cursor-older',
      readOnlyReason: null,
    });

    // The thread moved on elsewhere; merging partially would stitch two moments.
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-9', 'elsewhere')],
      historyCursor: 'cursor-newest',
      readOnlyReason: null,
    });

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(runtime.timeline.map((entry) => entry.turnId)).toEqual([
      'turn-9',
      'turn-9',
    ]);
    expect(runtime.historyCursor).toBe('cursor-newest');
  });
});

/** A summary-view turn: app-server withheld its reasoning and plan items. */
function summaryTurn(id: string, text: string): TurnDto {
  return {
    id,
    items: [{ type: 'userMessage', content: [{ type: 'text', text }] }],
    itemsView: 'summary',
    status: 'completed',
  } as unknown as TurnDto;
}

describe('on-demand turn item top-up', () => {
  it('keeps an entry for a summary turn so the top-up has somewhere to land', () => {
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [summaryTurn('turn-1', 'hi')],
      historyCursor: null,
      readOnlyReason: null,
    });

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    const turnEntry = runtime.timeline.find((e) => e.kind === 'turn');
    expect(turnEntry).toBeDefined();
    expect(turnEntry).toMatchObject({ itemsView: 'summary' });
  });

  it('fills in the withheld items and marks the turn full', () => {
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [summaryTurn('turn-1', 'hi')],
      historyCursor: null,
      readOnlyReason: null,
    });

    useTimelineStore
      .getState()
      .applyFullTurnItemsForThread('t1', 'turn-1', [
        { type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
        { type: 'reasoning', id: 'r1', summary: ['thinking'] },
        { type: 'plan', id: 'p1', text: '# the plan' },
      ]);

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    const turnEntry = runtime.timeline.find((e) => e.kind === 'turn')!;
    expect(turnEntry).toMatchObject({ itemsView: 'full' });
    expect(turnEntry.kind === 'turn' && turnEntry.plan?.explanation).toContain(
      'the plan',
    );
    expect(
      turnEntry.kind === 'turn' && turnEntry.items.map((i) => i.type),
    ).toEqual(['reasoning']);
  });

  // A persisted snapshot is older than anything that streamed in live, so it
  // must never replace a turn that notifications have already rebuilt.
  it('refuses to overwrite a turn that is no longer summary', () => {
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-1', 'hi')],
      historyCursor: null,
      readOnlyReason: null,
    });

    useTimelineStore
      .getState()
      .applyFullTurnItemsForThread('t1', 'turn-1', [
        { type: 'agentMessage', id: 'stale', text: 'stale snapshot' },
      ]);

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    const turnEntry = runtime.timeline.find((e) => e.kind === 'turn')!;
    expect(
      turnEntry.kind === 'turn' &&
        turnEntry.items[0]?.type === 'agentMessage' &&
        turnEntry.items[0].content,
    ).toBe('reply');
  });
});

describe('structured turn failures', () => {
  it('hydrates a legacy message-only row as an ordinary failure', () => {
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-1', 'hello')],
      historyCursor: null,
      readOnlyReason: null,
    });
    useTimelineStore.getState().hydrateTurnErrorsForThread('t1', [
      {
        turnId: 'turn-1',
        message: 'legacy failure',
        errorCategory: null,
        additionalDetails: null,
        misalignmentErrorType: null,
        misalignmentExplanation: null,
        createdAt: 1,
      },
    ]);

    const failure = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!
      .timeline.find((entry) => entry.kind === 'turnFailure');
    expect(failure).toMatchObject({
      kind: 'turnFailure',
      turnId: 'turn-1',
      failure: {
        message: 'legacy failure',
        misalignmentErrorType: null,
        misalignmentExplanation: null,
      },
    });
  });

  it('does not let a sparse later failure erase hydrated detail', () => {
    useTimelineStore.getState().hydrateTurnErrorsForThread('t1', [
      {
        turnId: 'turn-1',
        message: 'rich failure',
        errorCategory: 'misalignmentPolicyViolation',
        additionalDetails: 'more detail',
        misalignmentErrorType: 'policy',
        misalignmentExplanation: 'explanation',
        createdAt: 1,
      },
    ]);
    useTimelineStore.getState().upsertTurnFailureForThread('t1', {
      turnId: 'turn-1',
      message: 'terminal summary',
      errorCategory: null,
      additionalDetails: null,
      misalignmentErrorType: null,
      misalignmentExplanation: null,
    });

    const failure = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!
      .timeline.find((entry) => entry.kind === 'turnFailure');
    expect(failure).toMatchObject({
      failure: {
        message: 'terminal summary',
        errorCategory: 'misalignmentPolicyViolation',
        additionalDetails: 'more detail',
        misalignmentErrorType: 'policy',
        misalignmentExplanation: 'explanation',
      },
    });
  });
});

describe('late sub-agent activity', () => {
  it('attaches to a parent turn that is already complete', () => {
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-1', 'hello')],
      historyCursor: null,
      readOnlyReason: null,
    });
    useTimelineStore
      .getState()
      .updateTurnItemForThread('t1', 'turn-1', 'activity-1', () => ({
        type: 'subAgentActivity',
        itemId: 'activity-1',
        completed: true,
        activityKind: 'completed',
        agentThreadId: 'child',
        agentPath: '/root/child',
      }));

    const turn = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!
      .timeline.find((entry) => entry.kind === 'turn');
    expect(turn).toMatchObject({
      completed: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          type: 'subAgentActivity',
          itemId: 'activity-1',
        }),
      ]),
    });
  });
});

describe('markThreadDeletedRemotely', () => {
  it('locks the thread while keeping the transcript', () => {
    const store = useTimelineStore.getState();
    store.hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-1', 'hello')],
      historyCursor: 'cursor-1',
      readOnlyReason: null,
    });
    // An in-flight turn must not survive the lockout as a spinner that never ends.
    useTimelineStore.getState().setActiveTurnIdForThread('t1', 'turn-1');
    useTimelineStore.getState().setLoadingForThread('t1', true);

    useTimelineStore
      .getState()
      .markThreadDeletedRemotely('t1', 'Deleted from another device');

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(runtime.deletedRemotely).toBe(true);
    expect(runtime.loading).toBe(false);
    expect(runtime.activeTurnId).toBeNull();
    // A dangling cursor would offer to page a conversation that is gone.
    expect(runtime.historyCursor).toBeNull();
    expect(runtime.historyLoading).toBe(false);
    // The transcript survives, with the reason appended.
    expect(runtime.timeline.slice(0, 2).map((e) => e.kind)).toEqual([
      'user',
      'turn',
    ]);
    expect(runtime.timeline.at(-1)).toMatchObject({
      kind: 'system',
      content: 'Deleted from another device',
      severity: 'error',
    });
  });
});

describe('approval request identity', () => {
  const approval = (
    requestId: string,
    overrides: Partial<ApprovalRequest> = {},
  ): ApprovalRequest => ({
    requestId,
    kind: 'command',
    threadId: 't1',
    turnId: 'turn-current',
    itemId: 'shared-command-item',
    status: 'pending',
    ...overrides,
  });

  it('keeps multiple callbacks for one item and resolves only one request', () => {
    const store = useTimelineStore.getState();
    store.addApprovalForThread('t1', approval('command-request'));
    store.addApprovalForThread(
      't1',
      approval('stdin-request', { kind: 'writeStdin' }),
    );
    store.resolveApprovalForThread('t1', 'stdin-request', 'accepted');

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(Object.keys(runtime.approvals)).toEqual([
      'command-request',
      'stdin-request',
    ]);
    expect(runtime.approvals['command-request'].status).toBe('pending');
    expect(runtime.approvals['stdin-request'].status).toBe('accepted');
    expect(runtime.timeline).toContainEqual(
      expect.objectContaining({ kind: 'turn', turnId: 'turn-current' }),
    );
  });

  it('applies a response that arrives before its approval request', () => {
    const store = useTimelineStore.getState();
    store.resolveApprovalByRequestIdForThread('t1', 'late-request');
    store.addApprovalForThread('t1', approval('late-request'));

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(runtime.approvals['late-request'].status).toBe('resolved');
    expect(runtime.pendingResolvedRequestIds.has('late-request')).toBe(false);
  });

  it('preserves the approval callback turn across timeline hydration', () => {
    const store = useTimelineStore.getState();
    store.addApprovalForThread(
      't1',
      approval('stdin-request', {
        kind: 'writeStdin',
        turnId: 'callback-turn',
        itemId: 'older-command-item',
      }),
    );
    store.hydrateTimelineForThread('t1', [answeredTurn('other-turn', 'hi')]);

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(runtime.timeline).toContainEqual(
      expect.objectContaining({ kind: 'turn', turnId: 'callback-turn' }),
    );
  });
});

describe('forgetThreads', () => {
  it('evicts a background thread and leaves the selected one alone', () => {
    const store = useTimelineStore.getState();
    store.hydrateOpenedThread({
      threadId: 'background',
      turnsNewestFirst: [answeredTurn('turn-b', 'b')],
      historyCursor: null,
      readOnlyReason: null,
    });
    useTimelineStore.getState().setActiveThread('selected');

    useTimelineStore.getState().forgetThreads(['background']);

    const state = useTimelineStore.getState();
    expect(state.threadsById['background']).toBeUndefined();
    expect(state.threadId).toBe('selected');
    expect(state.getThreadRuntime('selected')).not.toBeNull();
  });

  it('clears the selected thread instead of persisting it back into the cache', () => {
    // The selected runtime lives in top-level fields, not `threadsById`, and the
    // normal deselect path writes it back on the way out — which would resurrect
    // exactly the conversation being destroyed.
    const store = useTimelineStore.getState();
    store.setActiveThread('doomed');
    store.hydrateOpenedThread({
      threadId: 'doomed',
      turnsNewestFirst: [answeredTurn('turn-d', 'd')],
      historyCursor: null,
      readOnlyReason: null,
    });

    useTimelineStore.getState().forgetThreads(['doomed']);

    const state = useTimelineStore.getState();
    expect(state.threadsById['doomed']).toBeUndefined();
    expect(state.threadId).toBeNull();
    expect(state.selectedThreadId).toBeNull();
    expect(state.timeline).toEqual([]);
    expect(state.getThreadRuntime('doomed')).toBeNull();
  });

  it('leaves the socket room for a subscribed doomed thread', () => {
    const store = useTimelineStore.getState();
    // Subscribing happens on open; selecting another thread leaves the first
    // subscribed in the background, which is the state deletion has to unwind.
    store.setActiveThread('background');
    useTimelineStore.getState().setActiveThread('other');
    emit.mockClear();

    useTimelineStore.getState().forgetThreads(['background']);

    expect(emit).toHaveBeenCalledWith('thread.unsubscribe', {
      threadId: 'background',
    });
  });

  it('is a no-op for an empty list', () => {
    useTimelineStore.getState().forgetThreads([]);
    expect(emit).not.toHaveBeenCalled();
  });
});
