/**
 * Regression tests for the timeline store behaviours that manual testing caught
 * but no automated test covered: history dedup across entry kinds, the
 * deleted-elsewhere lockout, and cache eviction for a destroyed conversation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadDto, TurnDto } from '../generated/api';
import type { ApprovalRequest } from '../types/approval';
import type { ThreadTokenUsage } from '../types/codex-notifications';

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

describe('recovery lifecycle ordering', () => {
  it('does not reactivate a terminal turn from a delayed running header', () => {
    const store = useTimelineStore.getState();
    store.hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [
        answeredTurn('turn-1', 'finished while headers were in flight'),
      ],
      historyCursor: null,
      readOnlyReason: null,
    });
    store.settleTurnLifecycleForThread('t1', [
      { id: 'turn-1', status: 'inProgress' },
    ]);
    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.loading).toBe(false);
  });
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

    const timeline = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!.timeline;
    expect(timeline.map((entry) => entry.turnId)).toEqual([
      'turn-1',
      'turn-2',
      'turn-2',
    ]);
  });
});

describe('reopening a thread', () => {
  it('repairs a known turn even when the page introduces no new turn ids', () => {
    const store = useTimelineStore.getState();
    store.hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [summaryTurn('turn-1', 'hello')],
      historyCursor: null,
      readOnlyReason: null,
    });
    store.hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-1', 'hello')],
      historyCursor: 'newer',
      readOnlyReason: null,
    });
    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(
      runtime.timeline.find((entry) => entry.kind === 'turn')?.items,
    ).toHaveLength(1);
    expect(runtime.historyCursor).toBeNull();
  });
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

describe('locally recorded datasets fill gaps but never overwrite live', () => {
  // Token usage and turn diffs have no historical read on app-server; the rows
  // come from this project's own database, written from the same notifications
  // the browser already received. The recording is therefore never newer than
  // live, and a hydrate that lands after one must not revert it.
  it('keeps a token usage value that arrived while the read was in flight', () => {
    const store = useTimelineStore.getState();
    store.ensureThreadState({ threadId: 't1' });
    const live = { totalTokens: 999 } as unknown as ThreadTokenUsage;
    store.setTokenUsageForThread('t1', 'turn-1', live);

    store.hydrateTokenUsageForThread('t1', [
      {
        turnId: 'turn-1',
        usage: { totalTokens: 1 } as unknown as ThreadTokenUsage,
      },
      {
        turnId: 'turn-0',
        usage: { totalTokens: 2 } as unknown as ThreadTokenUsage,
      },
    ]);

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    expect(runtime.tokenUsageByTurn['turn-1']).toBe(live);
    // A turn live never reported is exactly what the recording is for.
    expect(runtime.tokenUsageByTurn['turn-0']).toEqual({ totalTokens: 2 });
    expect(runtime.latestTokenUsage).toBe(live);
  });

  it('keeps a turn diff that arrived while the read was in flight', () => {
    const store = useTimelineStore.getState();
    store.ensureThreadState({ threadId: 't1' });
    // `updateTurnDiffForThread` only maps existing rows, so both turns need one.
    const emptyPlan = { explanation: null, steps: [] };
    store.updateTurnPlanForThread('t1', 'turn-1', emptyPlan);
    store.updateTurnPlanForThread('t1', 'turn-2', emptyPlan);
    store.updateTurnDiffForThread('t1', 'turn-1', 'live diff');

    store.hydrateTurnDiffsForThread('t1', [
      { turnId: 'turn-1', diff: 'recorded diff' },
      { turnId: 'turn-2', diff: 'recorded diff 2' },
    ]);

    const timeline = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!.timeline;
    const first = timeline.find(
      (e) => e.kind === 'turn' && e.turnId === 'turn-1',
    );
    const second = timeline.find(
      (e) => e.kind === 'turn' && e.turnId === 'turn-2',
    );
    expect(first?.kind === 'turn' && first.diff).toBe('live diff');
    expect(second?.kind === 'turn' && second.diff).toBe('recorded diff 2');
  });
});

describe('plan text recovery', () => {
  it('keeps plan item text separate from the tool explanation on hydration and repair', () => {
    const store = useTimelineStore.getState();
    const items = [{ id: 'plan', type: 'plan', text: 'one copy' }];
    store.hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [
        { ...summaryTurn('turn-1', 'hi'), items } as unknown as TurnDto,
      ],
      historyCursor: null,
      readOnlyReason: null,
    });
    store.applyRecoveredTurnItemsForThread('t1', 'turn-1', items, -1);
    const turn = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!
      .timeline.find((entry) => entry.kind === 'turn');
    expect(turn?.plan).toEqual({
      explanation: null,
      steps: [],
      planTextByItemId: {
        plan: { text: 'one copy', completed: true, observedSeq: undefined },
      },
    });
  });

  it('keeps plan text when a tool updates the structured steps', () => {
    const store = useTimelineStore.getState();
    store.appendPlanDeltaForThread('t1', 'turn-1', 'plan', 'plan text');
    store.updateTurnPlanForThread('t1', 'turn-1', {
      explanation: 'progress',
      steps: [{ step: 'step', status: 'inProgress' }],
    });
    const turn = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!
      .timeline.find((entry) => entry.kind === 'turn');
    expect(turn?.plan?.planTextByItemId?.plan).toMatchObject({
      text: 'plan text',
      completed: false,
    });
  });

  it('refuses a plan delta that arrives after the terminal payload', () => {
    const store = useTimelineStore.getState();
    store.appendPlanDeltaForThread('t1', 'turn-1', 'plan', 'first half ');
    store.setPlanTextForThread(
      't1',
      'turn-1',
      'plan',
      'first half second half',
    );
    // The terminal payload already contains what this delta carried; appending
    // it would duplicate the tail and reopen a finished plan item.
    store.appendPlanDeltaForThread('t1', 'turn-1', 'plan', 'second half');
    const turn = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!
      .timeline.find((entry) => entry.kind === 'turn');
    expect(turn?.plan?.planTextByItemId?.plan).toMatchObject({
      text: 'first half second half',
      completed: true,
    });
  });

  it('accepts terminal plan text when all earlier events were missed', () => {
    const store = useTimelineStore.getState();
    store.setPlanTextForThread('t1', 'turn-1', 'plan', 'complete plan');
    const turn = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!
      .timeline.find((entry) => entry.kind === 'turn');
    expect(turn?.plan?.planTextByItemId?.plan).toMatchObject({
      text: 'complete plan',
      completed: true,
    });
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

    useTimelineStore.getState().applyFullTurnItemsForThread('t1', 'turn-1', [
      { type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
      { type: 'reasoning', id: 'r1', summary: ['thinking'] },
      { type: 'plan', id: 'p1', text: '# the plan' },
    ]);

    const runtime = useTimelineStore.getState().getThreadRuntime('t1')!;
    const turnEntry = runtime.timeline.find((e) => e.kind === 'turn')!;
    expect(turnEntry).toMatchObject({ itemsView: 'full' });
    // Keyed by item id rather than folded into one blob: that is what lets a
    // persisted plan replace a fragment left behind by a dropped connection.
    expect(
      turnEntry.kind === 'turn' && turnEntry.plan?.planTextByItemId?.p1?.text,
    ).toContain('the plan');
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

describe('paged read-only history', () => {
  it('keeps archived mode while seeding the newest page and older cursor', () => {
    const store = useTimelineStore.getState();
    store.setActiveThread('archived');
    store.setReadOnlyThread({
      id: 'archived',
      name: 'Archived conversation',
      preview: 'Archived conversation',
      cwd: '/workspace',
      status: { type: 'idle' },
      turns: [],
    } as unknown as ThreadDto);
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 'archived',
      turnsNewestFirst: [answeredTurn('turn-2', 'recent')],
      historyCursor: 'older-page',
      readOnlyReason: null,
      cwd: '/workspace',
    });

    const runtime = useTimelineStore.getState().getThreadRuntime('archived')!;
    expect(runtime.threadMode).toBe('readOnly');
    expect(runtime.historyCursor).toBe('older-page');
    expect(runtime.timeline.map((entry) => entry.turnId)).toEqual([
      'turn-2',
      'turn-2',
    ]);
  });

  it('does not discard earlier pages the user already loaded', () => {
    // Degrading to read-only must not shrink the transcript. The newest page is
    // all the fallback re-fetches, so anything that reseeds the timeline before
    // it lands throws away every page paged in behind the load-earlier control.
    const store = useTimelineStore.getState();
    store.setActiveThread('archived');
    store.hydrateOpenedThread({
      threadId: 'archived',
      turnsNewestFirst: [answeredTurn('turn-2', 'recent')],
      historyCursor: 'older-page',
      readOnlyReason: null,
    });
    useTimelineStore
      .getState()
      .prependHistoryForThread(
        'archived',
        [answeredTurn('turn-1', 'old')],
        null,
      );

    useTimelineStore.getState().setReadOnlyThread({
      id: 'archived',
      cwd: '/workspace',
      status: { type: 'idle' },
      turns: [],
    } as unknown as ThreadDto);
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 'archived',
      turnsNewestFirst: [answeredTurn('turn-2', 'recent')],
      historyCursor: 'older-page',
      readOnlyReason: null,
      cwd: '/workspace',
    });

    const runtime = useTimelineStore.getState().getThreadRuntime('archived')!;
    expect(runtime.threadMode).toBe('readOnly');
    expect([...new Set(runtime.timeline.map((entry) => entry.turnId))]).toEqual(
      ['turn-1', 'turn-2'],
    );
    // The pre-degrade cursor is already exhausted; adopting the fallback's
    // cursor would re-offer history that is on screen.
    expect(runtime.historyCursor).toBeNull();
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

describe('failures hydrated before their turn was paged in', () => {
  /** A failed turn that reports its own error on the paged-turn path. */
  function failedTurn(id: string, text: string): TurnDto {
    return {
      id,
      items: [{ type: 'userMessage', content: [{ type: 'text', text }] }],
      status: 'failed',
      error: { message: 'page-level failure' },
    } as unknown as TurnDto;
  }

  /** Structured error row as auxiliary hydration delivers it. */
  function errorRow(turnId: string, message: string) {
    return {
      turnId,
      message,
      errorCategory: 'misalignmentPolicyViolation',
      additionalDetails: 'aux detail',
      misalignmentErrorType: 'policy',
      misalignmentExplanation: 'aux explanation',
      createdAt: 1,
    };
  }

  /**
   * Seeds a conversation whose newest page is loaded, then hydrates an error
   * for an older turn no page has reached yet. That failure has nowhere to sit,
   * so it is parked at the end of the timeline.
   */
  function seedWithParkedFailure() {
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-new', 'newest')],
      historyCursor: 'cursor-1',
      readOnlyReason: null,
    });
    useTimelineStore
      .getState()
      .hydrateTurnErrorsForThread('t1', [errorRow('turn-old', 'aux failure')]);

    const parked = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!
      .timeline.filter((entry) => entry.kind === 'turnFailure');
    expect(parked).toHaveLength(1);
  }

  it('absorbs the parked failure instead of duplicating it', () => {
    seedWithParkedFailure();

    useTimelineStore
      .getState()
      .prependHistoryForThread('t1', [failedTurn('turn-old', 'older')], null);

    const timeline = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!.timeline;
    const failures = timeline.filter(
      (entry) => entry.kind === 'turnFailure' && entry.turnId === 'turn-old',
    );
    expect(failures).toHaveLength(1);
    // The structured record wins the merge: it carries misalignment detail the
    // paged turn's own error field does not.
    expect(failures[0]).toMatchObject({
      failure: {
        message: 'aux failure',
        misalignmentExplanation: 'aux explanation',
      },
    });
  });

  it('keeps the surviving failure next to its own turn', () => {
    seedWithParkedFailure();
    useTimelineStore
      .getState()
      .prependHistoryForThread('t1', [failedTurn('turn-old', 'older')], null);

    const timeline = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!.timeline;
    const newestIndex = timeline.findIndex(
      (entry) => entry.kind === 'user' && entry.turnId === 'turn-new',
    );
    // Nothing may remain parked below the newest turn. Asserting on the first
    // match would pass even when a duplicate is still stranded down there,
    // because the correctly placed copy is found first.
    const strandedBelowNewest = timeline
      .slice(newestIndex)
      .filter((entry) => entry.kind === 'turnFailure');
    expect(strandedBelowNewest).toHaveLength(0);
  });

  it('relocates a parked failure even when the page reports no error', () => {
    seedWithParkedFailure();

    useTimelineStore
      .getState()
      .prependHistoryForThread('t1', [answeredTurn('turn-old', 'older')], null);

    const timeline = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!.timeline;
    const failures = timeline.filter((entry) => entry.kind === 'turnFailure');
    expect(failures).toHaveLength(1);
    const failureIndex = timeline.indexOf(failures[0]);
    const oldTurnIndex = timeline.findIndex(
      (entry) => entry.kind === 'turn' && entry.turnId === 'turn-old',
    );
    expect(oldTurnIndex).toBeGreaterThanOrEqual(0);
    expect(failureIndex).toBe(oldTurnIndex + 1);
  });

  it('places the relocated failure immediately after its own turn', () => {
    // A page carries several turns, so "below the newest turn" is not enough:
    // the failure has to land against the right one, and before the turn that
    // follows it.
    seedWithParkedFailure();

    useTimelineStore
      .getState()
      .prependHistoryForThread(
        't1',
        [answeredTurn('turn-mid', 'middle'), answeredTurn('turn-old', 'older')],
        null,
      );

    const timeline = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!.timeline;
    const failures = timeline.filter((entry) => entry.kind === 'turnFailure');
    expect(failures).toHaveLength(1);
    const at = timeline.indexOf(failures[0]);
    expect(timeline[at - 1]).toMatchObject({
      kind: 'turn',
      turnId: 'turn-old',
    });
    expect(timeline[at + 1]).toMatchObject({
      kind: 'user',
      turnId: 'turn-mid',
    });
  });

  it('relocates a failure whose turn arrived with only a user message', () => {
    // A turn whose items all normalize away, and whose own error field is
    // empty, contributes no `turn` entry at all. Reading the arriving turn ids
    // off the entries would miss it and leave the failure parked forever.
    seedWithParkedFailure();

    useTimelineStore
      .getState()
      .prependHistoryForThread(
        't1',
        [answeredTurn('turn-mid', 'middle'), userOnlyTurn('turn-old', 'older')],
        null,
      );

    const timeline = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!.timeline;
    const failures = timeline.filter((entry) => entry.kind === 'turnFailure');
    expect(failures).toHaveLength(1);
    const at = timeline.indexOf(failures[0]);
    expect(timeline[at - 1]).toMatchObject({
      kind: 'user',
      turnId: 'turn-old',
    });
    expect(timeline[at + 1]).toMatchObject({
      kind: 'user',
      turnId: 'turn-mid',
    });
  });

  it('leaves a parked failure alone when its turn is not in this page', () => {
    seedWithParkedFailure();

    useTimelineStore
      .getState()
      .prependHistoryForThread(
        't1',
        [answeredTurn('turn-other', 'other')],
        null,
      );

    const timeline = useTimelineStore
      .getState()
      .getThreadRuntime('t1')!.timeline;
    const failures = timeline.filter(
      (entry) => entry.kind === 'turnFailure' && entry.turnId === 'turn-old',
    );
    expect(failures).toHaveLength(1);
  });
});

describe('selection is not hydration', () => {
  // Selecting a thread used to report it hydrated, because the flat selected
  // state had no hydration field and the runtime projection hardcoded `true`.
  // That is not a read-only misreport: the flat state is persisted back into
  // `threadsById` on every update, so one selection permanently marked a
  // never-loaded thread as loaded.
  it('does not report a selected but never-loaded thread as hydrated', () => {
    const store = useTimelineStore.getState();
    store.ensureThreadState({ threadId: 't1' });
    store.selectThread('t1');

    expect(useTimelineStore.getState().getThreadRuntime('t1')!.hydrated).toBe(
      false,
    );
  });

  it('does not persist a false hydration claim when selection moves away', () => {
    const store = useTimelineStore.getState();
    store.ensureThreadState({ threadId: 't1' });
    store.ensureThreadState({ threadId: 't2' });
    store.selectThread('t1');
    // Any update while selected writes the flat state back into threadsById.
    useTimelineStore.getState().setThreadTitleForThread('t1', 'still empty');
    useTimelineStore.getState().selectThread('t2');

    expect(useTimelineStore.getState().getThreadRuntime('t1')!.hydrated).toBe(
      false,
    );
  });

  it('reports hydrated once the thread has actually been opened', () => {
    const store = useTimelineStore.getState();
    store.selectThread('t1');
    useTimelineStore.getState().hydrateOpenedThread({
      threadId: 't1',
      turnsNewestFirst: [answeredTurn('turn-1', 'hi')],
      historyCursor: null,
      readOnlyReason: null,
    });

    expect(useTimelineStore.getState().getThreadRuntime('t1')!.hydrated).toBe(
      true,
    );
  });
});
