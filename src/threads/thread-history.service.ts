/** Experimental paged thread-history access isolated from stable Codex types. */
import { Injectable, Logger } from '@nestjs/common';
import type { v2 } from '../codex/codex-schema';
import { CodexService } from '../codex/codex.service';
import {
  isEmptyThreadItemsListRefusal,
  isUnmaterializedTurnsListError,
} from './thread-errors';
import { assertPaginatedThread } from './thread-history-mode';
import {
  projectTurnForClient,
  type ClientTurn,
} from '../turn-errors/turn-error-projection';

export type TurnItemsView = 'notLoaded' | 'summary' | 'full';
export type SortDirection = 'asc' | 'desc';

export interface TurnsPage {
  data: ClientTurn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface TurnsListParams {
  threadId: string;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: SortDirection | null;
  itemsView?: TurnItemsView | null;
}

export interface MetadataFirstResumeParams {
  threadId: string;
  initialTurnsLimit: number;
  itemsView: TurnItemsView;
}

export type MetadataFirstResumeResponse = v2.ThreadResumeResponse & {
  turnsBackwardsCursor?: string | null;
  itemsBackwardsCursor?: string | null;
  initialTurnsPage?: TurnsPage;
};

type ExperimentalResumeParams = v2.ThreadResumeParams & {
  excludeTurns: true;
  initialTurnsPage: {
    limit: number;
    sortDirection: SortDirection;
    itemsView: TurnItemsView;
  };
};

/** One item plus the turn it belongs to, as returned by `thread/items/list`. */
export interface ThreadItemEntry {
  turnId?: string;
  item: Record<string, unknown>;
}

/** Raised when a provenance walk observes a turn that is still running. */
export class InProgressTurnHistoryError extends Error {
  constructor(
    readonly threadId: string,
    readonly turnId: string,
  ) {
    super(`Thread ${threadId} contains in-progress turn ${turnId}`);
    this.name = 'InProgressTurnHistoryError';
  }
}

/** Raised when the target turn has no persisted user-message item. */
export class TurnUserMessageNotFoundError extends Error {
  constructor(
    readonly threadId: string,
    readonly turnId: string,
  ) {
    super(`Thread ${threadId} turn ${turnId} contains no user message`);
    this.name = 'TurnUserMessageNotFoundError';
  }
}

interface ThreadItemsPage {
  data?: ThreadItemEntry[];
  nextCursor?: string | null;
}

type UserMessageItem = Extract<v2.ThreadItem, { type: 'userMessage' }>;

const TURN_ITEMS_PAGE_SIZE = 500;

/** Backstop so a misbehaving cursor cannot page forever. */
const TURN_ITEMS_MAX_PAGES = 20;

const TURN_COUNT_PAGE_SIZE = 200;

/** Turn-ID discovery pages metadata only, so it can afford a wide page. */
const TURN_ID_PAGE_SIZE = 200;

/**
 * Backstop for turn-ID discovery.
 *
 * Set well above the counting cap because this walk gates fork provenance and
 * must never trade completeness for termination — hitting it is a hard failure,
 * not a truncated result.
 */
const TURN_ID_MAX_PAGES = 200;
const TURN_COUNT_CONCURRENCY = 4;
/**
 * Upper bound on pages walked per thread.
 *
 * Counting has no total in the protocol, so it pages to exhaustion. A thread
 * long enough to exceed this has a count no one is reading off a graph node
 * anyway, and an unbounded loop against a misbehaving cursor would spin
 * forever. Hitting the cap yields an unknown count, never a wrong one.
 */
const TURN_COUNT_MAX_PAGES = 50;

@Injectable()
export class ThreadHistoryService {
  private readonly logger = new Logger(ThreadHistoryService.name);

  constructor(private readonly codex: CodexService) {}

  /**
   * Acquires writer ownership without materializing the entire history.
   *
   * This uses app-server's experimental `excludeTurns` and `initialTurnsPage`
   * surface. The generated schema omits those fields, so this adapter contains
   * the unchecked envelope and validates the page shape before returning it.
   */
  async resumeMetadataFirst(
    params: MetadataFirstResumeParams,
  ): Promise<MetadataFirstResumeResponse> {
    const request: ExperimentalResumeParams = {
      threadId: params.threadId,
      excludeTurns: true,
      initialTurnsPage: {
        limit: params.initialTurnsLimit,
        sortDirection: 'desc',
        itemsView: params.itemsView,
      },
    };
    const response = await this.codex.request<MetadataFirstResumeResponse>(
      'thread/resume',
      request,
    );
    assertPaginatedThread(response.thread, 'thread/resume');
    // An absent page is not an empty page. `excludeTurns` empties `thread.turns`
    // unconditionally, so if the server ever stops honouring `initialTurnsPage`
    // — it is experimental and the generated schema cannot vouch for it —
    // coercing the missing field to `{ data: [] }` would render every
    // conversation as blank rather than reporting a protocol regression.
    // Fall back to the standalone list call so the user still sees history,
    // and log loudly enough that the cause is findable.
    let initialTurnsPage = this.optionalTurnsPage(response.initialTurnsPage);
    if (!initialTurnsPage) {
      this.logger.warn(
        `thread/resume omitted initialTurnsPage for thread=${params.threadId}; ` +
          'falling back to thread/turns/list. Verify the experimental resume ' +
          'surface against the pinned app-server.',
      );
      initialTurnsPage = await this.listTurns({
        threadId: params.threadId,
        limit: params.initialTurnsLimit,
        sortDirection: 'desc',
        itemsView: params.itemsView,
      });
    }
    return {
      ...response,
      initialTurnsPage,
      turnsBackwardsCursor: this.nullableString(response.turnsBackwardsCursor),
      itemsBackwardsCursor: this.nullableString(response.itemsBackwardsCursor),
    };
  }

  /** Reads one metadata-only thread snapshot without acquiring writer ownership. */
  async readThreadMetadata(threadId: string): Promise<v2.ThreadReadResponse> {
    const response = await this.codex.request<v2.ThreadReadResponse>(
      'thread/read',
      {
        threadId,
        includeTurns: false,
      },
    );
    assertPaginatedThread(response.thread, 'thread/read');
    return response;
  }

  /** Pages turn history without resuming the thread. */
  async listTurns(params: TurnsListParams): Promise<TurnsPage> {
    try {
      const response = await this.codex.request<TurnsPage>(
        'thread/turns/list',
        {
          threadId: params.threadId,
          cursor: params.cursor ?? undefined,
          limit: params.limit ?? undefined,
          sortDirection: params.sortDirection ?? undefined,
          itemsView: params.itemsView ?? undefined,
        },
      );
      return this.normalizeTurnsPage(response);
    } catch (err) {
      if (
        (params.cursor !== undefined && params.cursor !== null) ||
        !isUnmaterializedTurnsListError(err)
      ) {
        throw err;
      }
      return { data: [], nextCursor: null, backwardsCursor: null };
    }
  }

  /**
   * Reads every persisted item for one turn without resuming the thread.
   *
   * The `summary` turns view app-server returns by default omits `reasoning`
   * and `plan` items, so a client that opened a thread cheaply has no way to
   * show them. This tops a single turn up to full detail on demand instead of
   * paying for full detail across the whole first page.
   *
   * @param threadId - Thread that owns the turn
   * @param turnId - Turn whose items should be returned
   * @returns Items belonging to that turn, oldest first
   * @throws Unexpected app-server failures other than the pinned empty-thread
   *   refusal
   */
  async listTurnItems(
    threadId: string,
    turnId: string,
  ): Promise<ThreadItemEntry[]> {
    try {
      return await this.listTurnItemsDirect(threadId, turnId);
    } catch (err) {
      if (!isEmptyThreadItemsListRefusal(err)) throw err;
      this.logger.warn(
        `Normalizing thread/items/list refusal to empty for thread=${threadId} turn=${turnId}. ` +
          'Pinned app-server uses this response for an unmaterialized thread, ' +
          'but the same response can also mean the store lacks item pagination.',
      );
      return [];
    }
  }

  /**
   * Reads the edited turn's user message through the strict provenance path.
   *
   * Unlike the UI-facing item reader, this method propagates the pinned
   * unmaterialized/item-paging refusal and fails on cursor anomalies or entries
   * attributed to another turn. Branch provenance must not be committed from
   * a partial or ambiguously filtered item stream.
   *
   * @param threadId - Thread that owns the edited turn
   * @param turnId - Edited turn whose user input is required
   * @returns The persisted user-message content
   * @throws When paging is incomplete, attribution is invalid, or no user
   *   message exists in the target turn
   */
  async readTurnUserMessage(
    threadId: string,
    turnId: string,
  ): Promise<v2.UserInput[]> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (let page = 0; page < TURN_ITEMS_MAX_PAGES; page += 1) {
      const response = await this.requestTurnItemsPage(
        threadId,
        turnId,
        cursor,
      );
      const entries = Array.isArray(response.data) ? response.data : [];
      for (const entry of entries) {
        if (entry.turnId !== turnId) {
          throw new Error(
            `thread/items/list returned an item without the requested turn id for thread ${threadId} turn ${turnId}`,
          );
        }
      }
      for (const entry of entries) {
        if (entry.item?.type !== 'userMessage') continue;
        const content = (entry.item as UserMessageItem).content;
        if (!Array.isArray(content)) {
          throw new Error(
            `thread/items/list returned invalid user-message content for thread ${threadId} turn ${turnId}`,
          );
        }
        return content;
      }

      const nextCursor = this.nullableString(response.nextCursor);
      if (!nextCursor) {
        throw new TurnUserMessageNotFoundError(threadId, turnId);
      }
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw new Error(
          `thread/items/list cursor did not advance for thread ${threadId} turn ${turnId}`,
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error(
      `thread/items/list exceeded ${TURN_ITEMS_MAX_PAGES} pages for thread ${threadId} turn ${turnId}`,
    );
  }

  private async listTurnItemsDirect(
    threadId: string,
    turnId: string,
  ): Promise<ThreadItemEntry[]> {
    const entries: ThreadItemEntry[] = [];
    let cursor: string | undefined;

    // The turn filter does not disable pagination, and the caller marks the
    // result as complete — so stopping at the first page would silently drop
    // the tail of a long turn and never retry it.
    for (let page = 0; page < TURN_ITEMS_MAX_PAGES; page += 1) {
      const response = await this.requestTurnItemsPage(
        threadId,
        turnId,
        cursor,
      );
      if (Array.isArray(response?.data)) entries.push(...response.data);

      const nextCursor = this.nullableString(response?.nextCursor);
      if (!nextCursor) break;
      if (nextCursor === cursor) {
        // A cursor that does not advance would otherwise spin until the page
        // cap, re-fetching the same items each time.
        this.logger.warn(
          `thread/items/list cursor did not advance for thread=${threadId} turn=${turnId}; stopping`,
        );
        break;
      }
      cursor = nextCursor;
    }

    // Entries carry their own turnId so unfiltered pages can be grouped; the
    // filter is advisory, so drop anything that leaked in from another turn.
    return entries.filter((entry) => !entry.turnId || entry.turnId === turnId);
  }

  /**
   * Discovers every persisted turn ID without loading any turn items.
   *
   * Fork validation must compare the complete persisted prefix before writing
   * provenance. Cursor loops and duplicate IDs fail closed because committing
   * a partial or ambiguous prefix would corrupt inherited auxiliary-data reads.
   *
   * @param threadId - Paginated thread whose persisted turn IDs are required
   * @returns Turn IDs in chronological order, or an empty list before the
   *   thread's first user message
   */
  async listAllTurnIds(threadId: string): Promise<string[]> {
    return this.listAllTurnIdsInternal(threadId, false);
  }

  /**
   * Discovers the complete persisted turn order while rejecting active work.
   *
   * The walk is newest-first, so an in-progress turn is normally detected on
   * the first page. It still retains the same duplicate, cursor, and page-bound
   * checks as provenance validation and returns only after the full order has
   * been proven complete.
   *
   * @param threadId - Source thread being prepared for message branching
   * @returns Persisted turn IDs in chronological order
   * @throws {InProgressTurnHistoryError} When any persisted turn is in progress
   */
  async listAllSettledTurnIds(threadId: string): Promise<string[]> {
    return this.listAllTurnIdsInternal(threadId, true);
  }

  /**
   * Walks every lightweight turn page with provenance-grade validation.
   *
   * @param threadId - Thread whose complete persisted order is required
   * @param rejectInProgress - Whether an observed running turn aborts the walk
   * @returns Turn IDs in chronological order
   */
  private async listAllTurnIdsInternal(
    threadId: string,
    rejectInProgress: boolean,
  ): Promise<string[]> {
    const descendingIds: string[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null | undefined;

    for (let page_ = 0; ; page_ += 1) {
      if (page_ >= TURN_ID_MAX_PAGES) {
        // Unlike turn counting, an incomplete answer is not an option here:
        // a truncated prefix would be committed as provenance and silently
        // narrow every inherited auxiliary-data read.
        throw new Error(
          `thread/turns/list exceeded ${TURN_ID_MAX_PAGES} pages for thread ${threadId}`,
        );
      }
      const page = await this.listTurns({
        threadId,
        cursor,
        limit: TURN_ID_PAGE_SIZE,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      });

      for (const turn of page.data) {
        if (typeof turn.id !== 'string' || !turn.id) {
          throw new Error(
            `thread/turns/list returned an invalid turn id for thread ${threadId}`,
          );
        }
        if (rejectInProgress && turn.status === 'inProgress') {
          throw new InProgressTurnHistoryError(threadId, turn.id);
        }
        if (seenIds.has(turn.id)) {
          throw new Error(
            `thread/turns/list returned duplicate turn ${turn.id} for thread ${threadId}`,
          );
        }
        seenIds.add(turn.id);
        descendingIds.push(turn.id);
      }

      const nextCursor = page.nextCursor;
      if (
        nextCursor &&
        (nextCursor === cursor || seenCursors.has(nextCursor))
      ) {
        throw new Error(
          `thread/turns/list cursor did not advance for thread ${threadId}`,
        );
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (!cursor) break;
    }

    return descendingIds.reverse();
  }

  /**
   * Counts turns for graph nodes without resuming.
   *
   * Failures intentionally become `null`: counts are decorative and must not
   * block graph rendering, deletion preview, or delete planning.
   */
  async countTurnsForThreads(threadIds: string[]): Promise<
    Array<{
      threadId: string;
      count: number | null;
      errorMessage: string | null;
    }>
  > {
    const uniqueIds = [...new Set(threadIds.map((id) => id.trim()))].filter(
      Boolean,
    );
    const results = new Map<
      string,
      { threadId: string; count: number | null; errorMessage: string | null }
    >();
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < uniqueIds.length) {
        const threadId = uniqueIds[nextIndex];
        nextIndex += 1;
        try {
          results.set(threadId, {
            threadId,
            count: await this.countOneThread(threadId),
            errorMessage: null,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.logger.debug(
            `Could not count turns for thread=${threadId}: ${error.message}`,
          );
          results.set(threadId, {
            threadId,
            count: null,
            errorMessage: error.message,
          });
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(TURN_COUNT_CONCURRENCY, uniqueIds.length) },
        () => worker(),
      ),
    );
    return uniqueIds.map((threadId) => results.get(threadId)!);
  }

  private async countOneThread(threadId: string): Promise<number> {
    let count = 0;
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = await this.listTurns({
        threadId,
        cursor,
        limit: TURN_COUNT_PAGE_SIZE,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      });
      count += page.data.length;
      cursor = page.nextCursor;
      pages += 1;
      if (cursor && pages >= TURN_COUNT_MAX_PAGES) {
        throw new Error(
          `Turn count for thread ${threadId} exceeded ${TURN_COUNT_MAX_PAGES} pages`,
        );
      }
    } while (cursor);
    return count;
  }

  private normalizeTurnsPage(value: unknown): TurnsPage {
    const record = this.asRecord(value);
    const data = Array.isArray(record.data) ? record.data : [];
    return {
      data: data.map((turn) => projectTurnForClient(turn as v2.Turn)),
      nextCursor: this.nullableString(record.nextCursor),
      backwardsCursor: this.nullableString(record.backwardsCursor),
    };
  }

  /** Requests one ascending, target-filtered item page without normalization. */
  private requestTurnItemsPage(
    threadId: string,
    turnId: string,
    cursor?: string,
  ): Promise<ThreadItemsPage> {
    return this.codex.request<ThreadItemsPage>('thread/items/list', {
      threadId,
      turnId,
      cursor,
      limit: TURN_ITEMS_PAGE_SIZE,
      sortDirection: 'asc',
    });
  }

  /**
   * Normalizes a turn page, distinguishing "absent" from "present but empty".
   *
   * @param value - Candidate page from an experimental response field
   * @returns The page, or null when the field was not a page at all
   */
  private optionalTurnsPage(value: unknown): TurnsPage | null {
    if (!value || typeof value !== 'object') return null;
    if (!Array.isArray((value as Record<string, unknown>).data)) return null;
    return this.normalizeTurnsPage(value);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  }

  private nullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }
}
