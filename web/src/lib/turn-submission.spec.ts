/** HTTP completion and lifecycle events can arrive in either order and across navigation. */
import { beforeEach, expect, it, vi } from 'vitest';
import { useTimelineStore } from '@/stores/timeline-store';
import {
  captureTurnSubmission,
  acceptTurnSubmission,
  rejectTurnSubmission,
} from './turn-submission';

vi.mock('@/socket', () => ({
  getSocket: () => ({ emit: vi.fn(), connected: false }),
}));
const initial = useTimelineStore.getState();
const turn = (id: string) => ({
  turn: {
    id,
    status: 'inProgress' as const,
    items: [],
    itemsView: 'notLoaded' as const,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  },
});

beforeEach(() => {
  useTimelineStore.setState(initial, true);
  useTimelineStore.getState().selectThread('a');
});

it('keeps a submitted conversation busy before its first lifecycle event', () => {
  const store = useTimelineStore.getState();
  store.addUserMessage('first');
  const submission = captureTurnSubmission('a');
  expect(store.isThreadBusy('a')).toBe(true);
  store.selectThread('b');
  acceptTurnSubmission(submission, turn('turn-a'));
  expect(store.getThreadRuntime('a')).toMatchObject({
    activeTurnId: 'turn-a',
    turnStartPending: false,
  });
  expect(store.isThreadBusy('b')).toBe(false);
});

it('does not let an old success clear a new submission after lifecycle already completed', () => {
  const store = useTimelineStore.getState();
  store.addUserMessage('first');
  const first = captureTurnSubmission('a');
  store.setActiveTurnIdForThread('a', 'old');
  store.updateCurrentTurnForThread('a', 'old', (items) => ({
    items,
    completed: true,
  }));
  store.clearActiveTurnForThread('a');
  store.addUserMessage('second');
  acceptTurnSubmission(first, turn('old'));
  expect(store.getThreadRuntime('a')).toMatchObject({
    turnStartPending: true,
    activeTurnId: null,
  });
});

it('releases a definitive refusal but retains uncertain delivery for recovery', () => {
  const store = useTimelineStore.getState();
  store.addUserMessage('first');
  rejectTurnSubmission(captureTurnSubmission('a'), {
    statusCode: 409,
    message: 'refused',
  });
  expect(store.isThreadBusy('a')).toBe(false);
  store.addUserMessage('second');
  rejectTurnSubmission(
    captureTurnSubmission('a'),
    new TypeError('Network connection lost'),
  );
  expect(store.isThreadBusy('a')).toBe(true);
});

it('settles a completed turn whose start event was missed, without leaving submission pending', () => {
  const store = useTimelineStore.getState();
  store.addUserMessage('first');
  const submission = captureTurnSubmission('a');
  store.updateCurrentTurnForThread('a', 'ended', () => ({
    items: [],
    completed: true,
  }));
  acceptTurnSubmission(submission, turn('ended'));
  expect(store.getThreadRuntime('a')).toMatchObject({
    activeTurnId: null,
    turnStartPending: false,
  });
});

it('does not bind a newer rejected prompt to an old HTTP acknowledgement', () => {
  const store = useTimelineStore.getState(); store.addUserMessage('first');
  const first = captureTurnSubmission('a');
  store.setActiveTurnIdForThread('a', 'old');
  store.updateCurrentTurnForThread('a', 'old', (items) => ({ items, completed: true }));
  store.clearActiveTurnForThread('a'); store.addUserMessage('second');
  store.setTurnStartPendingForThread('a', false);
  acceptTurnSubmission(first, turn('old'));
  expect(store.getThreadRuntime('a')?.timeline.find((entry) => entry.kind === 'user' && entry.content === 'second'))
    .not.toHaveProperty('turnId');
});
