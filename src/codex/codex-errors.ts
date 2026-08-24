/** Structured errors raised by the Codex app-server transport layer. */
import type { RequestId } from './codex-schema';

/** `error` member of a JSON-RPC error response. */
export interface CodexRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

/** Call context attached to an RPC error for logging and classification. */
export interface CodexRpcErrorContext {
  method?: string;
  requestId?: RequestId;
}

/**
 * Error returned by a JSON-RPC response from codex app-server.
 *
 * Preserves `code` and `data` so callers can classify failures instead of
 * pattern-matching a formatted string.
 */
export class CodexRpcError extends Error {
  /** JSON-RPC error code; app-server uses -32600 for most refusals. */
  readonly code: number;
  /** Structured payload, when app-server supplies one. */
  readonly data?: unknown;
  /** Original app-server message, without the local "RPC error" prefix. */
  readonly rpcMessage: string;
  readonly method?: string;
  readonly requestId?: RequestId;

  constructor(
    payload: CodexRpcErrorPayload,
    context: CodexRpcErrorContext = {},
  ) {
    super(`RPC error ${payload.code}: ${payload.message}`);
    this.name = 'CodexRpcError';
    this.code = payload.code;
    this.data = payload.data;
    this.rpcMessage = payload.message;
    this.method = context.method;
    this.requestId = context.requestId;
  }
}

/** Raised when the app-server process is not connected. */
export class CodexUnavailableError extends Error {
  constructor(message = 'Codex app-server is not connected') {
    super(message);
    this.name = 'CodexUnavailableError';
  }
}

export function isCodexRpcError(err: unknown): err is CodexRpcError {
  return err instanceof CodexRpcError;
}

export function isCodexUnavailableError(
  err: unknown,
): err is CodexUnavailableError {
  return err instanceof CodexUnavailableError;
}
