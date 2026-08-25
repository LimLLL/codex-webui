/**
 * Regression test for the destructive-action double-submit guard.
 *
 * `disabled` on the confirm button only takes effect after React paints, so two
 * clicks landing in the same frame both reach the handler. The handler therefore
 * re-checks the same predicate itself; this pins that down so the guard cannot be
 * quietly dropped back to the attribute alone.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadDeletePreviewDto } from '@/generated/api/types.gen';
import { DeleteConversationDialog } from './delete-conversation-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/use-breakpoint', () => ({ useIsMobile: () => true }));

// React Flow is lazy-loaded and irrelevant here; mobile mode already renders the
// list instead of the graph, but the mock keeps the module out of the test.
vi.mock('./branch-graph', () => ({ BranchGraphPreview: () => null }));

function makePreview(
  overrides: Partial<ThreadDeletePreviewDto> = {},
): ThreadDeletePreviewDto {
  return {
    targetThreadId: 't1',
    treeRootThreadId: 't1',
    threadIds: ['t1'],
    deleteOrder: ['t1'],
    threads: [
      {
        threadId: 't1',
        parentThreadId: null,
        name: 'Doomed thread',
        active: false,
        pendingApprovalCount: 0,
        archived: false,
        source: 'local',
      },
    ],
    runningThreadIds: [],
    pendingApprovalThreadIds: [],
    pendingApprovals: [],
    canDelete: true,
    blockers: [],
    adoption: { state: 'ready' },
    ...overrides,
  } as unknown as ThreadDeletePreviewDto;
}

function renderDialog(props: Partial<{ pending: boolean; canDelete: boolean }> = {}) {
  const onConfirm = vi.fn();
  const ui = (pending: boolean) => (
    <DeleteConversationDialog
      open
      preview={makePreview(
        props.canDelete === false ? { canDelete: false } : {},
      )}
      loading={false}
      errorMessage={null}
      pending={pending}
      currentThreadId="t1"
      onConfirm={onConfirm}
      onClose={vi.fn()}
    />
  );
  const { rerender } = render(ui(props.pending ?? false));
  const setPending = (pending: boolean) => rerender(ui(pending));
  // The label flips to the progress text once a delete is in flight.
  const button = () =>
    screen.getByRole('button', { name: /Delete permanently|Deleting…/ });
  return { onConfirm, button, setPending };
}

describe('DeleteConversationDialog', () => {
  it('fires one cascade for a double click landing before a repaint', () => {
    const { onConfirm, button } = renderDialog();

    fireEvent.click(button());
    fireEvent.click(button());

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not confirm while a delete is already in flight', () => {
    const { onConfirm, button } = renderDialog({ pending: true });

    fireEvent.click(button());

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not confirm when the server says the tree cannot be deleted', () => {
    const { onConfirm, button } = renderDialog({ canDelete: false });

    fireEvent.click(button());

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('releases the latch once the mutation settles', () => {
    // Call sites keep this dialog mounted and only toggle `open`, so the latch
    // outlives a single delete. Without the release, the button is dead for
    // every subsequent delete in the session — success or failure alike, since
    // `onFinished` closes the dialog on both.
    const { onConfirm, button, setPending } = renderDialog();

    fireEvent.click(button());
    setPending(true);
    setPending(false);
    fireEvent.click(button());

    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
