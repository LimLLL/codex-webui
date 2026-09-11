/** Repairs the viewed conversation after transport or app-server recovery. */
import {
  threadsReadThread,
  threadsResumeThread,
} from '@/generated/api/sdk.gen';
import {
  applyOpenResponse,
  hydrateAuxiliaryData,
} from '@/hooks/use-thread-open';
import { recoverThreadAfterReconnect } from '@/lib/thread-recovery';
import {
  currentThreadEpoch,
  invalidateThreadEpoch,
} from './thread-recovery-epoch';
import { nextObservationSeq } from '@/lib/turn-item-merge';
import {
  refreshThreadPolicy,
  settleIfObserved,
} from '@/stores/thread-policy-store';
import { useTimelineStore } from '@/stores/timeline-store';

/** Page loads use the route's normal opener; passive reconnect never resumes. */
export type RestoreReason = 'appServerRestart' | 'reconnect';

/**
 * Repairs a retained transcript and its policy after a gap.
 * Restart callers use this only after backend-owned reattachment succeeded.
 * A failed resume propagates to the caller's warning without creating a shell
 * for a conversation deleted or evicted while the request was outstanding.
 */
export async function restoreThread(
  threadId: string,
  reason: RestoreReason,
): Promise<void> {
  const store = useTimelineStore.getState();
  if (!store.getThreadRuntime(threadId)) return;
  if (reason === 'reconnect') {
    const before = store.getThreadRuntime(threadId)!;
    const epoch = currentThreadEpoch(threadId);
    // Turn headers repair the composer, but do not carry thread status. A
    // pre-gap active badge would otherwise outlive a completed turn forever.
    const metadata = threadsReadThread({
      path: { threadId },
      throwOnError: true,
    })
      .then(({ data }) => {
        const current = store.getThreadRuntime(threadId);
        if (!current || epoch !== currentThreadEpoch(threadId)) return;
        if (current.threadStatus === before.threadStatus)
          store.setThreadStatusForThread(threadId, data.thread.status);
        if (current.threadTitle === before.threadTitle)
          store.setThreadTitleForThread(
            threadId,
            data.thread.name ?? data.thread.preview,
          );
      })
      .catch(() => undefined);
    // Start recovery first: it advances the epoch shared with auxiliary reads.
    const repair = recoverThreadAfterReconnect(threadId);
    await Promise.all([
      metadata,
      repair.then(() => hydrateAuxiliaryData(threadId)),
      refreshThreadPolicy(threadId).then(() => settleIfObserved(threadId)),
    ]);
    return;
  }
  invalidateThreadEpoch(threadId);
  const epoch = currentThreadEpoch(threadId);
  const baselineSeq = nextObservationSeq();
  try {
    const { data } = await threadsResumeThread({
      path: { threadId },
      query: { recordActive: false },
      throwOnError: true,
    });
    if (
      currentThreadEpoch(threadId) !== epoch ||
      !store.getThreadRuntime(threadId)
    )
      return;
    // applyOpenResponse already owns policy, lifecycle, item and auxiliary reads.
    await applyOpenResponse(data, baselineSeq);
  } catch (error) {
    if (
      currentThreadEpoch(threadId) === epoch &&
      store.getThreadRuntime(threadId)
    ) {
      store.setLoadingForThread(threadId, false);
      throw error;
    }
  }
}
