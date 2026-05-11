/** Types for Codex approval workflow (server-initiated requests). */

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
  status: 'pending' | 'accepted' | 'declined';
  /** Shell command (commandExecution only). */
  command?: string | null;
  /** Working directory (commandExecution only). */
  cwd?: string | null;
  /** Explanatory reason from the agent. */
  reason?: string | null;
  /** Root path the agent wants write access to (fileChange only). */
  grantRoot?: string | null;
}
