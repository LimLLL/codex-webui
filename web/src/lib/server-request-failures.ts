/** Presents local client failures without changing app-server-owned turn state. */
import type { ServerRequestFailureDto } from '@/generated/api';
import { useTimelineStore } from '@/stores/timeline-store';
import { showSnackbar } from '@/stores/snackbar-store';

/** Live delivery and reconnect reads share the same idempotent transcript notice. */
export function ingestRequestFailure(failure: ServerRequestFailureDto): void {
  if (!failure.threadId) {
    showSnackbar(failure.message, 'error');
    return;
  }
  const store = useTimelineStore.getState();
  const runtime = store.getThreadRuntime(failure.threadId);
  if (runtime?.timeline.some((entry) => entry.kind === 'system' && entry.requestInstanceId === failure.instanceId)) return;
  store.addSystemMessageForThread(failure.threadId, failure.message, 'error', failure.turnId ?? undefined, failure.instanceId);
}
