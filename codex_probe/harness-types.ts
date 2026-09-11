/** Protocol envelopes and responder dispositions shared by native probes. */
import type {
  ClientRequest,
  ServerNotification,
  ServerRequest,
} from '../src/codex/codex-schema';

/** Every method the pinned app-server accepts as a client request. */
export type RpcMethod = ClientRequest['method'];

/** Params the pinned schema defines for one method. */
export type RpcParams<M extends RpcMethod> = Extract<
  ClientRequest,
  { method: M }
>['params'];

/** `Omit` that maps over a union instead of collapsing it to its shared keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * One method paired with that method's params, as a discriminated union.
 *
 * The pairing has to live in the TYPE rather than rely on inference. An earlier
 * signature took the method and params as two arguments and inferred the method
 * from the first — which TypeScript silently abandons the moment a caller names
 * any type argument, because it has no partial type-argument inference. Every
 * probe named the result type, so every probe fell back to the default `M` (the
 * whole method union), `RpcParams<M>` widened to the union of all params, and a
 * `turn/start` call carrying `thread/start` params compiled without a word.
 * Correlating the two fields here restores the check regardless of what the
 * caller does with the result type.
 */
export type RpcCall = DistributiveOmit<ClientRequest, 'id'>;

/** One JSON-RPC reply. Errors are returned, not thrown: a refusal is data. */
export interface RpcReply<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** Method names the pinned schema exports, for reference at call sites. */
export type KnownNotification = ServerNotification['method'];
export type KnownServerRequest = ServerRequest['method'];

/**
 * A server-initiated notification, kept verbatim for later inspection.
 *
 * `method` is a plain string rather than {@link KnownNotification}: a method
 * the exported schema does not list is precisely what a probe is looking for,
 * and narrowing here would hide it. (It would not even narrow — a union of a
 * literal type with `string` collapses to `string`.)
 */
export interface Note {
  method: string;
  params: Record<string, unknown>;
  /** Position on the single incoming wire; comparable with {@link IncomingRequest.arrival}. */
  arrival: number;
}

/** A server-initiated request, which the client must answer. */
export interface IncomingRequest {
  id: number | string;
  /** Plain string for the same reason as {@link Note.method}. */
  method: string;
  params: Record<string, unknown>;
  /**
   * Position on the single incoming wire, shared with notifications.
   *
   * Notifications and requests are recorded in separate arrays, so "I found
   * this notification in the log after the request arrived" says nothing about
   * which came first. Anything that depends on one preceding the other has to
   * compare these instead of assuming.
   */
  arrival: number;
}

/** Outcome of one turn driven to completion. */
export interface TurnRun {
  turnId?: string;
  /** Notifications emitted from `turn/start` until this turn completed. */
  events: Note[];
  /** Server requests received while it ran, in arrival order. */
  requests: IncomingRequest[];
  /** True when the turn completed rather than running out of time. */
  completed: boolean;
  /** Set when `turn/start` itself was refused. */
  error?: RpcReply<unknown>['error'];
}

export interface AppServerOptions {
  /** Path to the codex binary. Defaults to the repo's pinned dependency. */
  bin?: string;
  /** CODEX_HOME for this run. */
  home: string;
  /** Process cwd; isolated probes supply their own workspace explicitly. */
  cwd?: string;
  /** How to answer server-initiated requests. Defaults to accepting approvals. */
  onServerRequest?: (request: IncomingRequest) => unknown;
  /** Extra environment for the child. */
  env?: Record<string, string>;
}

/**
 * Returned by a responder to leave a server request deliberately unanswered.
 *
 * Answering immediately is right for probes that only need the turn to proceed,
 * but it makes a whole class of question unmeasurable: anything about the state
 * of the world *while* the agent is blocked. Reading history after replying
 * measures the post-decision world and quietly answers a different question.
 */
export const HOLD: unique symbol = Symbol('hold');

/** Marks a responder's return value as a JSON-RPC error rather than a result. */
const ERROR_REPLY: unique symbol = Symbol('errorReply');

/**
 * A JSON-RPC error a responder can return in place of a result.
 *
 * Withholding an answer and refusing to give one are different dispositions,
 * and the difference is measurable: silence leaves the agent blocked, while a
 * refusal is something app-server has to classify and act on. A harness that
 * can only send results can only measure half of that.
 */
export interface ErrorReply {
  [ERROR_REPLY]: true;
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Builds an error reply for a server-initiated request.
 *
 * @param code - JSON-RPC error code
 * @param message - Human-readable reason
 * @param data - Optional structured detail
 * @returns A value a responder returns to refuse the request
 */
export function rpcError(
  code: number,
  message: string,
  data?: unknown,
): ErrorReply {
  return {
    [ERROR_REPLY]: true,
    code,
    message,
    ...(data !== undefined && { data }),
  };
}

/** Distinguishes a refusal from an ordinary result object. */
export function isErrorReply(value: unknown): value is ErrorReply {
  return value !== null && typeof value === 'object' && ERROR_REPLY in value;
}

/** Strips the internal tag, leaving the wire shape of a JSON-RPC error. */
export function errorPayload(reply: ErrorReply): Record<string, unknown> {
  return {
    code: reply.code,
    message: reply.message,
    ...(reply.data !== undefined && { data: reply.data }),
  };
}

/** Answers approvals with `accept`, everything else with an empty result. */
export function defaultServerResponse(request: IncomingRequest): unknown {
  return request.method.endsWith('requestApproval')
    ? { decision: 'accept' }
    : {};
}
