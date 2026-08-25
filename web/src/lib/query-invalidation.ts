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
  threadsListThreadsQueryKey,
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
 * @param queryKey - Key (or key prefix) to invalidate
 */
function scheduleInvalidate(
  queryClient: QueryClient,
  bucket: string,
  queryKey: QueryKey,
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
      void queryClient.invalidateQueries({ queryKey });
    }, DEBOUNCE_MS),
  );
}

/** Refreshes every thread-list variant shortly after the last caller. */
export function invalidateThreadListSoon(queryClient: QueryClient): void {
  scheduleInvalidate(queryClient, 'threadList', threadsListThreadsQueryKey());
}

/** Refreshes the branch topology shortly after the last caller. */
export function invalidateBranchTreesSoon(queryClient: QueryClient): void {
  scheduleInvalidate(
    queryClient,
    'branchTrees',
    threadsListBranchTreesQueryKey(),
  );
}
