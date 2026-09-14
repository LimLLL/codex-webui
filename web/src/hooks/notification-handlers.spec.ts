/**
 * Regression tests for settings/goal notification handling.
 *
 * Entering Plan mode makes app-server rewrite the thread's reasoning effort.
 * The composer badge reads a session-wide local override, so it has to be
 * resynced from the notification — but only for the thread the user is looking
 * at, or a background thread's settings would silently rewrite the badge for
 * the visible one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const emit = vi.fn();
vi.mock('../socket', () => ({
  getSocket: () => ({ emit, on: vi.fn(), off: vi.fn() }),
}));

const { handleNotification } = await import('./notification-handlers');
const { useModelStore } = await import('../stores/model-store');
const { useTimelineStore } = await import('../stores/timeline-store');

function makeCtx() {
  return {
    threadId: null as string | null,
    getSelectedThreadId: () => 'visible',
    queryClient: { invalidateQueries: vi.fn() },
  } as unknown as Parameters<typeof handleNotification>[2];
}

function settingsPayload(threadId: string, effort: string | null) {
  return {
    threadId,
    threadSettings: { model: 'gpt-5', effort, collaborationMode: null },
  };
}

it('surfaces the upstream unsupported-tier warning without inventing a replacement value', () => {
  const ctx = makeCtx();
  ctx.addSystemMessage = vi.fn();
  const message = 'Configured service tier `unsupported` is not advertised as supported and will be omitted from requests.';
  handleNotification('warning', { threadId: 'visible', message }, ctx);
  expect(ctx.addSystemMessage).toHaveBeenCalledWith(message, 'warning');
});

describe('thread/settings/updated', () => {
  beforeEach(() => {
    useModelStore.getState().clearOverrides();
    useModelStore.setState({ observedEffortByThread: {} });
    useTimelineStore.setState({ selectedThreadId: 'visible' });
  });

  it('records the observed effort against its own thread', () => {
    handleNotification(
      'thread/settings/updated',
      settingsPayload('visible', 'medium'),
      makeCtx(),
    );

    expect(useModelStore.getState().observedEffortByThread.visible).toBe(
      'medium',
    );
  });

  // `effortOverride` is sent with turn/start, so writing an observed effort
  // into it would force one thread's Plan-imposed effort onto the next thread
  // the user sends to. This separation is the whole point.
  it('never writes an observed effort into the user override', () => {
    useModelStore.getState().setEffortOverride('xhigh');

    handleNotification(
      'thread/settings/updated',
      settingsPayload('visible', 'medium'),
      makeCtx(),
    );

    expect(useModelStore.getState().effortOverride).toBe('xhigh');
  });

  it('keeps observed efforts of different threads apart', () => {
    handleNotification(
      'thread/settings/updated',
      settingsPayload('visible', 'medium'),
      makeCtx(),
    );
    handleNotification(
      'thread/settings/updated',
      settingsPayload('other', 'low'),
      makeCtx(),
    );

    const observed = useModelStore.getState().observedEffortByThread;
    expect(observed.visible).toBe('medium');
    expect(observed.other).toBe('low');
  });

  it('records a null effort rather than dropping the entry', () => {
    handleNotification(
      'thread/settings/updated',
      settingsPayload('visible', null),
      makeCtx(),
    );

    expect(useModelStore.getState().observedEffortByThread).toHaveProperty(
      'visible',
      null,
    );
  });

  it('invalidates the collaboration mode query for the thread', () => {
    const ctx = makeCtx();
    handleNotification(
      'thread/settings/updated',
      settingsPayload('visible', 'medium'),
      ctx,
    );

    expect(ctx.queryClient.invalidateQueries).toHaveBeenCalled();
  });
});

describe('thread/goal notifications', () => {
  it('invalidates the goal query on update and on clear', () => {
    for (const method of ['thread/goal/updated', 'thread/goal/cleared']) {
      const ctx = makeCtx();
      handleNotification(method, { threadId: 'visible' }, ctx);
      expect(ctx.queryClient.invalidateQueries).toHaveBeenCalled();
    }
  });

  it('ignores a goal notification with no thread id', () => {
    const ctx = makeCtx();
    handleNotification('thread/goal/updated', {}, ctx);
    expect(ctx.queryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});

/**
 * A send is a distinct fact from a running turn, and it has to be released on
 * weaker evidence. `turnStartPending` exists only between a submission and the
 * lifecycle that claims it, so the events that end a thread's work must clear
 * it even when this client never learned which turn the submission became —
 * otherwise Send stays disabled with nothing left to re-enable it.
 */
describe('releasing an outstanding submission', () => {
  function submittingCtx() {
    const ctx = makeCtx();
    ctx.threadId = 'visible';
    ctx.setTurnStartPending = vi.fn();
    ctx.clearActiveTurn = vi.fn();
    ctx.updateCurrentTurn = vi.fn();
    ctx.upsertTurnFailure = vi.fn();
    ctx.getActiveTurnId = () => null;
    ctx.isTurnTerminal = () => false;
    return ctx;
  }

  it('clears it when a turn completes that this client never saw start', () => {
    const ctx = submittingCtx();
    handleNotification(
      'turn/completed',
      { threadId: 'visible', turn: { id: 'unseen', status: 'completed' } },
      ctx,
    );
    expect(ctx.setTurnStartPending).toHaveBeenCalledWith(false);
  });

  it('clears it on a fatal thread error that names no turn', () => {
    const ctx = submittingCtx();
    handleNotification(
      'error',
      {
        threadId: 'visible',
        willRetry: false,
        error: { message: 'start refused' },
      },
      ctx,
    );
    expect(ctx.setTurnStartPending).toHaveBeenCalledWith(false);
    // The active pointer still needs turn-level evidence: an unnamed failure
    // must not declare some other running turn finished.
    expect(ctx.clearActiveTurn).not.toHaveBeenCalled();
  });

  it('does not release a newer submission on replay of an already-terminal turn', () => {
    for (const method of ['turn/completed', 'error']) {
      const ctx = submittingCtx();
      ctx.isTurnTerminal = () => true;
      handleNotification(method, method === 'error'
        ? { threadId: 'visible', turnId: 'old', willRetry: false, error: { message: 'old failure' } }
        : { threadId: 'visible', turn: { id: 'old', status: 'completed' } }, ctx);
      expect(ctx.setTurnStartPending).not.toHaveBeenCalled();
      expect(ctx.clearActiveTurn).not.toHaveBeenCalled();
    }
  });

  it('keeps a known active turn busy after a fatal unnamed error', () => {
    const ctx = submittingCtx(); ctx.getActiveTurnId = () => 'running';
    handleNotification('error', { threadId: 'visible', willRetry: false, error: { message: 'submission failed' } }, ctx);
    expect(ctx.setTurnStartPending).toHaveBeenCalledWith(false);
    expect(ctx.clearActiveTurn).not.toHaveBeenCalled();
  });

  it('keeps it pending across a retryable error', () => {
    const ctx = submittingCtx();
    handleNotification(
      'error',
      {
        threadId: 'visible',
        willRetry: true,
        error: { message: 'rate limited' },
      },
      ctx,
    );
    // The turn is still going to happen; releasing Send here would let a
    // second copy of the same prompt be submitted during the retry.
    expect(ctx.setTurnStartPending).not.toHaveBeenCalled();
  });
});
