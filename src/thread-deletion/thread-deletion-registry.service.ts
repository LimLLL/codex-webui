/** In-process guard for threads currently being deleted. */
import { Injectable, Logger } from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';

@Injectable()
export class ThreadDeletionRegistryService {
  private readonly logger = new Logger(ThreadDeletionRegistryService.name);
  private readonly deletingThreadIds = new Set<string>();
  private readonly releaseListeners = new Set<(threadIds: string[]) => void>();

  /**
   * Subscribes to guard releases so callers can undo whatever they suppressed.
   *
   * A delete can abort at several points, and anything held back for the sake
   * of a conversation that turned out to survive has to be let through again.
   *
   * @param listener - Receives the thread ids that were actually held
   * @returns Unsubscribe function
   */
  onRelease(listener: (threadIds: string[]) => void): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  /** Claims a delete set, failing if any member is already being deleted. */
  begin(threadIds: string[]): void {
    const normalized = [...new Set(threadIds.map((id) => id.trim()))].filter(
      Boolean,
    );
    const busy = normalized.find((threadId) =>
      this.deletingThreadIds.has(threadId),
    );
    if (busy) {
      throw BusinessException.conflict(
        ErrorCode.threads.deleteInProgress,
        'A delete operation is already running for this conversation',
        { threadId: busy },
      );
    }
    for (const threadId of normalized) this.deletingThreadIds.add(threadId);
  }

  /**
   * Releases a previously claimed delete set and notifies release listeners.
   *
   * Listeners are isolated: this runs from the `finally` of a destructive
   * operation, where a thrown listener would replace the operation's real
   * result — reporting a failure for a delete that actually completed.
   */
  end(threadIds: string[]): void {
    const released = threadIds.filter((threadId) =>
      this.deletingThreadIds.delete(threadId),
    );
    if (released.length === 0) return;
    for (const listener of this.releaseListeners) {
      try {
        listener(released);
      } catch (err) {
        this.logger.error(
          `Delete guard release listener failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Returns true when a thread is currently inside a delete operation. */
  isDeleting(threadId: string): boolean {
    return this.deletingThreadIds.has(threadId);
  }

  /** Throws a stable conflict if a caller tries to mutate a doomed thread. */
  assertMutable(threadId: string): void {
    if (!this.isDeleting(threadId)) return;
    throw BusinessException.conflict(
      ErrorCode.threads.deleteInProgress,
      'A delete operation is already running for this conversation',
      { threadId },
    );
  }
}
