/** Request-instance races through the real timeline store, independent of rendering. */
import { beforeEach, expect, it, vi } from 'vitest';
import { useTimelineStore } from './timeline-store';
import type { ApprovalRequest, UserInputRequest } from '@/types/approval';

vi.mock('@/socket', () => ({ getSocket: () => ({ emit: vi.fn() }) }));
const initial = useTimelineStore.getState();

/** A displayed proposal with the wire identity a replacement connection can reuse. */
function approval(instanceId: string): ApprovalRequest {
  return { requestId: 0, instanceId, generation: 1, kind: 'command',
    threadId: 't', turnId: 'turn', itemId: 'item', status: 'pending', command: 'pwd' };
}

beforeEach(() => {
  useTimelineStore.setState(initial, true);
  useTimelineStore.getState().selectThread('t');
});

it.each(['approval', 'userInput'] as const)('consumes an instance tombstone once for %s without reopening it on replay', (kind) => {
  const store = useTimelineStore.getState();
  store.resolveApprovalByRequestIdForThread('t', 0, 1, 'instance');
  const request = approval('instance');
  const input: UserInputRequest = { ...request, turnId: 'turn', kind: 'userInput', status: 'pending', questions: [] };
  const receive = () => kind === 'approval'
    ? store.addApprovalForThread('t', request) : store.addUserInputRequestForThread('t', input);
  receive(); receive();
  const runtime = store.getThreadRuntime('t')!;
  expect(runtime.pendingResolvedRequestIds.size).toBe(0);
  expect((kind === 'approval' ? runtime.approvals : runtime.userInputRequests)['0'].status).toBe('resolved');
});

it('cannot attribute a stale successful HTTP response to a different instance with the same generation and wire ID', () => {
  const store = useTimelineStore.getState();
  store.addApprovalForThread('t', approval('old'));
  store.addApprovalForThread('t', approval('replacement'));
  store.resolveApprovalByRequestIdForThread('t', 0, 1, 'old', 'submitted', 'accepted');
  expect(store.getThreadRuntime('t')!.approvals['0']).toMatchObject({ instanceId: 'replacement', status: 'pending' });
  expect(store.getThreadRuntime('t')!.approvals['0'].decision).toBeUndefined();
});

it('does not attribute another browser’s submission or retirement to this browser', () => {
  const store = useTimelineStore.getState();
  store.addApprovalForThread('t', approval('instance'));
  store.resolveApprovalByRequestIdForThread('t', 0, 1, 'instance', 'submitted');
  store.resolveApprovalByRequestIdForThread('t', 0, 1, 'instance', 'resolved');
  expect(store.getThreadRuntime('t')!.approvals['0'].decision).toBeUndefined();
});
