/** Shared identity for human requests delivered live and through recovery. */
export interface PendingRequestIdentity {
  requestId: string | number;
  generation?: number | null;
}

/** RPC ids are scoped to an app-server generation, including neutral retirement. */
export function samePendingRequest(
  left: PendingRequestIdentity,
  right: PendingRequestIdentity,
): boolean {
  return (
    String(left.requestId) === String(right.requestId) &&
    (left.generation ?? null) === (right.generation ?? null)
  );
}

/** Key used only while a pending read is outstanding, to reject retired rows. */
export function pendingRequestKey(request: PendingRequestIdentity): string {
  return JSON.stringify([
    request.generation ?? null,
    String(request.requestId),
  ]);
}
