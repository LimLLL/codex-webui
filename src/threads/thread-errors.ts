/**
 * Shared error predicates for the threads module.
 *
 * The RPC client preserves `error.code`/`error.data`, but app-server overloads
 * its JSON-RPC codes: -32600 is the catch-all for rejected requests, and -32601
 * covers both a genuinely missing method and a thread with no persisted history
 * yet. A code alone therefore cannot tell "this turn is in progress" from "this
 * field is unknown" from "this thread is empty". Codes and the calling method
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

/** JSON-RPC "Method not found"; overloaded by pinned app-server history. */
const METHOD_NOT_FOUND = -32601;

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
 * Returns true when turn paging refused a thread before its first user message.
 *
 * Classification deliberately includes method, code, and pinned 0.151.0
 * wording. The same words on a different RPC must not trigger an empty-history
 * normalization.
 */
export function isUnmaterializedTurnsListError(err: unknown): boolean {
  return (
    isCodexRpcError(err) &&
    err.method === 'thread/turns/list' &&
    err.code === INVALID_REQUEST &&
    /^thread \S+ is not materialized yet; thread\/turns\/list is unavailable before first user message$/.test(
      err.rpcMessage,
    )
  );
}

/**
 * Returns true when `thread/read` refused to reconstruct turns for a thread
 * before its first user message.
 *
 * Measured against 0.151.0: `thread/read` still names its backing call rather
 * than the state, and still answers `-32601`, while `thread/turns/list` reports
 * the same condition as `-32600` with the state spelled out. The three history
 * RPCs each word this differently, so each needs its own predicate — a shared
 * loose pattern would reclassify a genuine "method not found" as empty history.
 */
export function isUnmaterializedThreadReadError(err: unknown): boolean {
  return (
    isCodexRpcError(err) &&
    err.method === 'thread/read' &&
    err.code === METHOD_NOT_FOUND &&
    err.rpcMessage === 'list_turns is not supported yet'
  );
}

/**
 * Returns true for the pinned item-paging refusal seen on an empty thread.
 *
 * App-server also uses this exact response when its store genuinely lacks item
 * pagination, so callers that normalize it to empty must emit a warning rather
 * than silently hiding a protocol or store mismatch.
 */
export function isEmptyThreadItemsListRefusal(err: unknown): boolean {
  return (
    isCodexRpcError(err) &&
    err.method === 'thread/items/list' &&
    err.code === METHOD_NOT_FOUND &&
    err.rpcMessage === 'thread/items/list is not supported yet'
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

/**
 * Returns true when app-server refuses writer ownership for a paginated thread.
 *
 * The experimental metadata-first open path must surface this as read-only
 * state, not as a generic resume failure. Kept distinct from not-found:
 * read-only history requests remain valid when another process owns the writer.
 *
 * The pattern is anchored on the exact wording observed from the pinned
 * app-server (`thread <id> already has an active writer`) rather than on the
 * presence of words like "thread" and "writer". A loose pattern is worse here
 * than elsewhere: misclassifying a genuine failure downgrades the conversation
 * to read-only and tells the user it is held by another client, which is a
 * plausible-looking lie. Failing to match merely reports the real error.
 */
export function isThreadOwnershipConflictError(err: unknown): boolean {
  if (!isInvalidRequest(err)) return false;
  return /\balready has an active writer\b/i.test(errorText(err));
}
