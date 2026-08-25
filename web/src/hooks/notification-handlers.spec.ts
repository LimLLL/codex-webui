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
