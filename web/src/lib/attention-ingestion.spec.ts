/** Live delivery and recovery share one notification decision. */
import { beforeEach, expect, it, vi } from 'vitest';
import { useTimelineStore } from '@/stores/timeline-store';
import { useSnackbarStore } from '@/stores/snackbar-store';
import type { UserInputRequest } from '@/types/approval';
import { ingestAttention } from './attention-ingestion';
import { retirePendingRequest } from './pending-approvals-sync';

vi.mock('@/socket', () => ({ getSocket: () => ({ emit: vi.fn() }) }));
const initial = useTimelineStore.getState();
const request: UserInputRequest = {
  requestId: 'r',
  generation: 1,
  kind: 'userInput',
  threadId: 'background',
  turnId: 'turn',
  itemId: 'item',
  status: 'pending',
  questions: [],
};
beforeEach(() => {
  useTimelineStore.setState(initial, true);
  useSnackbarStore.getState().clear();
});

it('notifies once, retires neutrally, and never reopens an answered input on replay', () => {
  ingestAttention(request);
  ingestAttention(request);
  expect(useSnackbarStore.getState().visible).toHaveLength(1);
  retirePendingRequest({ ...request, requestId: 'r', generation: 1, status: 'resolved' });
  ingestAttention(request);
  expect(useSnackbarStore.getState().visible).toHaveLength(0);
  expect(
    useTimelineStore.getState().getThreadRuntime('background')
      ?.userInputRequests.r.status,
  ).toBe('resolved');
  ingestAttention({ ...request, generation: 2 });
  expect(useSnackbarStore.getState().visible).toHaveLength(1);
});

it('also removes a retired prompt still waiting in the snackbar queue', () => {
  for (let i = 0; i < 6; i++)
    ingestAttention({ ...request, requestId: String(i) });
  expect(useSnackbarStore.getState().queue).toHaveLength(1);
  retirePendingRequest({
    threadId: 'background',
    requestId: '5',
    generation: 1,
  });
  expect(useSnackbarStore.getState().queue).toHaveLength(0);
});
