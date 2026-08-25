/**
 * Debounced query invalidation shared by the socket dispatcher and mutations.
 *
 * A single user action usually produces both an app-server notification and a
 * mutation callback, and each used to invalidate on its own schedule. That is
 * not merely wasteful: two refetch rounds land at different times, and any list
 * whose ordering depends on the data — the sidebar folds branches into their
 * root row and lifts the root's timestamp — visibly reshuffles once per round.
 * Coalescing on a shared timer makes one action produce one refetch.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import {
  threadsListBranchTreesQueryKey,
  threadsListOverviewQueryKey,
  threadsListThreadsQueryKey,
  threadsReadBranchTreeQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';

const DEBOUNCE_MS = 300;

/**
 * Pending timers, per client and then per bucket.
 *
 * Keyed by client identity rather than bucket alone: sharing one timer across
 * clients would let the last caller's client win and silently drop the earlier
 * one's invalidation. The app has a single client today, so this only keeps the
 * helper honest if that ever stops being true.
 */
const timersByClient = new WeakMap<
  QueryClient,
  Map<string, ReturnType<typeof setTimeout>>
>();

/**
 * Schedules one invalidation per client and bucket, restarting on every call.
 *
 * @param queryClient - Client to invalidate against
 * @param bucket - Identity of the timer to share
 * @param queryKeys - Keys (or key prefixes) invalidated together on that timer
 */
function scheduleInvalidate(
  queryClient: QueryClient,
  bucket: string,
  queryKeys: QueryKey[],
): void {
  let timers = timersByClient.get(queryClient);
  if (!timers) {
    timers = new Map();
    timersByClient.set(queryClient, timers);
  }

  const pending = timers.get(bucket);
  if (pending) clearTimeout(pending);
  timers.set(
    bucket,
    setTimeout(() => {
      timers.delete(bucket);
      for (const queryKey of queryKeys) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }, DEBOUNCE_MS),
  );
}

/**
 * Refreshes every conversation-list variant shortly after the last caller.
 *
 * Both keys are scheduled on one timer rather than two. The sidebar reads the
 * server-collapsed overview while other surfaces still read the flat list, and
 * letting them land on independent schedules is precisely the mixed-moment
 * render this helper exists to prevent.
 */
export function invalidateThreadListSoon(queryClient: QueryClient): void {
  scheduleInvalidate(queryClient, 'threadList', [
    threadsListOverviewQueryKey(),
    threadsListThreadsQueryKey(),
  ]);
}

/** Refreshes the branch topology shortly after the last caller. */
export function invalidateBranchTreesSoon(queryClient: QueryClient): void {
  scheduleInvalidate(queryClient, 'branchTrees', [
    threadsListBranchTreesQueryKey(),
  ]);
}

/**
 * Refreshes the per-thread branch tree that drives the `< n/m >` switcher.
 *
 * Deleting or creating a version used to invalidate only the *list* of branch
 * trees. That is a different cache identity with no prefix relationship to the
 * single-tree read, so the switcher was never actively refreshed at all — its
 * counter changed only once its own staleness window expired, which is why a
 * deleted version kept being counted for up to thirty seconds.
 *
 * Every member of the affected tree is invalidated, not just the one acted on:
 * the query is keyed by the thread being *viewed*, and the user lands on a
 * sibling immediately after a version is removed.
 */
export function invalidateBranchTreeMembersSoon(
  queryClient: QueryClient,
  threadIds: string[],
): void {
  const unique = [...new Set(threadIds)].filter(Boolean);
  if (unique.length === 0) return;
  scheduleInvalidate(
    queryClient,
    `branchTree:${unique.join(',')}`,
    unique.map((threadId) =>
      threadsReadBranchTreeQueryKey({ path: { threadId } }),
    ),
  );
}
