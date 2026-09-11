/** Sends one decision for the exact immutable proposal displayed by a card. */
import { useRef, useState } from 'react';
import { pendingApprovalsRespond } from '@/generated/api/sdk.gen';
import { samePendingRequest } from '@/lib/pending-request-identity';
import { syncPendingApprovals } from '@/lib/pending-approvals-sync';
import { getApiErrorMessage } from '@/lib/api-error';
import { useTimelineStore } from '@/stores/timeline-store';
import { showSnackbar } from '@/stores/snackbar-store';
import type {
  ApprovalRequest,
  ResolvableApprovalDecision,
  UserInputRequest,
} from '@/types/approval';
import i18n from '@/i18n';

/**
 * Shares identity checks and submission state across all human interaction
 * surfaces. Only app-server retirement confirms resolution; HTTP success can
 * establish merely that the local decision was submitted.
 */
export function useRequestResponse(request?: ApprovalRequest | UserInputRequest) {
  const busy = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  /**
   * @param result - Method-specific payload the backend validates and encodes.
   * @param settled - The user's own choice, kept for display once answered.
   */
  const send = (
    result: Record<string, unknown>,
    settled?: ResolvableApprovalDecision,
  ) => {
    if (!request || busy.current || request.status !== 'pending') return;
    if (!request.instanceId) {
      showSnackbar(i18n.t('Refresh this client before answering this request.'), 'warning');
      return;
    }
    const { threadId, requestId, instanceId, generation } = request;
    const runtime = useTimelineStore.getState().getThreadRuntime(threadId);
    const held = runtime?.approvals[String(requestId)] ?? runtime?.userInputRequests[String(requestId)];
    if (held && (!samePendingRequest(held, request) || held.status !== 'pending')) return;
    busy.current = true;
    setSubmitting(true);
    void pendingApprovalsRespond({
      path: { requestId: String(requestId) }, body: { instanceId, result },
      throwOnError: true, meta: { silent: true },
    }).then(({ data }) => {
      useTimelineStore.getState().resolveApprovalByRequestIdForThread(
        threadId, requestId, generation ?? undefined, instanceId,
        data.status === 'submitted' ? 'submitted' : data.status === 'failed' ? 'failed' : 'resolved',
        settled);
    }).catch((error: unknown) => {
      showSnackbar(getApiErrorMessage(error), 'error');
      // Repair an ambiguous write or a race won by another browser; never retry the decision.
      void syncPendingApprovals([threadId]);
    }).finally(() => { busy.current = false; setSubmitting(false); });
  };
  return { send, submitting };
}
