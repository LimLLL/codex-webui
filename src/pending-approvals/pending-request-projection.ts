/** Isolated projection of persisted proposal contents and their request-owned subject. */
import type { PendingServerRequestRow } from '../database/schema';
import type { PendingServerRequestDto } from './dto/pending-approvals.dto';
import type { PendingApprovalContext } from './pending-approval-context';
import {
  presentInteraction,
  negativeOnlyReason,
} from './human-request-contract';

/** Projects the original parameters and retained subject without mutating either. */
export function projectPendingRequest(
  row: PendingServerRequestRow,
  context: PendingApprovalContext,
): PendingServerRequestDto {
  if (!row.instanceId)
    throw new Error('A legacy request has no response authority');
  const params = JSON.parse(row.paramsJson) as Record<string, unknown>;
  return {
    instanceId: row.instanceId,
    generation: row.generation,
    requestId: row.requestId,
    threadId: row.threadId,
    turnId: row.turnId,
    itemId: row.itemId,
    method: row.method,
    params,
    reviewSubject: context.read(row.generation, row.instanceId),
    presentation: presentInteraction(row.method, params),
    negativeOnlyReason: negativeOnlyReason(row.method, params),
    status: row.status as PendingServerRequestDto['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
