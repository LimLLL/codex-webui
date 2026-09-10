/** Retains proposed file changes that history cannot supply before approval. */
import type { ServerNotification } from '../codex/codex-schema';
import type { FileChangeApprovalSubjectDto } from './dto/pending-approvals.dto';

interface FileProposal {
  generation: number;
  threadId: string;
  turnId: string;
  subject: FileChangeApprovalSubjectDto;
}

/**
 * Holds only in-flight file proposals and the subjects claimed by pending requests.
 * A request keeps its own subject reference after item/turn cleanup. Backend startup
 * expires all pending requests, so this state needs no separate durable store.
 */
export class PendingApprovalContext {
  private readonly items = new Map<string, FileProposal>();
  private readonly requests = new Map<string, FileChangeApprovalSubjectDto>();

  /** Captures complete change sets before requests arrive; never retains output deltas. */
  observe(notification: ServerNotification, generation: number): void {
    if (notification.method === 'item/started') {
      const { threadId, turnId, item } = notification.params;
      if (item.type !== 'fileChange') return;
      this.items.set(this.itemKey(generation, threadId, turnId, item.id), {
        generation,
        threadId,
        turnId,
        // Preserve every change and the object-union kind, including move_path.
        subject: { type: 'fileChange', changes: structuredClone(item.changes) },
      });
    } else if (notification.method === 'item/completed') {
      const { threadId, turnId, item } = notification.params;
      this.items.delete(this.itemKey(generation, threadId, turnId, item.id));
    } else if (notification.method === 'turn/completed') {
      const { threadId, turn } = notification.params;
      this.forgetItems(generation, threadId, turn.id);
    } else if (
      notification.method === 'thread/closed' ||
      notification.method === 'thread/deleted'
    ) {
      this.forgetItems(generation, notification.params.threadId);
    }
  }

  /**
   * Associates the preceding item's change set with one pending approval.
   *
   * Reports the miss rather than substituting anything: a fabricated empty or
   * unrelated subject would be presented as the thing the user is approving.
   * The caller decides what an unaccompanied approval means.
   *
   * @returns `true` when a matching proposal was retained for this request
   */
  capture(
    generation: number,
    requestId: string,
    threadId: string,
    turnId: string | null,
    itemId: string | null,
  ): boolean {
    // An upsert can replace the request's identities. A miss must not leave
    // the preceding request's change set attached to the replacement row.
    this.forgetRequest(generation, requestId);
    if (turnId === null || itemId === null) return false;
    const proposal = this.items.get(
      this.itemKey(generation, threadId, turnId, itemId),
    );
    if (!proposal) return false;
    this.requests.set(this.requestKey(generation, requestId), proposal.subject);
    return true;
  }

  /** Returns an isolated subject for REST/live delivery without exposing mutable retained state. */
  read(
    generation: number,
    requestId: string,
  ): FileChangeApprovalSubjectDto | null {
    const subject = this.requests.get(this.requestKey(generation, requestId));
    return subject ? structuredClone(subject) : null;
  }

  /** Retires the request subject once a committed terminal transition makes it unanswerable. */
  forgetRequest(generation: number, requestId: string): void {
    this.requests.delete(this.requestKey(generation, requestId));
  }

  /** Removes proposals from an expired app-server generation. */
  forgetGeneration(generation: number): void {
    this.forgetItems(generation);
    for (const key of this.requests.keys()) {
      if (key.startsWith(`${generation}:`)) this.requests.delete(key);
    }
  }

  /** Clears all process-local context when startup expires the old pending inventory. */
  clear(): void {
    this.items.clear();
    this.requests.clear();
  }

  /** Removes candidates whose item, thread or generation can no longer raise this approval. */
  private forgetItems(
    generation: number,
    threadId?: string,
    turnId?: string,
  ): void {
    for (const [key, item] of this.items) {
      if (
        item.generation === generation &&
        (threadId === undefined || item.threadId === threadId) &&
        (turnId === undefined || item.turnId === turnId)
      )
        this.items.delete(key);
    }
  }

  /** Encodes identities without assuming delimiters cannot occur in upstream IDs. */
  private itemKey(
    generation: number,
    threadId: string,
    turnId: string,
    itemId: string,
  ): string {
    return JSON.stringify([generation, threadId, turnId, itemId]);
  }

  /** Request IDs are scoped to a single app-server generation. */
  private requestKey(generation: number, requestId: string): string {
    return `${generation}:${requestId}`;
  }
}
