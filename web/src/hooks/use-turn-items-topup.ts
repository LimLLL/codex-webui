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
  const applyRecoveredTurnItems = useTimelineStore(
    (s) => s.applyRecoveredTurnItemsForThread,
  );
  const enabled = Boolean(threadId) && itemsView === 'summary' && completed;

  const { data } = useQuery({
    ...threadsListTurnItemsOptions({
      path: { threadId: threadId ?? '', turnId },
    }),
    enabled,
    // Existing complete-turn cache policy. The shell stability probe does not
    // establish immutability for late sub-agent activity or cold resumes; that
    // measurement remains tracked in remaining-tasks.md. Partial reads stay
    // refetchable — see below.
    staleTime: (query) => (query.state.data?.complete ? Infinity : 0),
  });

  useEffect(() => {
    if (!threadId || !data?.items) return;
    if (data.complete) {
      applyFullTurnItems(
        threadId,
        turnId,
        data.items as Array<Record<string, unknown>>,
      );
      return;
    }
    // An incomplete read must not be published as the turn's full history. The
    // endpoint reports its own completeness, and an early stop — paging
    // unavailable, a cursor that ran out — can return zero items. Marking that
    // `full` retired the turn from ever being topped up again, so a transcript
    // truncated by one bad response stayed truncated for the session.
    //
    // What it holds is still worth merging under the recovery rules, where a
    // snapshot repairs gaps without claiming authority over what is on screen.
    // Query data may have come from an earlier request or the shared cache.
    // Its issue-time baseline is unknown, so conservatively retain every
    // terminal observation, just like the full top-up. Fragments still repair
    // by replacement. Stamping the response NOW would falsely rank it above
    // notifications received while the request was in flight.
    applyRecoveredTurnItems(
      threadId,
      turnId,
      data.items as Array<Record<string, unknown>>,
      -1,
    );
  }, [threadId, turnId, data, applyFullTurnItems, applyRecoveredTurnItems]);
}
