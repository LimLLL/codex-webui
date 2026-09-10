/** Bounded UI history reads with explicit coverage, distinct from provenance reads. */
import type { CodexService } from '../codex/codex.service';
import { isEmptyThreadItemsListRefusal } from './thread-errors';

/** One persisted item and its owning turn from thread/items/list. */
export interface ThreadItemEntry {
  turnId?: string;
  item: Record<string, unknown>;
}

export interface ThreadItemsPage {
  data?: ThreadItemEntry[];
  nextCursor?: string | null;
}

export const TURN_ITEMS_PAGE_SIZE = 500;
export const TURN_ITEMS_MAX_PAGES = 20;

/** Completeness describes this bounded read, not whether the turn has finished. */
export interface TurnItemsRead {
  entries: ThreadItemEntry[];
  complete: boolean;
  nextCursor: string | null;
  incompleteReason:
    | 'pageLimit'
    | 'cursorCycle'
    | 'invalidResponse'
    | 'pagingUnavailable'
    | null;
}

/**
 * Reads persisted items in upstream completion order without resuming the thread.
 * A cursor continues an earlier capped read. Only explicit cursor exhaustion
 * certifies coverage; unavailable pagination and malformed responses do not.
 * @returns Accumulated entries and an explicit coverage outcome
 * @throws Unexpected RPC failures, which must never masquerade as empty history
 */
export async function readTurnItems(
  codex: CodexService,
  threadId: string,
  turnId: string,
  cursor?: string,
): Promise<TurnItemsRead> {
  const entries: ThreadItemEntry[] = [];
  const seenCursors = new Set<string>();
  if (cursor !== undefined) seenCursors.add(cursor);
  const incomplete = (
    reason: TurnItemsRead['incompleteReason'],
    nextCursor: string | null = null,
  ): TurnItemsRead => ({
    entries,
    complete: false,
    nextCursor,
    incompleteReason: reason,
  });
  for (let page = 0; page < TURN_ITEMS_MAX_PAGES; page += 1) {
    let response: ThreadItemsPage;
    try {
      response = await requestTurnItemsPage(codex, threadId, turnId, cursor);
    } catch (error) {
      // The pinned refusal conflates unmaterialized history and unsupported
      // stores. It cannot establish that the requested turn is empty.
      if (isEmptyThreadItemsListRefusal(error))
        return incomplete('pagingUnavailable');
      throw error;
    }
    if (
      !response ||
      !Array.isArray(response.data) ||
      !(
        response.nextCursor === null ||
        (typeof response.nextCursor === 'string' &&
          response.nextCursor.length > 0)
      )
    ) {
      return incomplete('invalidResponse');
    }
    for (const entry of response.data) {
      if (
        !entry ||
        entry.turnId !== turnId ||
        !entry.item ||
        typeof entry.item !== 'object' ||
        Array.isArray(entry.item) ||
        typeof entry.item.id !== 'string' ||
        !entry.item.id ||
        typeof entry.item.type !== 'string'
      ) {
        return incomplete('invalidResponse');
      }
      entries.push(entry);
    }
    const nextCursor = response.nextCursor;
    if (nextCursor === null)
      return {
        entries,
        complete: true,
        nextCursor: null,
        incompleteReason: null,
      };
    if (seenCursors.has(nextCursor)) return incomplete('cursorCycle');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return incomplete('pageLimit', cursor ?? null);
}

/** Requests one target-filtered page; both UI and strict provenance readers use it. */
export function requestTurnItemsPage(
  codex: CodexService,
  threadId: string,
  turnId: string,
  cursor?: string,
): Promise<ThreadItemsPage> {
  return codex.request<ThreadItemsPage>('thread/items/list', {
    threadId,
    turnId,
    cursor,
    limit: TURN_ITEMS_PAGE_SIZE,
    sortDirection: 'asc',
  });
}
