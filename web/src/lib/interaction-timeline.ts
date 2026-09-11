/** Standalone rows for permission and MCP requests, including those with no turn. */
import type { ApprovalRequest } from '@/types/approval';
import type { TimelineEntry } from '@/types/timeline';

/** Keeps request identity independent of optional protocol turn correlation. */
export function ensureInteractionEntry(timeline: TimelineEntry[], request: ApprovalRequest): TimelineEntry[] {
  if (!request.instanceId || timeline.some((entry) => entry.kind === 'interaction' && entry.instanceId === request.instanceId)) return timeline;
  return [...timeline, { kind: 'interaction', requestId: String(request.requestId), instanceId: request.instanceId,
    ...(request.turnId && { turnId: request.turnId }) }];
}
