/** Decision transport shared by standalone and inline approval cards. */
import { useRef, useState } from 'react';
import { pendingApprovalsRespond } from '@/generated/api/sdk.gen';
import { useTimelineStore } from '@/stores/timeline-store';
import { samePendingRequest } from '@/lib/pending-request-identity';
import type {
  ApprovalRequest,
  ResolvableApprovalDecision,
} from '@/types/approval';

/** Maps UI decision to Codex JSON-RPC decision value. */
function toRpcDecision(decision: ResolvableApprovalDecision): string {
  switch (decision) {
    case 'accepted':
      return 'accept';
    case 'acceptedForSession':
      return 'acceptForSession';
    case 'declined':
      return 'decline';
    case 'cancelled':
      return 'cancel';
  }
}

/**
 * Sends decisions for one approval request.
 *
 * The thread and request identity are captured here rather than read at
 * completion time: answering can outlive the conversation staying selected, and
 * resolving against whichever thread happens to be on screen later would mark
 * the wrong card answered.
 */
export function useApprovalDecision(approval?: ApprovalRequest) {
  const resolveApprovalForThread = useTimelineStore(
    (s) => s.resolveApprovalForThread,
  );
  const busy = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const send = (
    body: { result: { decision: unknown } },
    settled: ResolvableApprovalDecision,
  ) => {
    if (!approval || busy.current || approval.status !== 'pending') return;
    const { threadId, requestId } = approval;
    const current = useTimelineStore.getState().getThreadRuntime(threadId)
      ?.approvals[String(requestId)];
    if (
      current &&
      (!samePendingRequest(current, approval) || current.status !== 'pending')
    )
      return;
    if (
      approval.kind === 'fileChange' &&
      !approval.reviewChanges?.length &&
      settled !== 'declined' &&
      settled !== 'cancelled'
    )
      return;
    busy.current = true;
    setSubmitting(true);
    // `throwOnError` is required, not decorative. The generated client resolves
    // with `{ data, error }` by default and the app's error interceptor returns
    // the error rather than throwing it, so a rejected write — a 409 from
    // another device answering first, a 503 while the app-server restarts —
    // reached `.then` and marked the card Accepted while the server had done
    // nothing of the sort. A request whose response failed stays unresolved
    // until authoritative evidence arrives.
    void pendingApprovalsRespond({
      path: { requestId: String(requestId) },
      body: body as never,
      throwOnError: true,
    })
      .then(() => {
        const held = useTimelineStore.getState().getThreadRuntime(threadId)
          ?.approvals[String(requestId)];
        if (held && samePendingRequest(held, approval))
          resolveApprovalForThread(threadId, requestId, settled);
      })
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
        setSubmitting(false);
      });
  };

  return {
    submitting,
    decide: (decision: ResolvableApprovalDecision) =>
      send({ result: { decision: toRpcDecision(decision) } }, decision),
    acceptWithExecPolicy: () => {
      const patterns = approval?.proposedExecpolicyAmendment;
      if (!patterns?.length) return;
      send(
        {
          result: {
            decision: {
              acceptWithExecpolicyAmendment: { execpolicy_amendment: patterns },
            },
          },
        },
        'accepted',
      );
    },
    applyNetworkAmendment: (index: number) => {
      const amendment = approval?.proposedNetworkPolicyAmendments?.[index];
      if (!amendment) return;
      send(
        {
          result: {
            decision: {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: amendment,
              },
            },
          },
        },
        'accepted',
      );
    },
  };
}
