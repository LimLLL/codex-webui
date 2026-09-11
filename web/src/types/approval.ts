/** Types for Codex approval workflow (server-initiated requests). */
import type { FileChangeEntry } from '@/types/timeline';
import type { InteractionPresentationDto } from '@/generated/api';

export type ApprovalDecision =
  | 'accepted'
  | 'acceptedForSession'
  | 'declined'
  | 'cancelled'
  | 'submitted'
  | 'failed'
  | 'resolved';

/** Subset of ApprovalDecision that can be chosen by the user (excludes server-set 'resolved'). */
export type ResolvableApprovalDecision = Exclude<ApprovalDecision, 'resolved' | 'submitted' | 'failed'>;

/** Network policy amendment proposed by the server. */
export interface NetworkPolicyAmendment {
  host: string;
  action: 'allow' | 'deny';
}

/**
 * One filesystem grant a command is asking for beyond the thread's sandbox.
 *
 * `kind` is preserved rather than flattened to a path string: a glob and a
 * literal path authorize very different amounts, and `deny` access is a
 * restriction that must never read as a grant.
 */
export interface RequestedFileSystemAccess {
  kind: 'path' | 'glob' | 'special';
  /**
   * Display text. A literal path or a glob pattern for those kinds; for
   * `special` it is the sub-path within the scope, which is often empty because
   * most special scopes name a location on their own.
   */
  value: string;
  /**
   * The protocol's scope tag, present only for `special`. The pinned schema
   * models a special path as an object union (`root`, `minimal`,
   * `project_roots`, `tmpdir`, `slash_tmp`, `unknown`) rather than a string, so
   * the scope is the security-relevant part and must survive parsing.
   */
  scope?: string;
  access: 'read' | 'write' | 'deny';
}

/**
 * Extra sandbox access a command approval is requesting.
 *
 * This is the one thing the execution item genuinely cannot show — it reports
 * what will run, not what the run is asking to be allowed to touch.
 */
export interface RequestedPermissions {
  /**
   * Whether network access is requested.
   *
   * Tri-state on purpose: `null` means the request said nothing about network
   * access, which is "unspecified" and must not be presented as unrestricted.
   */
  networkEnabled: boolean | null;
  fileSystem: RequestedFileSystemAccess[];
}

/** Subject of a network-only approval, which carries no command at all. */
export interface NetworkApprovalContext {
  host: string;
  protocol: string;
}

/**
 * Raw decision values the server permits for a command approval.
 * These map to the Codex CommandExecutionApprovalDecision union type.
 */
export type RawCommandDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: NetworkPolicyAmendment } };

/** A pending approval request from the Codex app-server. */
export interface ApprovalRequest {
  /** Absent only on pre-upgrade cards, which cannot submit a decision. */
  instanceId?: string;
  /** Backend-validated permissions or MCP form; never inferred from raw JSON. */
  presentation?: InteractionPresentationDto | null;
  negativeOnlyReason?: string | null;
  /** JSON-RPC request ID — must be included in the response. */
  requestId: number | string;
  /** Approval type discriminator. */
  kind: 'command' | 'writeStdin' | 'fileChange' | 'permissions' | 'elicitation';
  /** Stable protocol approval identity, when supplied independently of RPC ID. */
  approvalId?: string | null;
  threadId: string;
  turnId: string | null;
  itemId: string;
  /** Current status. */
  status: 'pending' | ApprovalDecision;
  /**
   * What this browser submitted, retained separately from `status`: the
   * lifecycle is app-server's to confirm, the choice is the user's own and
   * stays displayable after the card stops awaiting a decision.
   */
  decision?: ResolvableApprovalDecision;
  /** Shell command (command approvals only). */
  command?: string | null;
  /** Working directory (command approvals only). */
  cwd?: string | null;
  /** Explanatory reason from the agent. */
  reason?: string | null;
  /** Root path the agent wants write access to (fileChange only). */
  grantRoot?: string | null;
  /**
   * App-server process generation this request belongs to.
   *
   * Informational process scope only: the backend counter can restart too.
   * Modern response and retirement matching require the immutable instanceId.
   */
  generation?: number | null;
  /**
   * The files this approval would write (fileChange only).
   *
   * Supplied by the backend rather than read from the item stream, because the
   * pending item is measurably absent from history while its approval is
   * outstanding — a client that never received the conversation's items has no
   * other way to see what it is being asked to allow.
   *
   * Tri-state, and the distinction is the point:
   *  - array — the complete proposed change set
   *  - `null` — this IS a file approval and the changes could not be shown.
   *    Accepting is refused by the backend; only Decline/Cancel are offered.
   *  - `undefined` — not a file approval, or a payload predating the subject.
   */
  reviewChanges?: FileChangeEntry[] | null;
  /** Server-provided list of allowed decisions (command/writeStdin only). */
  availableDecisions?: RawCommandDecision[] | null;
  /** Server-proposed exec policy amendment patterns (command only). */
  proposedExecpolicyAmendment?: string[] | null;
  /** Server-proposed network policy amendments (command only). */
  proposedNetworkPolicyAmendments?: NetworkPolicyAmendment[] | null;
  /** Extra sandbox access this command is requesting, when the server states any. */
  requestedPermissions?: RequestedPermissions | null;
  /**
   * Host and protocol for a network-only approval.
   *
   * The protocol allows such a request to omit `command` and `cwd` entirely, so
   * this is the only thing identifying what is being authorized.
   */
  networkContext?: NetworkApprovalContext | null;
}

// ─── User Input Requests (item/tool/requestUserInput) ────────────────────────

/** Option displayed for a server-initiated user input question. */
export interface UserInputOption {
  label: string;
  description: string;
}

/** Question payload for item/tool/requestUserInput. */
export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
}

/** A pending user-input request from the Codex app-server (EXPERIMENTAL). */
export interface UserInputRequest {
  /** Required by the response API; legacy cards must refresh before answering. */
  instanceId?: string;
  /** JSON-RPC request ID — must be included in the response. */
  requestId: number | string;
  /** Informational process scope; instanceId identifies modern requests. */
  generation?: number | null;
  kind: 'userInput';
  threadId: string;
  turnId: string;
  itemId: string;
  status: 'pending' | 'submitted' | 'failed' | 'resolved';
  questions: UserInputQuestion[];
}
