/** Runtime parsers for approval-related protocol data. */
import type {
  ApprovalRequest,
  NetworkApprovalContext,
  NetworkPolicyAmendment,
  RawCommandDecision,
  RequestedFileSystemAccess,
  RequestedPermissions,
} from '@/types/approval';
import type { PendingServerRequestDto, InteractionPresentationDto } from '@/generated/api';
import type { FileChangeEntry } from '@/types/timeline';
import { normalizeFileChanges } from '@/lib/thread-item-normalizer';

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

const NETWORK_PROTOCOLS = new Set(['http', 'https', 'socks5Tcp', 'socks5Udp']);

/**
 * Parses the experimental per-command permission overlay.
 *
 * Both the legacy `read`/`write` lists and the structured `entries` are read:
 * the protocol still emits either, and dropping one would silently understate
 * what a command asked for. Entries keep their path kind and access mode, so a
 * glob does not render as a literal path and a `deny` never reads as a grant.
 */
export function parseRequestedPermissions(
  value: unknown,
): RequestedPermissions | null {
  if (value === null || typeof value !== 'object') return null;
  const profile = value as Record<string, unknown>;
  const network = profile.network as Record<string, unknown> | null | undefined;
  const fs = profile.fileSystem as Record<string, unknown> | null | undefined;

  const fileSystem: RequestedFileSystemAccess[] = [];
  for (const access of ['read', 'write'] as const) {
    for (const path of parseStringArray(fs?.[access]) ?? []) {
      fileSystem.push({ kind: 'path', value: path, access });
    }
  }
  if (Array.isArray(fs?.entries)) {
    for (const raw of fs.entries) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const access = entry.access;
      if (access !== 'read' && access !== 'write' && access !== 'deny') continue;
      const parsed = parseFileSystemPath(entry.path);
      if (parsed) fileSystem.push({ ...parsed, access });
    }
  }

  const networkEnabled =
    typeof network?.enabled === 'boolean' ? network.enabled : null;
  // An overlay that requests nothing is not worth a card section, and rendering
  // an empty one would imply the server said something it did not.
  if (networkEnabled === null && fileSystem.length === 0) return null;
  return { networkEnabled, fileSystem };
}

/**
 * Reads one structured filesystem path, preserving how it was expressed.
 *
 * @param value - A protocol `FileSystemPath`, one of the `path`, `glob_pattern`
 *   or `special` variants
 * @returns The parsed access scope, or null when the shape is unrecognised
 */
function parseFileSystemPath(
  value: unknown,
): Omit<RequestedFileSystemAccess, 'access'> | null {
  if (value === null || typeof value !== 'object') return null;
  const path = value as Record<string, unknown>;
  if (path.type === 'path' && typeof path.path === 'string') {
    return { kind: 'path', value: path.path };
  }
  if (path.type === 'glob_pattern' && typeof path.pattern === 'string') {
    return { kind: 'glob', value: path.pattern };
  }
  if (path.type === 'special') return parseSpecialPath(path.value);
  return null;
}

/**
 * Reads a special filesystem scope.
 *
 * The pinned protocol models this as an object union, never a string. An
 * earlier version tested `typeof value === 'string'`, which is unsatisfiable
 * against that schema — so every structured special scope was dropped, and an
 * overlay whose only entry was one became null and vanished from the card. A
 * requested authorization scope must never disappear silently, so an
 * unrecognised shape still yields a scope rather than nothing.
 *
 * @param value - A protocol `FileSystemSpecialPath`
 * @returns The scope and any sub-path within it
 */
function parseSpecialPath(
  value: unknown,
): Omit<RequestedFileSystemAccess, 'access'> | null {
  if (value === null || typeof value !== 'object') return null;
  const special = value as Record<string, unknown>;
  const kind = typeof special.kind === 'string' ? special.kind : null;
  if (!kind) return null;
  const subpath = typeof special.subpath === 'string' ? special.subpath : '';
  // `unknown` is the only variant carrying its own path, and it is precisely
  // the one this client cannot name, so its path is what gets shown.
  const base = kind === 'unknown' && typeof special.path === 'string' ? special.path : '';
  const value_ = [base, subpath].filter(Boolean).join('/');
  return { kind: 'special', scope: kind, value: value_ };
}

/** Parses the subject of a network-only approval. */
export function parseNetworkApprovalContext(
  value: unknown,
): NetworkApprovalContext | null {
  if (value === null || typeof value !== 'object') return null;
  const context = value as Record<string, unknown>;
  if (typeof context.host !== 'string' || typeof context.protocol !== 'string') {
    return null;
  }
  // An unrecognised protocol is still shown: the host is the security-relevant
  // part, and refusing the whole context would leave the card with no subject.
  return {
    host: context.host,
    protocol: NETWORK_PROTOCOLS.has(context.protocol)
      ? context.protocol
      : 'unknown',
  };
}

interface ApprovalParserInput {
  instanceId?: string;
  presentation?: InteractionPresentationDto | null;
  negativeOnlyReason?: string | null;
  requestId: number | string;
  method: string;
  params: Record<string, unknown>;
  threadId?: unknown;
  turnId?: unknown;
  itemId?: unknown;
  /** Backend-attached review context; absent for payloads that predate it. */
  reviewSubject?: unknown;
  generation?: unknown;
}

/**
 * Reads the backend's review subject for a file approval.
 *
 * Returns `null` for anything that is not a well-formed file subject, which
 * deliberately includes the backend's own "I could not retain it" null. Both
 * mean the same thing to the user — the changes cannot be shown — and a card
 * that guessed otherwise would offer Accept for writes nobody could see.
 *
 * @param value - The `reviewSubject` field from a live event or a pending row
 * @returns The proposed changes, or null when none can be shown
 */
function parseReviewChanges(value: unknown): FileChangeEntry[] | null {
  if (value === null || typeof value !== 'object') return null;
  const subject = value as Record<string, unknown>;
  if (subject.type !== 'fileChange') return null;
  // Transcript normalization is deliberately tolerant. A decision must not
  // silently authorize entries that parser skipped or fields it defaulted.
  if (!Array.isArray(subject.changes) || !subject.changes.every((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return false;
    const change = raw as Record<string, unknown>;
    if (typeof change.path !== 'string' || !change.path || typeof change.diff !== 'string') return false;
    if (!change.kind || typeof change.kind !== 'object') return false;
    const kind = change.kind as Record<string, unknown>;
    return kind.type === 'add' || kind.type === 'delete' ||
      (kind.type === 'update' && (kind.move_path === null || typeof kind.move_path === 'string'));
  })) return null;
  const changes = normalizeFileChanges(subject.changes);
  // An empty set is not a renderable subject: it would draw a card claiming
  // files are being written while listing none.
  return changes.length > 0 ? changes : null;
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
  if (threadId && input.instanceId && input.presentation &&
    ((input.method === 'item/permissions/requestApproval' && input.presentation.kind === 'permissions') ||
      (input.method === 'mcpServer/elicitation/request' && input.presentation.kind === 'elicitation'))) {
    return { requestId: input.requestId, instanceId: input.instanceId,
      kind: input.presentation.kind, threadId, turnId, itemId: itemId ?? '',
      generation: input.generation as number | undefined, status: 'pending',
      presentation: input.presentation };
  }
  if (!threadId || !turnId || !itemId) return null;
  const generation =
    typeof input.generation === 'number' ? input.generation : null;

  if (input.method === 'item/commandExecution/requestApproval') {
    // The protocol documents `command` as the default for servers that omit
    // the field. Dropping the request instead would leave the turn blocked on
    // an approval the user can never see, so an unknown value degrades to the
    // narrower command card rather than to nothing.
    const kind = params.kind === 'writeStdin' ? 'writeStdin' : 'command';
    return {
      requestId: input.requestId,
      instanceId: input.instanceId,
      negativeOnlyReason: input.negativeOnlyReason,
      kind,
      approvalId: optionalString(params.approvalId),
      threadId,
      turnId,
      itemId,
      generation,
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
      // Both are the authorization subject rather than decoration: extra
      // sandbox access is precisely what the execution item cannot show, and a
      // network-only request omits `command` and `cwd` altogether, leaving this
      // context as the only thing naming what is being authorized.
      requestedPermissions: parseRequestedPermissions(
        params.additionalPermissions,
      ),
      networkContext: parseNetworkApprovalContext(params.networkApprovalContext),
    };
  }

  if (input.method === 'item/fileChange/requestApproval') {
    return {
      requestId: input.requestId,
      instanceId: input.instanceId,
      kind: 'fileChange',
      threadId,
      turnId,
      itemId,
      generation,
      status: 'pending',
      reason: optionalString(params.reason),
      grantRoot: optionalString(params.grantRoot),
      // Always set, never left undefined: a file approval that cannot show its
      // changes has to be distinguishable from one whose payload predates the
      // subject, because only the first is safe to render with an Accept button
      // withheld rather than with the item stream as a fallback.
      reviewChanges: parseReviewChanges(input.reviewSubject),
    };
  }

  return null;
}

/**
 * Builds an approval card from a persisted pending request.
 *
 * Only genuinely pending rows become cards: the table also retains answered
 * requests, and rendering one would offer buttons for a decision already made.
 *
 * @param request - One row from the pending-requests endpoint
 * @returns The approval to display, or null when the row is not one
 */
export function approvalFromPending(
  request: PendingServerRequestDto,
): ApprovalRequest | null {
  if (request.status !== 'pending' && request.status !== 'submitted') return null;
  const parsed = parseApprovalRequest({
    instanceId: request.instanceId,
    presentation: request.presentation,
    negativeOnlyReason: request.negativeOnlyReason,
    requestId: request.requestId,
    method: request.method,
    params: request.params,
    threadId: request.threadId,
    turnId: request.turnId,
    itemId: request.itemId,
    // The recovered subject is byte-identical to the live one by contract, so
    // a card rebuilt after a refresh shows exactly what the live card showed.
    reviewSubject: request.reviewSubject,
    generation: request.generation,
  });
  return parsed ? { ...parsed, status: request.status } : null;
}
