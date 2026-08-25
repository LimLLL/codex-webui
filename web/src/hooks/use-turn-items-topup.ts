/**
 * Tops a turn up from `summary` detail to `full` when it is rendered.
 *
 * Opening a thread fetches history in app-server's `summary` view, which is
 * far cheaper but omits `reasoning` and `plan` items — so a plan generated in
 * Plan mode vanishes on refresh. Rather than paying for `full` across the whole
 * first page, each turn fetches its own items the first time it renders.
 *
 * Because the transcript is virtualized, "when it renders" already means "when
 * it is on screen", and React Query dedupes by turn id, so no viewport
 * bookkeeping is needed here.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { threadsListTurnItemsOptions } from '@/generated/api/@tanstack/react-query.gen';
import { useTimelineStore } from '@/stores/timeline-store';

interface UseTurnItemsTopUpParams {
  threadId: string | null;
  turnId: string;
  /** Detail level the turn currently holds; only `summary` needs topping up. */
  itemsView: 'notLoaded' | 'summary' | 'full' | undefined;
  /**
   * Whether the turn has finished. A running turn is being assembled from live
   * notifications, and a persisted snapshot of it would be behind by
   * construction — applying one would drop items that just streamed in.
   */
  completed: boolean;
}

export function useTurnItemsTopUp({
  threadId,
  turnId,
  itemsView,
  completed,
}: UseTurnItemsTopUpParams): void {
  const applyFullTurnItems = useTimelineStore(
    (s) => s.applyFullTurnItemsForThread,
  );
  const enabled = Boolean(threadId) && itemsView === 'summary' && completed;

  const { data } = useQuery({
    ...threadsListTurnItemsOptions({
      path: { threadId: threadId ?? '', turnId },
    }),
    enabled,
    // Persisted history for a completed turn never changes, so refetching it
    // would only ever return the same bytes.
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!threadId || !data?.items) return;
    applyFullTurnItems(
      threadId,
      turnId,
      data.items as Array<Record<string, unknown>>,
    );
  }, [threadId, turnId, data, applyFullTurnItems]);
}
