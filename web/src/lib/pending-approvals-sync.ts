/** Repairs approval and user-input events missed while the socket was away. */
import { pendingApprovalsListPending } from '@/generated/api/sdk.gen';
import { approvalFromPending } from '@/lib/approval-parsers';
import { userInputFromPending } from '@/lib/user-input-parsers';
import { useTimelineStore } from '@/stores/timeline-store';
import { showSnackbar } from '@/stores/snackbar-store';
import { getApiErrorMessage } from './api-error';
import type { QueryClient } from '@tanstack/react-query';
import { ingestAttention, dismissAttention } from './attention-ingestion';
import {
  pendingRequestKey,
  samePendingRequest,
} from './pending-request-identity';
import { activePendingReads as activeReads } from './pending-read-coverage';
import { ingestRequestFailure } from './server-request-failures';

// Startup and reconnect can overlap. A newer scoped read supersedes only those
// threads in an older read, including when the newer response lists no requests.
// These records live only as long as their HTTP request, not as another cache.

/** Retirement may beat a read containing a request this browser never held. */
export function retirePendingRequest(event: {
  instanceId?: string;
  threadId: string;
  requestId: string;
  generation: number;
  status?: 'submitted' | 'resolved' | 'cancelled' | 'expired' | 'failed';
}): void {
  for (const read of activeReads)
    read.retired.add(
      JSON.stringify([event.threadId, pendingRequestKey(event)]),
    );
  useTimelineStore
    .getState()
    .resolveApprovalByRequestIdForThread(
      event.threadId,
      event.requestId,
      event.generation,
      event.instanceId,
      event.status === 'submitted' ? 'submitted' : event.status === 'failed' ? 'failed' : 'resolved',
    );
  dismissAttention(event.threadId, event);
}

/**
 * Applies the server's pending set without undoing newer local observations.
 * Absence resolves only requests already pending when this read was issued.
 *
 * @param threadIds - Conversations to reconcile, or undefined for all of them
 * @param signal - Aborts the read and refuses to apply a late response
 * @param queryClient - Optional cached overview titles for background prompts
 */
export async function syncPendingApprovals(
  threadIds?: Iterable<string>,
  signal?: AbortSignal,
  queryClient?: QueryClient,
): Promise<void> {
  // A caller with a lifetime shorter than the request needs to say so. The
  // startup effect is the case that matters: logging out unmounts it, and a
  // response landing afterwards would repopulate approvals for a session the
  // user has left. Superseding handles concurrent reads; it cannot express
  // "this caller is gone".
  if (signal?.aborted) return;
  const scope = threadIds ? new Set(threadIds) : null;
  if (scope?.size === 0) return;
  const before = useTimelineStore.getState();
  const baseline = new Map(
    [...(scope ?? Object.keys(before.threadsById))].map(
      (id) => [id, before.getThreadRuntime(id)] as const,
    ),
  );
  for (const older of activeReads) {
    if (scope) for (const id of scope) older.excluded.add(id);
    else older.superseded = true;
  }
  const read = {
    superseded: false,
    excluded: new Set<string>(),
    retired: new Set<string>(),
  };
  activeReads.add(read);
  const includes = (id: string) =>
    !read.superseded && !read.excluded.has(id) && (!scope || scope.has(id));

  try {
    const { data, error, response } = await pendingApprovalsListPending({
      signal,
      meta: { silent: true },
      ...(scope && { query: { threadIds: [...scope].join(',') } }),
    });
    if (signal?.aborted) return;
    if (!data) {
      // Guard conflicts are an expected temporary inability to read, not a
      // failed user action. Other errors remain visible through the usual UI.
      if (
        error &&
        error.errorCode !== 'threads.delete_in_progress' &&
        response?.status !== 401
      ) {
        showSnackbar(getApiErrorMessage(error), 'error');
      }
      return;
    }
    const store = useTimelineStore.getState();
    for (const failure of data.failures ?? []) {
      if (!failure.threadId || includes(failure.threadId)) ingestRequestFailure(failure);
    }
    const stillPending = new Map<string, Set<string>>();
    for (const request of data.requests) {
      if (!includes(request.threadId) || (request.status !== 'pending' && request.status !== 'submitted')) continue;
      const requestId = pendingRequestKey(request);
      if (read.retired.has(JSON.stringify([request.threadId, requestId])))
        continue;
      const ids = stillPending.get(request.threadId) ?? new Set<string>();
      ids.add(requestId);
      stillPending.set(request.threadId, ids);
      const runtime = store.getThreadRuntime(request.threadId);
      // A known conversation deleted during the request must stay deleted.
      if (baseline.get(request.threadId) && !runtime) continue;
      const held =
        runtime?.approvals[String(request.requestId)] ??
        runtime?.userInputRequests[String(request.requestId)];
      const initial = baseline.get(request.threadId);
      const heldAtRead =
        initial?.approvals[String(request.requestId)] ??
        initial?.userInputRequests[String(request.requestId)];
      // Generations are identities, not timestamps (a backend restart resets
      // its counter). Request-time object evidence orders overlapping reads.
      if (held && held !== heldAtRead && !samePendingRequest(held, request))
        continue;
      const approval = approvalFromPending(request);
      if (approval) ingestAttention(approval, queryClient);
      const userInput = userInputFromPending(request);
      if (userInput) ingestAttention(userInput, queryClient);
    }

    for (const [threadId, held] of baseline) {
      if (!includes(threadId) || !held) continue;
      const runtime = store.getThreadRuntime(threadId);
      if (!runtime) continue;
      const pending = stillPending.get(threadId);
      for (const [requestId, approval] of Object.entries(held.approvals)) {
        if (
          (approval.status !== 'pending' && approval.status !== 'submitted') ||
          pending?.has(pendingRequestKey(approval))
        )
          continue;
        if (runtime.approvals[requestId] !== approval) continue;
        store.resolveApprovalByRequestIdForThread(threadId, requestId, approval.generation ?? undefined, approval.instanceId);
        dismissAttention(threadId, approval);
      }
      for (const [requestId, request] of Object.entries(
        held.userInputRequests,
      )) {
        if (
          (request.status !== 'pending' && request.status !== 'submitted') ||
          pending?.has(pendingRequestKey(request))
        )
          continue;
        if (runtime.userInputRequests[requestId] !== request) continue;
        store.resolveApprovalByRequestIdForThread(threadId, requestId, request.generation ?? undefined, request.instanceId);
        dismissAttention(threadId, request);
      }
    }
  } catch (error) {
    if (!signal?.aborted) showSnackbar(getApiErrorMessage(error), 'error');
    // Transport failure proves neither creation nor resolution of a request.
    // This includes the deliberate 409 the server returns when a deletion
    // intersects the read scope: it withholds the whole snapshot rather than
    // hiding rows, precisely so absence can keep meaning "resolved". Held
    // requests stay exactly as they are until the guard-release hint prompts
    // another read.
  } finally {
    activeReads.delete(read);
  }
}
