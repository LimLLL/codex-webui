/** Local provenance, out-of-order terminal delivery and conservative unknown-work retention. */
import { CodexAcceptedWork } from './codex-accepted-work';

function finished(
  work: CodexAcceptedWork,
  threadId: string,
  id: string,
  status = 'completed',
) {
  work.notification('turn/completed', { threadId, turn: { id, status } });
}

/** Replays the real compaction opening: a fresh turn carrying a contextCompaction item. */
function compactionTurn(
  work: CodexAcceptedWork,
  threadId: string,
  turnId: string,
) {
  work.notification('turn/started', {
    threadId,
    turn: { id: turnId, status: 'inProgress' },
  });
  work.notification('item/started', {
    threadId,
    turnId,
    item: { type: 'contextCompaction', id: `${turnId}-item` },
  });
}

describe('CodexAcceptedWork', () => {
  let work: CodexAcceptedWork;
  beforeEach(() => {
    work = new CodexAcceptedWork();
  });
  it.each(['turn/start', 'review/start', 'thread/queue/start'])(
    'retains %s after its response until the matching terminal event',
    (method) => {
      work.dispatch(1, method, { threadId: 'parent' });
      work.response(1, {
        turn: { id: 'turn', status: 'inProgress' },
        reviewThreadId: method === 'review/start' ? 'review' : undefined,
      });
      const threadId = method === 'review/start' ? 'review' : 'parent';
      work.notification('thread/status/changed', {
        threadId,
        status: { type: 'idle' },
      });
      finished(work, threadId, 'other');
      finished(work, 'elsewhere', 'turn');
      expect(work.blockers()).toEqual([
        expect.objectContaining({
          threadId,
          turnId: 'turn',
          requestMethod: method,
        }),
      ]);
      finished(work, threadId, 'turn');
      expect(work.blockers()).toEqual([]);
    },
  );
  it.each(['completed', 'failed', 'interrupted'])(
    'handles %s arriving before the request response',
    (status) => {
      work.dispatch(1, 'turn/start', { threadId: 't' });
      finished(work, 't', 'turn', status);
      expect(work.blockers()).toHaveLength(1);
      work.response(1, { turn: { id: 'turn', status: 'inProgress' } });
      expect(work.blockers()).toEqual([]);
    },
  );
  it('does not infer ownership from external turn/status/goal notifications', () => {
    work.notification('turn/started', {
      threadId: 'external',
      turn: { id: 'turn', status: 'inProgress' },
    });
    work.notification('thread/goal/updated', {
      threadId: 'external',
      goal: { status: 'active' },
    });
    expect(work.blockers()).toEqual([]);
  });
  it('clears a dispatched compaction on its own turn, not on idle or elapsed time', () => {
    // Measured against the pinned app-server: the acknowledgement is empty, then
    // the compaction runs in a turn of its own whose contextCompaction item
    // carries that turn id, and turn/completed reports the terminal status.
    vi.useFakeTimers();
    try {
      work.dispatch(1, 'thread/compact/start', { threadId: 't' });
      work.response(1, {});
      work.notification('thread/status/changed', {
        threadId: 't',
        status: { type: 'idle' },
      });
      finished(work, 't', 'other');
      vi.advanceTimersByTime(86_400_000);
      expect(work.blockers()[0].reason).toContain('Cannot establish idle');
      compactionTurn(work, 't', 'compaction-turn');
      expect(work.blockers()[0].reason).toContain(
        'no observed terminal transition',
      );
      finished(work, 't', 'compaction-turn');
      expect(work.blockers()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not take a turn that was already running at acknowledgement', () => {
    // Automatic compaction does not go through this client and emits the same
    // item from inside a turn that started earlier.
    work.notification('turn/started', {
      threadId: 't',
      turn: { id: 'automatic-turn', status: 'inProgress' },
    });
    work.dispatch(1, 'thread/compact/start', { threadId: 't' });
    work.response(1, {});
    work.notification('item/started', {
      threadId: 't',
      turnId: 'automatic-turn',
      item: { type: 'contextCompaction', id: 'automatic' },
    });
    finished(work, 't', 'automatic-turn');
    expect(work.blockers()).toHaveLength(1);
    compactionTurn(work, 't', 'ours');
    finished(work, 't', 'ours');
    expect(work.blockers()).toEqual([]);
  });
  it('binds one turn to one reservation when compactions overlap', () => {
    work.dispatch(1, 'thread/compact/start', { threadId: 't' });
    work.response(1, {});
    work.dispatch(2, 'thread/compact/start', { threadId: 't' });
    work.response(2, {});
    compactionTurn(work, 't', 'first');
    compactionTurn(work, 't', 'second');
    finished(work, 't', 'first');
    expect(work.blockers()).toHaveLength(1);
    finished(work, 't', 'second');
    expect(work.blockers()).toEqual([]);
  });
  it('ignores a repeated terminal notification for the same compaction turn', () => {
    work.dispatch(1, 'thread/compact/start', { threadId: 't' });
    work.response(1, {});
    work.dispatch(2, 'thread/compact/start', { threadId: 't' });
    work.response(2, {});
    compactionTurn(work, 't', 'first');
    finished(work, 't', 'first');
    finished(work, 't', 'first');
    expect(work.blockers()).toHaveLength(1);
  });
  it('holds a compaction whose item names no turn, and one with an unknown turn', () => {
    work.dispatch(1, 'thread/compact/start', { threadId: 't' });
    work.response(1, {});
    work.notification('item/started', {
      threadId: 't',
      item: { type: 'contextCompaction', id: 'no-turn' },
    });
    work.notification('item/started', {
      threadId: 't',
      turnId: 'never-observed-starting',
      item: { type: 'contextCompaction', id: 'unknown-turn' },
    });
    finished(work, 't', 'never-observed-starting');
    expect(work.blockers()).toHaveLength(1);
  });
  it('holds a compaction whose item arrives before the acknowledgement', () => {
    // The turn already existed when the response landed, so it cannot be proved
    // to be the one this request created.
    work.dispatch(1, 'thread/compact/start', { threadId: 't' });
    compactionTurn(work, 't', 'early');
    work.response(1, {});
    finished(work, 't', 'early');
    expect(work.blockers()).toHaveLength(1);
  });
  it('does not let one turn claim two reservations', () => {
    // A repeated item/started for the same turn must not bind a second entry,
    // or a single terminal turn would release both.
    work.dispatch(1, 'thread/compact/start', { threadId: 't' });
    work.response(1, {});
    work.dispatch(2, 'thread/compact/start', { threadId: 't' });
    work.response(2, {});
    compactionTurn(work, 't', 'one');
    work.notification('item/started', {
      threadId: 't',
      turnId: 'one',
      item: { type: 'contextCompaction', id: 'again' },
    });
    finished(work, 't', 'one');
    expect(work.blockers()).toHaveLength(1);
  });
  it('does not bind an ordinary turn that compacts part way through', () => {
    // Inline automatic compaction reuses a turn already doing other work.
    // Upstream never emits TurnStarted for it, but the enclosing turn may still
    // have begun after the acknowledgement.
    work.dispatch(1, 'thread/compact/start', { threadId: 't' });
    work.response(1, {});
    work.notification('turn/started', {
      threadId: 't',
      turn: { id: 'ordinary', status: 'inProgress' },
    });
    work.notification('item/started', {
      threadId: 't',
      turnId: 'ordinary',
      item: { type: 'agentMessage', id: 'reply' },
    });
    work.notification('item/started', {
      threadId: 't',
      turnId: 'ordinary',
      item: { type: 'contextCompaction', id: 'auto' },
    });
    finished(work, 't', 'ordinary');
    expect(work.blockers()).toHaveLength(1);
  });
  it('does not let a repeated turn/started make an older turn eligible', () => {
    work.notification('turn/started', {
      threadId: 't',
      turn: { id: 'old', status: 'inProgress' },
    });
    work.dispatch(1, 'thread/compact/start', { threadId: 't' });
    work.response(1, {});
    // Re-announcing the same turn must not hand it a newer ordinal.
    work.notification('turn/started', {
      threadId: 't',
      turn: { id: 'old', status: 'inProgress' },
    });
    work.notification('item/started', {
      threadId: 't',
      turnId: 'old',
      item: { type: 'contextCompaction', id: 'auto' },
    });
    finished(work, 't', 'old');
    expect(work.blockers()).toHaveLength(1);
  });
  it('does not borrow a turn ordinal from another thread', () => {
    // Turn ids are unique per thread, not globally. The other thread's turn is
    // left unclaimed on purpose, so only the thread in the key can reject it.
    work.dispatch(1, 'thread/compact/start', { threadId: 't' });
    work.response(1, {});
    work.notification('turn/started', {
      threadId: 'other-thread',
      turn: { id: 'shared', status: 'inProgress' },
    });
    work.notification('item/started', {
      threadId: 't',
      turnId: 'shared',
      item: { type: 'contextCompaction', id: 'elsewhere' },
    });
    finished(work, 't', 'shared');
    expect(work.blockers()).toHaveLength(1);
  });
  it('still holds an uncorrelated shell command until the thread closes', () => {
    work.dispatch(1, 'thread/shellCommand', { threadId: 't' });
    work.response(1, {});
    finished(work, 't', 'other');
    work.notification('item/completed', {
      threadId: 't',
      item: { type: 'commandExecution', id: 'item' },
    });
    expect(work.blockers()[0].reason).toContain('Cannot establish idle');
    work.notification('thread/closed', { threadId: 't' });
    expect(work.blockers()).toEqual([]);
  });
  it('keeps activated-goal dispatch uncertain after pause/clear and another turn completion', () => {
    work.dispatch(1, 'thread/goal/set', { threadId: 't' });
    work.response(1, { goal: { status: 'active' } });
    work.dispatch(2, 'thread/goal/set', { threadId: 't', status: 'paused' });
    work.response(2, { goal: { status: 'paused' } });
    work.notification('thread/goal/cleared', { threadId: 't' });
    finished(work, 't', 'turn');
    expect(work.blockers()).toHaveLength(1);
    work.processExited();
    expect(work.blockers()).toEqual([]);
  });
  it.each([false, true])(
    'correlates an automatically dequeued local submission (early events=%s)',
    (early) => {
      work.dispatch(1, 'thread/queue/add', { threadId: 't' });
      const response = () =>
        work.response(1, {
          queuedSubmission: { id: 'queue', clientUserMessageId: 'client' },
        });
      if (!early) response();
      work.notification('item/started', {
        threadId: 't',
        turnId: 'auto',
        item: { type: 'userMessage', clientId: 'other-client' },
      });
      finished(work, 't', 'unrelated');
      expect(work.blockers()).toHaveLength(1);
      work.notification('item/started', {
        threadId: 't',
        turnId: 'auto',
        item: { type: 'userMessage', clientId: 'client' },
      });
      finished(work, 't', 'auto');
      if (early) response();
      expect(work.blockers()).toEqual([]);
    },
  );
  it('clears a queued submission only on confirmed deletion, not an empty queue read', () => {
    work.dispatch(1, 'thread/queue/add', { threadId: 't' });
    work.response(1, {
      queuedSubmission: { id: 'q', clientUserMessageId: 'c' },
    });
    work.queueDeleted(
      { threadId: 't', queuedSubmissionId: 'q' },
      { deleted: false },
    );
    expect(work.blockers()).toHaveLength(1);
    work.queueDeleted(
      { threadId: 't', queuedSubmissionId: 'q' },
      { deleted: true },
    );
    expect(work.blockers()).toEqual([]);
  });
  it('fails closed when correlation history overflows instead of expiring records', () => {
    work.dispatch(1, 'turn/start', { threadId: 't' });
    for (let i = 0; i < 40; i += 1) finished(work, 't', String(i));
    work.response(1, { turn: { id: 'new', status: 'inProgress' } });
    finished(work, 't', 'new');
    expect(work.blockers()[0].reason).toContain('Cannot establish idle');
  });
});
