/** Validates displayable full history without confusing older-turn pagination with item coverage. */
import type { ThreadTurnsPageDto } from '@/generated/api';
import i18n from '@/i18n';

/** Rejects missing/downgraded pages; an explicitly empty full request is valid history. */
export function assertFullHistoryPage(page: ThreadTurnsPageDto): void {
  if (
    !page ||
    !Array.isArray(page.data) ||
    page.data.some(
      (turn) => turn.itemsView !== 'full' || !Array.isArray(turn.items),
    )
  ) {
    // Surfaced verbatim in the conversation's loading gate, so it is localized
    // like any other message a reader sees rather than left at the wire level.
    throw new Error(
      i18n.t(
        'Full conversation history is unavailable. Retry loading the conversation.',
      ),
    );
  }
}
