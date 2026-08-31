/** Shared enforcement for the paginated thread-history invariant. */
import { HttpStatus } from '@nestjs/common';
import type { v2 } from '../codex/codex-schema';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';

/** The only thread-history mode supported by this application. */
export const REQUIRED_HISTORY_MODE: v2.ThreadHistoryMode = 'paginated';

/**
 * Returns whether app-server identified the thread as paginated.
 *
 * `historyMode` is a required field of the pinned schema, so this reads it
 * directly — casting to an optional `string` would silently accept a response
 * that dropped the field instead of failing the invariant.
 */
export function isPaginatedThread(thread: v2.Thread): boolean {
  return thread.historyMode === REQUIRED_HISTORY_MODE;
}

/**
 * Rejects a thread response that violates the application's history invariant.
 *
 * @param thread - Thread returned by app-server
 * @param operation - RPC operation whose response violated the invariant
 */
export function assertPaginatedThread(
  thread: v2.Thread,
  operation: string,
): void {
  if (isPaginatedThread(thread)) return;
  throw new BusinessException(
    ErrorCode.threads.paginatedHistoryRequired,
    HttpStatus.BAD_GATEWAY,
    `${operation} did not return paginated history`,
    { threadId: thread.id },
  );
}
