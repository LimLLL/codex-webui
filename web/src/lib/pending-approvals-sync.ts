/** Repairs approval and user-input events missed while the socket was away. */
import { pendingApprovalsListPending } from '@/generated/api/sdk.gen';
import { approvalFromPending } from '@/lib/approval-parsers';
import { userInputFromPending } from '@/lib/user-input-parsers';
import { useTimelineStore } from '@/stores/timeline-store';

// Startup and reconnect can overlap. A newer scoped read supersedes only those
// threads in an older read, including when the newer response lists no requests.
// These records live only as long as their HTTP request, not as another cache.
const activeReads = new Set<{ superseded: boolean; excluded: Set<string> }>();

/**
 * Applies the server's pending set without undoing newer local observations.
 * Absence resolves only requests already pending when this read was issued.
 *
 * @param threadIds - Conversations to reconcile, or undefined for all of them
 * @param signal - Aborts the read and refuses to apply a late response
 */
export async function syncPendingApprovals(
  threadIds?: Iterable<string>,
  signal?: AbortSignal,
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
    [...(scope ?? Object.keys(before.threadsById))].map((id) =>
      [id, before.getThreadRuntime(id)] as const,
    ),
  );
  for (const older of activeReads) {
    if (scope) for (const id of scope) older.excluded.add(id);
    else older.superseded = true;
  }
  const read = { superseded: false, excluded: new Set<string>() };
  activeReads.add(read);
  const includes = (id: string) =>
    !read.superseded && !read.excluded.has(id) && (!scope || scope.has(id));

  try {
    const { data } = await pendingApprovalsListPending({ signal });
    if (!data || signal?.aborted) return;
    const store = useTimelineStore.getState();
    const stillPending = new Map<string, Set<string>>();
    for (const request of data.requests) {
      if (!includes(request.threadId) || request.status !== 'pending') continue;
      const requestId = String(request.requestId);
      const ids = stillPending.get(request.threadId) ?? new Set<string>();
      ids.add(requestId);
      stillPending.set(request.threadId, ids);
      const runtime = store.getThreadRuntime(request.threadId);
      // A known conversation deleted during the request must stay deleted.
      if (baseline.get(request.threadId) && !runtime) continue;
      // Existing cards already have the payload; replacing them could reopen a
      // decision made while this read was in flight or erase a local answer.
      if (runtime?.approvals[requestId] || runtime?.userInputRequests[requestId]) continue;
      const approval = approvalFromPending(request);
      if (approval) store.addApprovalForThread(request.threadId, approval);
      const userInput = userInputFromPending(request);
      if (userInput) store.addUserInputRequestForThread(request.threadId, userInput);
    }

    for (const [threadId, held] of baseline) {
      if (!includes(threadId) || !held) continue;
      const runtime = store.getThreadRuntime(threadId);
      if (!runtime) continue;
      const pending = stillPending.get(threadId);
      for (const [requestId, approval] of Object.entries(held.approvals)) {
        if (approval.status !== 'pending' || pending?.has(requestId)) continue;
        if (runtime.approvals[requestId] !== approval) continue;
        store.resolveApprovalByRequestIdForThread(threadId, requestId);
      }
      for (const [requestId, request] of Object.entries(held.userInputRequests)) {
        if (request.status !== 'pending' || pending?.has(requestId)) continue;
        if (runtime.userInputRequests[requestId] !== request) continue;
        store.resolveApprovalByRequestIdForThread(threadId, requestId);
      }
    }
  } catch {
    // Transport failure proves neither creation nor resolution of a request.
  } finally {
    activeReads.delete(read);
  }
}
