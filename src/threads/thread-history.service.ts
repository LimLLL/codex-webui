/** Experimental paged thread-history access isolated from stable Codex types. */
import { Injectable, Logger } from '@nestjs/common';
import type { v2 } from '../codex/codex-schema';
import { CodexService } from '../codex/codex.service';

export type TurnItemsView = 'notLoaded' | 'summary' | 'full';
export type SortDirection = 'asc' | 'desc';

export interface TurnsPage {
  data: v2.Turn[];
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

const TURN_COUNT_PAGE_SIZE = 200;
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
  readThreadMetadata(threadId: string): Promise<v2.ThreadReadResponse> {
    return this.codex.request<v2.ThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: false,
    });
  }

  /** Pages turn history without resuming the thread. */
  async listTurns(params: TurnsListParams): Promise<TurnsPage> {
    const response = await this.codex.request<TurnsPage>('thread/turns/list', {
      threadId: params.threadId,
      cursor: params.cursor ?? undefined,
      limit: params.limit ?? undefined,
      sortDirection: params.sortDirection ?? undefined,
      itemsView: params.itemsView ?? undefined,
    });
    return this.normalizeTurnsPage(response);
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
      data: data as v2.Turn[],
      nextCursor: this.nullableString(record.nextCursor),
      backwardsCursor: this.nullableString(record.backwardsCursor),
    };
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
