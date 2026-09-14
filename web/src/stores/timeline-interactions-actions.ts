/** Conversation timeline interactions actions. */
import { ensureInteractionEntry } from '@/lib/interaction-timeline';
import { type UserInputRequest } from '../types/approval';
import { samePendingRequest } from '../lib/pending-request-identity';
import {
  type TimelineState,
  type TimelineActionContext,
} from './timeline-state';
import { ensureTurnEntry } from './timeline-items';

/** Concrete interactions mutations keep each conversation's ownership and lifecycle explicit. */
export function createTimelineInteractionsActions({
  get,
  applyThreadUpdate,
}: TimelineActionContext): Pick<
  TimelineState,
  | 'addApprovalForThread'
  | 'addUserInputRequestForThread'
  | 'resolveApprovalForThread'
  | 'resolveUserInputRequestForThread'
  | 'resolveApprovalByRequestIdForThread'
> {
  return {
    addApprovalForThread: (threadId, approval) => {
      applyThreadUpdate(threadId, (runtime) => {
        const requestKey = String(approval.requestId);
        // The same request now arrives more than once by design: live delivery
        // reaches every authenticated browser, a guard release replays what it
        // withheld, and recovery reads the same row back. Ingestion therefore
        // has to be idempotent in the one direction that matters — an answered
        // card must never be reset to pending and offered for decision again.
        const existing =
          runtime.approvals[requestKey] ??
          runtime.userInputRequests[requestKey];
        if (existing && samePendingRequest(existing, approval)) return runtime;
        const alreadyResolved =
          runtime.pendingResolvedRequestIds.has(
            approval.instanceId ?? requestKey,
          ) &&
          (approval.instanceId !== undefined || approval.generation == null);
        const finalApproval = alreadyResolved
          ? { ...approval, status: 'resolved' as const }
          : approval;
        const pendingResolvedRequestIds = new Set(
          runtime.pendingResolvedRequestIds,
        );
        // Delete the key the tombstone was actually stored under: an
        // instance-keyed one would otherwise survive its own consumption.
        if (alreadyResolved)
          pendingResolvedRequestIds.delete(approval.instanceId ?? requestKey);
        return {
          ...runtime,
          timeline:
            approval.kind === 'permissions' || approval.kind === 'elicitation'
              ? ensureInteractionEntry(runtime.timeline, approval)
              : approval.turnId
                ? ensureTurnEntry(runtime.timeline, approval.turnId)
                : runtime.timeline,
          approvals: { ...runtime.approvals, [requestKey]: finalApproval },
          userInputRequests: Object.fromEntries(
            Object.entries(runtime.userInputRequests).filter(
              ([id]) => id !== requestKey,
            ),
          ),
          pendingResolvedRequestIds,
        };
      });
    },

    addUserInputRequestForThread: (threadId, request) => {
      applyThreadUpdate(threadId, (runtime) => {
        const requestKey = String(request.requestId);
        const existing =
          runtime.userInputRequests[requestKey] ??
          runtime.approvals[requestKey];
        if (existing && samePendingRequest(existing, request)) return runtime;
        const alreadyResolved =
          runtime.pendingResolvedRequestIds.has(
            request.instanceId ?? requestKey,
          ) &&
          (request.instanceId !== undefined || request.generation == null);
        const finalRequest: UserInputRequest = alreadyResolved
          ? { ...request, status: 'resolved' }
          : request;
        const pendingResolvedRequestIds = new Set(
          runtime.pendingResolvedRequestIds,
        );
        if (alreadyResolved)
          pendingResolvedRequestIds.delete(request.instanceId ?? requestKey);
        return {
          ...runtime,
          timeline: ensureTurnEntry(runtime.timeline, request.turnId),
          approvals: Object.fromEntries(
            Object.entries(runtime.approvals).filter(
              ([id]) => id !== requestKey,
            ),
          ),
          userInputRequests: {
            ...runtime.userInputRequests,
            [requestKey]: finalRequest,
          },
          pendingResolvedRequestIds,
        };
      });
    },

    resolveApprovalForThread: (threadId, requestId, decision) => {
      const requestKey = String(requestId);
      applyThreadUpdate(threadId, (runtime) => {
        const existing = runtime.approvals[requestKey];
        if (!existing) return runtime;
        return {
          ...runtime,
          approvals: {
            ...runtime.approvals,
            [requestKey]: { ...existing, status: decision },
          },
        };
      });
    },

    resolveUserInputRequestForThread: (threadId, requestId) => {
      const requestKey = String(requestId);
      applyThreadUpdate(threadId, (runtime) => {
        const existing = runtime.userInputRequests[requestKey];
        if (!existing) return runtime;
        const resolved: UserInputRequest = { ...existing, status: 'resolved' };
        return {
          ...runtime,
          userInputRequests: {
            ...runtime.userInputRequests,
            [requestKey]: resolved,
          },
        };
      });
    },

    resolveApprovalByRequestIdForThread: (
      threadId,
      requestId,
      generation,
      instanceId,
      status = 'resolved',
      decision,
    ) => {
      const requestKey = String(requestId);
      // Global retirement is also sent for suppressed requests this browser
      // never saw. It must not create immortal empty runtimes/tombstones.
      if (
        (instanceId || generation !== undefined) &&
        !get().getThreadRuntime(threadId)
      )
        return;
      applyThreadUpdate(threadId, (runtime) => {
        const approval = runtime.approvals[requestKey];
        if (approval) {
          if (
            (instanceId || generation !== undefined) &&
            !samePendingRequest(approval, { requestId, generation, instanceId })
          )
            return runtime;
          const unresolved =
            approval.status === 'pending' || approval.status === 'submitted';
          // A WebSocket retirement can beat the successful HTTP reply carrying
          // this browser's choice. Keep that attribution without allowing the
          // older acknowledgement to undo the terminal lifecycle evidence.
          if (!unresolved && !decision) return runtime;
          return {
            ...runtime,
            approvals: {
              ...runtime.approvals,
              // The lifecycle status and what this user chose are different
              // facts: only the first is app-server's to confirm, and only the
              // second can explain the card after it stops awaiting a decision.
              [requestKey]: {
                ...approval,
                status: unresolved ? status : approval.status,
                ...(decision && { decision }),
              },
            },
          };
        }

        const userInput = runtime.userInputRequests[requestKey];
        if (userInput) {
          if (
            (userInput.status !== 'pending' &&
              userInput.status !== 'submitted') ||
            ((instanceId || generation !== undefined) &&
              !samePendingRequest(userInput, {
                requestId,
                generation,
                instanceId,
              }))
          )
            return runtime;
          const resolved: UserInputRequest = {
            ...userInput,
            status,
          };
          return {
            ...runtime,
            userInputRequests: {
              ...runtime.userInputRequests,
              [requestKey]: resolved,
            },
          };
        }

        if (status === 'submitted' || (generation !== undefined && !instanceId))
          return runtime;
        return {
          ...runtime,
          pendingResolvedRequestIds: new Set(
            runtime.pendingResolvedRequestIds,
          ).add(instanceId ?? requestKey),
        };
      });
    },
  };
}
