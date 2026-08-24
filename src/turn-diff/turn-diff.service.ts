/**
 * Persists cumulative turn-level diffs from turn/diff/updated notifications.
 * Buffers diffs in memory and flushes to SQLite only on turn/completed,
 * avoiding repeated writes for every intermediate diff update.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification } from '../codex/codex-schema';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { selectProvenanceRows } from '../conversation-branches/provenance';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { turnDiffs } from '../database/schema';
import type {
  ThreadTurnDiffsResponseDto,
  TurnDiffEntryDto,
} from './dto/turn-diff.dto';

/** Composite key for the in-memory buffer. */
type BufferKey = `${string}:${string}`;

@Injectable()
export class TurnDiffService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TurnDiffService.name);
  /** In-memory buffer: turnKey → { threadId, turnId, diff }. */
  private readonly buffer = new Map<
    BufferKey,
    { threadId: string; turnId: string; diff: string }
  >();

  constructor(
    private readonly codexManager: CodexProcessManager,
    private readonly branches: ConversationBranchesService,
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
  ) {}

  onModuleInit(): void {
    this.codexManager.addListener(
      'notification',
      (notification: ServerNotification) => {
        if (notification.method === 'turn/diff/updated') {
          this.bufferDiff(notification.params);
          return;
        }
        if (notification.method === 'turn/completed') {
          this.flushTurn(notification.params);
        }
      },
    );
  }

  /** Flushes all buffered diffs to SQLite on shutdown. */
  onModuleDestroy(): void {
    this.flushAll();
  }

  /**
   * Reads all persisted turn diffs visible to a thread.
   *
   * Branched threads inherit their prefix turns' diffs from ancestors rather
   * than owning copies of those rows.
   */
  readThreadDiffs(threadId: string): ThreadTurnDiffsResponseDto {
    const provenance = this.branches.resolveProvenance(threadId);
    const rows = this.db
      .select()
      .from(turnDiffs)
      .where(inArray(turnDiffs.threadId, provenance.threadIds))
      .orderBy(turnDiffs.updatedAt)
      .all();

    const turns: TurnDiffEntryDto[] = selectProvenanceRows(provenance, rows)
      .map((row) => ({
        turnId: row.turnId,
        diff: row.diff,
        updatedAt: row.updatedAt,
      }))
      .sort((a, b) => a.updatedAt - b.updatedAt);

    return { threadId, turns };
  }

  /** Buffers the latest cumulative diff in memory (overwrites previous). */
  private bufferDiff(params: Record<string, unknown>): void {
    const threadId = params.threadId as string | undefined;
    const turnId = params.turnId as string | undefined;
    const diff = params.diff as string | undefined;
    if (!threadId || !turnId || typeof diff !== 'string') return;

    const key: BufferKey = `${threadId}:${turnId}`;
    this.buffer.set(key, { threadId, turnId, diff });
  }

  /** Flushes the buffered diff for a completed turn to SQLite. */
  private flushTurn(params: Record<string, unknown>): void {
    const turn = params.turn as { id?: string } | undefined;
    const threadId = params.threadId as string | undefined;
    const turnId = turn?.id;
    if (!threadId || !turnId) return;

    const key: BufferKey = `${threadId}:${turnId}`;
    const entry = this.buffer.get(key);
    if (!entry) return;

    this.buffer.delete(key);
    this.persist(entry.threadId, entry.turnId, entry.diff);
  }

  /** Flushes all buffered diffs (e.g. on shutdown or app-server restart). */
  private flushAll(): void {
    for (const [key, entry] of this.buffer) {
      this.persist(entry.threadId, entry.turnId, entry.diff);
      this.buffer.delete(key);
    }
  }

  private persist(threadId: string, turnId: string, diff: string): void {
    try {
      const now = Date.now();
      this.db
        .insert(turnDiffs)
        .values({ threadId, turnId, diff, updatedAt: now })
        .onConflictDoUpdate({
          target: [turnDiffs.threadId, turnDiffs.turnId],
          set: { diff, updatedAt: now },
        })
        .run();
    } catch (err) {
      this.logger.warn(
        `Failed to persist turn diff for thread=${threadId} turn=${turnId}: ${(err as Error).message}`,
      );
    }
  }
}
