/** Request-time snapshots must not erase or reopen newer approval events. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingApprovalsListPending } from '@/generated/api/sdk.gen';
import type { PendingServerRequestDto } from '@/generated/api';
import { approvalFromPending } from './approval-parsers';
import { userInputFromPending } from './user-input-parsers';
import { syncPendingApprovals } from './pending-approvals-sync';
import { useTimelineStore } from '@/stores/timeline-store';

vi.mock('@/socket', () => ({ getSocket: () => ({ emit: vi.fn() }) }));
vi.mock('@/generated/api/sdk.gen', () => ({ pendingApprovalsListPending: vi.fn() }));
const pristine = useTimelineStore.getState();
const read = vi.mocked(pendingApprovalsListPending);
type Reply = Awaited<ReturnType<typeof pendingApprovalsListPending<true>>>;
const reply = (requests: PendingServerRequestDto[]): Reply => ({ data: { requests } }) as Reply;

function holdRead() {
  let resolve!: (value: Reply) => void;
  read.mockReturnValueOnce(new Promise<Reply>((done) => { resolve = done; }));
  return (requests: PendingServerRequestDto[]) => resolve(reply(requests));
}

function request(id: string, threadId = 't', kind = 'approval'): PendingServerRequestDto {
  return {
    generation: 1, requestId: id, threadId, turnId: 'turn', itemId: id,
    method: kind === 'approval' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput',
    params: { threadId, turnId: 'turn', itemId: id, command: 'pwd',
      questions: [{ id: 'q', header: 'Choice', question: 'Proceed?' }] },
    status: 'pending', createdAt: 1, updatedAt: 1,
  };
}

function add(row: PendingServerRequestDto) {
  const approval = approvalFromPending(row);
  if (approval) useTimelineStore.getState().addApprovalForThread(row.threadId, approval);
  const userInput = userInputFromPending(row);
  if (userInput) useTimelineStore.getState().addUserInputRequestForThread(row.threadId, userInput);
}
function status(id: string, threadId = 't') {
  const runtime = useTimelineStore.getState().getThreadRuntime(threadId);
  return runtime?.approvals[id]?.status ?? runtime?.userInputRequests[id]?.status;
}

beforeEach(() => {
  useTimelineStore.setState(pristine, true);
  read.mockReset();
});

describe('pending request recovery', () => {
  it.each(['approval', 'userInput'])('preserves a %s raised while the list was in flight', async (kind) => {
    add(request('old', 't', kind));
    const finish = holdRead();
    const sync = syncPendingApprovals(['t']);
    add(request('new', 't', kind));
    finish([]);
    await sync;
    expect(status('old')).toBe('resolved');
    expect(status('new')).toBe('pending');
  });

  it.each(['approval', 'userInput'])('does not reopen a %s resolved during the read', async (kind) => {
    const row = request('r', 't', kind);
    add(row);
    const finish = holdRead();
    const sync = syncPendingApprovals(['t']);
    useTimelineStore.getState().resolveApprovalByRequestIdForThread('t', 'r');
    finish([row]);
    await sync;
    expect(status('r')).toBe('resolved');
  });

  it('restores missed requests but retains an early resolved notification', async () => {
    const finish = holdRead();
    const sync = syncPendingApprovals();
    useTimelineStore.getState().resolveApprovalByRequestIdForThread('t', 'resolved');
    finish([request('missed'), request('resolved')]);
    await sync;
    expect(status('missed')).toBe('pending');
    expect(status('resolved')).toBe('resolved');
  });

  it('limits both insertion and resolution to the requested conversations', async () => {
    add(request('local', 'other'));
    read.mockResolvedValueOnce(reply([request('ours'), request('new', 'other')]));
    await syncPendingApprovals(['t']);
    expect(status('ours')).toBe('pending');
    expect(status('local', 'other')).toBe('pending');
    expect(status('new', 'other')).toBeUndefined();
    await syncPendingApprovals([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not revive unseen requests after a newer scoped empty snapshot', async () => {
    const oldFinish = holdRead();
    const oldSync = syncPendingApprovals();
    read.mockResolvedValueOnce(reply([]));
    await syncPendingApprovals(['t']);
    oldFinish([request('stale'), request('valid', 'other')]);
    await oldSync;
    expect(status('stale')).toBeUndefined();
    expect(status('valid', 'other')).toBe('pending');
  });

  it('does not recreate a thread deleted during the read', async () => {
    add(request('r'));
    const finish = holdRead();
    const sync = syncPendingApprovals();
    useTimelineStore.getState().forgetThreads(['t']);
    finish([request('r')]);
    await sync;
    expect(useTimelineStore.getState().getThreadRuntime('t')).toBeNull();
  });

  it('retains local state on a failed read', async () => {
    add(request('r'));
    read.mockRejectedValueOnce(new TypeError('offline'));
    await syncPendingApprovals();
    expect(status('r')).toBe('pending');
  });
});
