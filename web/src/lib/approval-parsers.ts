/** Runtime parsers for approval-related protocol data. */
import type {
  ApprovalRequest,
  NetworkPolicyAmendment,
  RawCommandDecision,
} from '@/types/approval';

const rawSimpleDecisions = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);

/** Parses availableDecisions from raw socket/REST params with runtime validation. */
export function parseAvailableDecisions(value: unknown): RawCommandDecision[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((d): d is RawCommandDecision => {
    if (typeof d === 'string') return rawSimpleDecisions.has(d);
    return d !== null && typeof d === 'object' &&
      ('acceptWithExecpolicyAmendment' in d || 'applyNetworkPolicyAmendment' in d);
  });
}

/** Parses a value as a string array, filtering non-strings. */
export function parseStringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : null;
}

/** Parses network policy amendments with host/action validation. */
export function parseNetworkAmendments(value: unknown): NetworkPolicyAmendment[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is NetworkPolicyAmendment => {
    if (item === null || typeof item !== 'object') return false;
    const r = item as Record<string, unknown>;
    return typeof r.host === 'string' && (r.action === 'allow' || r.action === 'deny');
  });
}

interface ApprovalParserInput {
  requestId: number | string;
  method: string;
  params: Record<string, unknown>;
  threadId?: unknown;
  turnId?: unknown;
  itemId?: unknown;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parses one live or recovered app-server approval request.
 *
 * Command approvals are discriminated by the pinned protocol's `kind` field;
 * this keeps terminal-input callbacks distinct from the command that originally
 * opened stdin, whose turn and lifecycle may already have moved on.
 */
export function parseApprovalRequest(
  input: ApprovalParserInput,
): ApprovalRequest | null {
  const { params } = input;
  const threadId = optionalString(params.threadId) ?? optionalString(input.threadId);
  const turnId = optionalString(params.turnId) ?? optionalString(input.turnId);
  const itemId = optionalString(params.itemId) ?? optionalString(input.itemId);
  if (!threadId || !turnId || !itemId) return null;

  if (input.method === 'item/commandExecution/requestApproval') {
    // The protocol documents `command` as the default for servers that omit
    // the field. Dropping the request instead would leave the turn blocked on
    // an approval the user can never see, so an unknown value degrades to the
    // narrower command card rather than to nothing.
    const kind = params.kind === 'writeStdin' ? 'writeStdin' : 'command';
    return {
      requestId: input.requestId,
      kind,
      approvalId: optionalString(params.approvalId),
      threadId,
      turnId,
      itemId,
      status: 'pending',
      command: optionalString(params.command),
      cwd: optionalString(params.cwd),
      reason: optionalString(params.reason),
      availableDecisions: parseAvailableDecisions(params.availableDecisions),
      proposedExecpolicyAmendment: parseStringArray(
        params.proposedExecpolicyAmendment,
      ),
      proposedNetworkPolicyAmendments: parseNetworkAmendments(
        params.proposedNetworkPolicyAmendments,
      ),
    };
  }

  if (input.method === 'item/fileChange/requestApproval') {
    return {
      requestId: input.requestId,
      kind: 'fileChange',
      threadId,
      turnId,
      itemId,
      status: 'pending',
      reason: optionalString(params.reason),
      grantRoot: optionalString(params.grantRoot),
    };
  }

  return null;
}
