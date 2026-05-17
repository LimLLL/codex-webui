/** Types for Codex approval workflow (server-initiated requests). */

export type ApprovalDecision =
  | 'accepted'
  | 'acceptedForSession'
  | 'declined'
  | 'cancelled'
  | 'resolved';

/** Subset of ApprovalDecision that can be chosen by the user (excludes server-set 'resolved'). */
export type ResolvableApprovalDecision = Exclude<ApprovalDecision, 'resolved'>;

/** Network policy amendment proposed by the server. */
export interface NetworkPolicyAmendment {
  host: string;
  action: 'allow' | 'deny';
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
  /** JSON-RPC request ID — must be included in the response. */
  requestId: number | string;
  /** Approval type discriminator. */
  kind: 'commandExecution' | 'fileChange';
  threadId: string;
  turnId: string;
  itemId: string;
  /** Current status. */
  status: 'pending' | ApprovalDecision;
  /** Shell command (commandExecution only). */
  command?: string | null;
  /** Working directory (commandExecution only). */
  cwd?: string | null;
  /** Explanatory reason from the agent. */
  reason?: string | null;
  /** Root path the agent wants write access to (fileChange only). */
  grantRoot?: string | null;
  /** Server-provided list of allowed decisions (commandExecution only). */
  availableDecisions?: RawCommandDecision[] | null;
  /** Server-proposed exec policy amendment patterns (commandExecution only). */
  proposedExecpolicyAmendment?: string[] | null;
  /** Server-proposed network policy amendments (commandExecution only). */
  proposedNetworkPolicyAmendments?: NetworkPolicyAmendment[] | null;
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
  /** JSON-RPC request ID — must be included in the response. */
  requestId: number | string;
  kind: 'userInput';
  threadId: string;
  turnId: string;
  itemId: string;
  status: 'pending' | 'resolved';
  questions: UserInputQuestion[];
}
