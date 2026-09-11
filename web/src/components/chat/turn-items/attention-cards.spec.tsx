/** A decision must be reviewable and remain bound to its request while sending. */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { pendingApprovalsRespond } from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import type { ApprovalRequest } from '@/types/approval';
import { ApprovalItem } from './approval-item';
import { FileChangeItem } from './file-change-item';
import { TurnBlock } from '../turn-block';

vi.mock('@/socket', () => ({
  getSocket: () => ({
    connected: true,
    emit: vi.fn(),
    timeout: () => ({ emit: vi.fn() }),
  }),
}));
vi.mock('@/generated/api/sdk.gen', () => ({
  pendingApprovalsRespond: vi.fn(),
}));
vi.mock('./git-diff-panel', () => ({
  GitDiffPanel: ({ diff }: { diff: string }) => <pre>{diff}</pre>,
}));
vi.mock('@/hooks/use-turn-items-topup', () => ({
  useTurnItemsTopUp: () => undefined,
}));
const initial = useTimelineStore.getState();
const respond = vi.mocked(pendingApprovalsRespond);
const approval = (
  changes: ApprovalRequest['reviewChanges'],
): ApprovalRequest => ({
  requestId: 'r',
  instanceId: 'proposal-1',
  generation: 1,
  kind: 'fileChange',
  threadId: 't',
  turnId: 'turn',
  itemId: 'item',
  status: 'pending',
  reviewChanges: changes,
});
const host = {
  type: 'fileChange' as const,
  itemId: 'item',
  completed: false,
  content: '',
  fileChanges: [{ path: 'stale.txt', diff: '-stale\n+cached' }],
};

beforeEach(() => {
  useTimelineStore.setState(initial, true);
  respond.mockReset();
});

it.each([{ subject: null }, { subject: undefined }, { subject: [] }])(
  'offers no affirmative file decision for an unavailable subject ($subject)',
  ({ subject }) => {
    render(
      <>
        <ApprovalItem approval={approval(subject)} />
        <FileChangeItem item={host} approval={approval(subject)} />
      </>,
    );
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Accept for session' }),
    ).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Decline' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(2);
  },
);

it('the inline card displays the retained subject, including every file and rename destination', () => {
  render(
    <FileChangeItem
      item={host}
      approval={approval([
        {
          path: 'first.txt',
          diff: '-a\n+b',
          changeKind: 'update',
          movePath: 'renamed.txt',
        },
        { path: 'second.txt', diff: '-c\n+d', changeKind: 'delete' },
      ])}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /2 files/ }));
  expect(screen.getByText('first.txt')).toBeTruthy();
  expect(screen.getByText('second.txt')).toBeTruthy();
  expect(screen.getByText(/renamed.txt/)).toBeTruthy();
  expect(screen.queryByText('stale.txt')).toBeNull();
});

it('sends once and does not settle a reused id when an old response finishes', async () => {
  const store = useTimelineStore.getState();
  const request = approval([{ path: 'a', diff: '+a', changeKind: 'add' }]);
  store.addApprovalForThread('t', request);
  let finish!: () => void;
  respond.mockReturnValueOnce(
    new Promise<Awaited<ReturnType<typeof pendingApprovalsRespond<true>>>>(
      (done) => {
        finish = () =>
          done({ data: { status: 'submitted' } } as Awaited<ReturnType<typeof pendingApprovalsRespond<true>>>);
      },
    ),
  );
  render(<FileChangeItem item={host} approval={request} />);
  fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
  fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
  expect(respond).toHaveBeenCalledTimes(1);
  store.addApprovalForThread('t', { ...request, instanceId: 'proposal-2', generation: 1 });
  store.selectThread('other');
  await act(async () => {
    finish();
  });
  expect(store.getThreadRuntime('t')?.approvals.r).toMatchObject({
    instanceId: 'proposal-2', generation: 1,
    status: 'pending',
  });
  expect(store.getThreadRuntime('other')?.approvals).toEqual({});
});

it('keeps independent file requests answerable even when they share a host item', () => {
  const store = useTimelineStore.getState();
  store.selectThread('t');
  store.addApprovalForThread('t', approval([{ path: 'first', diff: '+one' }]));
  store.addApprovalForThread('t', {
    ...approval([{ path: 'second', diff: '+two' }]),
    requestId: 'another',
  });
  render(
    <TurnBlock
      entry={{
        kind: 'turn',
        turnId: 'turn',
        items: [host],
        completed: false,
        itemsView: 'full',
      }}
    />,
  );
  expect(screen.getAllByRole('button', { name: 'Decline' })).toHaveLength(2);
});
