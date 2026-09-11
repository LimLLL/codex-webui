/** Encodes the command/file controls through the shared instance-bound response path. */
import { useRequestResponse } from './use-request-response';
import type { ApprovalRequest, ResolvableApprovalDecision } from '@/types/approval';

/** Converts a user choice to the pinned command/file response value. */
function toRpcDecision(decision: ResolvableApprovalDecision): string {
  switch (decision) {
    case 'accepted': return 'accept';
    case 'acceptedForSession': return 'acceptForSession';
    case 'declined': return 'decline';
    case 'cancelled': return 'cancel';
  }
}

/** Keeps policy amendment payloads tied to the exact proposal the user reviewed. */
export function useApprovalDecision(approval?: ApprovalRequest) {
  const { send, submitting } = useRequestResponse(approval);
  return {
    submitting,
    decide: (decision: ResolvableApprovalDecision) =>
      send({ decision: toRpcDecision(decision) }, decision),
    acceptWithExecPolicy: () => {
      const patterns = approval?.proposedExecpolicyAmendment;
      if (patterns?.length) send({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: patterns } } }, 'accepted');
    },
    applyNetworkAmendment: (index: number) => {
      const amendment = approval?.proposedNetworkPolicyAmendments?.[index];
      if (amendment) send({ decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } } }, 'accepted');
    },
  };
}
