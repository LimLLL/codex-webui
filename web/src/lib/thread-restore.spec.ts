/** Restoration must remain passive on reconnect and respect discarded state. */
import { beforeEach, expect, it, vi } from 'vitest';
import { restoreThread } from './thread-restore';
import { useTimelineStore } from '@/stores/timeline-store';

const calls = vi.hoisted(() => ({
  read: vi.fn(),
  resume: vi.fn(),
  recover: vi.fn(async () => undefined),
  apply: vi.fn(async () => undefined),
  auxiliary: vi.fn(async () => undefined),
  policy: vi.fn(async () => undefined),
}));
vi.mock('@/socket', () => ({
  getSocket: () => ({ connected: false, emit: vi.fn() }),
}));
vi.mock('@/generated/api/sdk.gen', () => ({
  threadsReadThread: calls.read,
  threadsResumeThread: calls.resume,
}));
vi.mock('@/hooks/use-thread-open', () => ({
  applyOpenResponse: calls.apply,
  hydrateAuxiliaryData: calls.auxiliary,
}));
vi.mock('@/lib/thread-recovery', () => ({
  recoverThreadAfterReconnect: calls.recover,
}));
vi.mock('@/stores/thread-policy-store', () => ({
  refreshThreadPolicy: calls.policy,
  settleIfObserved: vi.fn(),
  forgetThreadPolicy: vi.fn(),
  useThreadPolicyStore: { getState: () => ({ pendingByThread: {} }) },
}));
const initial = useTimelineStore.getState();
beforeEach(() => {
  useTimelineStore.setState(initial, true);
  useTimelineStore.getState().ensureThreadState({ threadId: 't' });
  vi.clearAllMocks();
  calls.read.mockResolvedValue({
    data: {
      thread: { id: 't', name: 'current title', status: { type: 'idle' } },
    },
  });
});

it('reconnect repairs metadata and auxiliary data without resuming a goal-carrying thread', async () => {
  const store = useTimelineStore.getState();
  store.setThreadStatusForThread('t', { type: 'active', activeFlags: [] });
  await restoreThread('t', 'reconnect');
  expect(calls.resume).not.toHaveBeenCalled();
  expect(calls.recover).toHaveBeenCalledExactlyOnceWith('t');
  expect(calls.auxiliary).toHaveBeenCalledExactlyOnceWith('t');
  expect(calls.policy).toHaveBeenCalledExactlyOnceWith('t');
  expect(store.getThreadRuntime('t')?.threadStatus).toEqual({ type: 'idle' });
});

it('a metadata snapshot cannot roll back live status received during it', async () => {
  let finish!: (value: unknown) => void;
  calls.read.mockReturnValueOnce(
    new Promise((done) => {
      finish = done;
    }),
  );
  const repair = restoreThread('t', 'reconnect');
  useTimelineStore
    .getState()
    .setThreadStatusForThread('t', {
      type: 'active',
      activeFlags: ['waitingOnUserInput'],
    });
  finish({ data: { thread: { id: 't', status: { type: 'idle' } } } });
  await repair;
  expect(
    useTimelineStore.getState().getThreadRuntime('t')?.threadStatus,
  ).toMatchObject({ type: 'active' });
});

it('reports a restart resume failure, but never recreates a deleted runtime on failure', async () => {
  calls.resume.mockRejectedValueOnce(new Error('unavailable'));
  await expect(restoreThread('t', 'appServerRestart')).rejects.toThrow(
    'unavailable',
  );
  let fail!: (error: Error) => void;
  calls.resume.mockReturnValueOnce(
    new Promise((_done, reject) => {
      fail = reject;
    }),
  );
  const repair = restoreThread('t', 'appServerRestart');
  useTimelineStore.getState().forgetThreads(['t']);
  fail(new Error('gone'));
  await repair;
  expect(useTimelineStore.getState().getThreadRuntime('t')).toBeNull();
});
