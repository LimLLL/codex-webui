/** Shared identity for human requests delivered live and through recovery. */
export interface PendingRequestIdentity {
  instanceId?: string;
  requestId: string | number;
  generation?: number | null;
}

/** RPC ids are scoped to an app-server generation, including neutral retirement. */
export function samePendingRequest(
  left: PendingRequestIdentity,
  right: PendingRequestIdentity,
): boolean {
  if (left.instanceId || right.instanceId) return !!left.instanceId && left.instanceId === right.instanceId;
  return (
    String(left.requestId) === String(right.requestId) &&
    (left.generation ?? null) === (right.generation ?? null)
  );
}

/** Key used only while a pending read is outstanding, to reject retired rows. */
export function pendingRequestKey(request: PendingRequestIdentity): string {
  if (request.instanceId) return request.instanceId;
  return JSON.stringify([
    request.generation ?? null,
    String(request.requestId),
  ]);
}
