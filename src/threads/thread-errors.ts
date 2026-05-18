/**
 * Shared error predicates for the threads module.
 *
 * The app-server JSON-RPC errors lose structured codes at the client layer
 * (converted to plain Error with message string). Until the RPC client
 * preserves error.code/data, string matching is the only option — centralizing
 * it here prevents drift between call sites.
 */

/** Returns true when the RPC error indicates a thread hasn't been materialized yet. */
export function isNotMaterializedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\bnot materialized\b/i.test(message);
}
