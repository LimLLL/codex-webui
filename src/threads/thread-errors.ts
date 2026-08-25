/**
 * Shared error predicates for the threads module.
 *
 * The RPC client now preserves `error.code`/`error.data`, but app-server uses a
 * single JSON-RPC code (-32600) for every rejected request, so the code alone
 * cannot tell "this turn is in progress" from "this field is unknown". Codes
 * gate the predicates; message matching is what discriminates, and keeping it
 * here makes an upstream wording change a one-file fix.
 *
 * Patterns are kept narrow and mutually exclusive on purpose — an over-broad
 * one silently reclassifies errors depending on which predicate runs first.
 */
import {
  isCodexRpcError,
  isCodexUnavailableError,
} from '../codex/codex-errors';

/** JSON-RPC "Invalid Request"; app-server's catch-all for rejected calls. */
const INVALID_REQUEST = -32600;

/** Flattens message and structured data into one string for matching. */
function errorText(err: unknown): string {
  if (!isCodexRpcError(err)) {
    return err instanceof Error ? err.message : String(err);
  }
  if (err.data === undefined) return err.rpcMessage;
  const data =
    typeof err.data === 'string' ? err.data : JSON.stringify(err.data);
  return `${err.rpcMessage} ${data}`;
}

function isInvalidRequest(err: unknown): boolean {
  return isCodexRpcError(err) && err.code === INVALID_REQUEST;
}

/**
 * Returns true when a thread has no turns to read yet.
 *
 * The two history modes report this same state differently, and neither the
 * wording nor the code overlaps — measured against 0.149.1 on a thread created
 * but never sent to:
 *
 * - legacy:    `-32600 ... is not materialized yet; includeTurns is
 *              unavailable before first user message`
 * - paginated: `-32601 list_turns is not supported yet` — it names the
 *              unimplemented backing call rather than the state
 *
 * Deliberately not gated on the error code: the codes differ per mode (-32600
 * vs -32601), and this predicate guards resume/read fallbacks where treating a
 * recoverable state as fatal breaks thread creation outright.
 */
export function isNotMaterializedError(err: unknown): boolean {
  const text = errorText(err);
  return (
    /\bnot materialized\b/i.test(text) ||
    /\blist_turns is not supported\b/i.test(text)
  );
}

/** Returns true when the app-server process is not connected. */
export function isThreadServerUnavailableError(err: unknown): boolean {
  return isCodexUnavailableError(err);
}

/**
 * Returns true when app-server does not recognize the fork boundary field.
 *
 * `beforeTurnId` is experimental and absent from the generated schema, so this
 * is the signal that the branching mechanism itself needs revisiting rather
 * than a per-request problem the user can act on.
 */
export function isUnsupportedForkBoundaryFieldError(err: unknown): boolean {
  if (!isInvalidRequest(err)) return false;
  const text = errorText(err);
  return (
    /\bbefore[_-]?turn[_-]?id\b/i.test(text) &&
    /\b(unknown|unsupported|unrecognized|unexpected)\b/i.test(text)
  );
}

/**
 * Returns true when app-server rejected the requested fork boundary itself.
 *
 * Must be checked after {@link isUnsupportedForkBoundaryFieldError}: that one
 * means protocol drift, this one a legitimate per-request refusal such as a
 * boundary naming an in-progress turn.
 */
export function isInvalidForkBoundaryError(err: unknown): boolean {
  if (!isInvalidRequest(err)) return false;
  if (isUnsupportedForkBoundaryFieldError(err)) return false;
  return /\b(in[- ]progress|not found|invalid|does not exist)\b/i.test(
    errorText(err),
  );
}

/**
 * Returns true when app-server refuses to delete a thread others fork from.
 *
 * Paginated forks reference their parent's history instead of copying it, so
 * deletion is rejected upstream. Verified against 0.149.0, which answers with
 * `-32600: cannot delete thread <id>: forked history still references it`.
 *
 * Note this covers deletion only — compaction of a thread with descendants is
 * *not* rejected upstream; blocking it is our own guard. See ThreadsService.
 */
export function isDescendantRejectedError(err: unknown): boolean {
  if (!isInvalidRequest(err)) return false;
  return /\b(fork(ed|s)?|descendants?|child(ren)?|referenc\w*)\b/i.test(
    errorText(err),
  );
}

/**
 * Returns true when app-server has no rollout backing a thread id.
 *
 * Deliberately matched against one exact phrase. Measured on 0.149.0 against a
 * thread id that never existed:
 *
 * - `thread/delete`  → `-32600 no rollout found for thread id <id>`
 * - `thread/archive` → `-32600 no rollout found for thread id <id>`
 * - `thread/read`    → `-32600 thread not loaded: <id>`
 *
 * `thread/read`'s wording is intentionally *not* accepted: "not loaded" also
 * describes a thread that exists but was never resumed, so treating it as
 * proof of absence would be a guess. This predicate gates the delete path's
 * "already gone, reap the local rows" branch, where a false positive discards
 * branch metadata for a conversation that is still on disk.
 */
export function isThreadNotFoundError(err: unknown): boolean {
  if (!isInvalidRequest(err)) return false;
  return /\bno rollout found for thread id\b/i.test(errorText(err));
}
