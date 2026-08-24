/** Persists token usage snapshots from Codex app-server notifications. */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification, v2 } from '../codex/codex-schema';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { selectProvenanceRows } from '../conversation-branches/provenance';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  tokenUsageSnapshots,
  type TokenUsageSnapshot,
} from '../database/schema';
import type {
  ThreadTokenUsageResponseDto,
  TokenUsageBreakdownDto,
  TurnTokenUsageDto,
} from './dto/token-usage.dto';

@Injectable()
export class TokenUsageService implements OnModuleInit {
  private readonly logger = new Logger(TokenUsageService.name);

  constructor(
    private readonly codexManager: CodexProcessManager,
    private readonly branches: ConversationBranchesService,
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
  ) {}

  onModuleInit(): void {
    this.codexManager.addListener(
      'notification',
      (notification: ServerNotification) => {
        if (notification.method !== 'thread/tokenUsage/updated') return;
        this.upsertFromNotification(notification.params);
      },
    );
  }

  /**
   * Reads all snapshots visible to a thread, ordered by their update time.
   *
   * Branched threads inherit their prefix turns' usage from ancestors rather
   * than owning copies of those rows.
   */
  readThreadUsage(threadId: string): ThreadTokenUsageResponseDto {
    const provenance = this.branches.resolveProvenance(threadId);
    const rows = this.db
      .select()
      .from(tokenUsageSnapshots)
      .where(inArray(tokenUsageSnapshots.threadId, provenance.threadIds))
      .orderBy(tokenUsageSnapshots.updatedAt)
      .all();

    const turns = selectProvenanceRows(provenance, rows)
      .map((row) => this.toTurnUsage(row))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    return {
      threadId,
      turns,
      latest: turns.at(-1) ?? null,
    };
  }

  /** Reads the latest snapshot only; used by recovery paths that do not need history. */
  readLatestThreadUsage(threadId: string): TurnTokenUsageDto | null {
    return this.readThreadUsage(threadId).latest;
  }

  private upsertFromNotification(
    params: v2.ThreadTokenUsageUpdatedNotification,
  ): void {
    const { threadId, turnId, tokenUsage } = params;
    if (!threadId || !turnId || !tokenUsage) return;

    try {
      const row = this.toInsert(threadId, turnId, tokenUsage);
      this.db
        .insert(tokenUsageSnapshots)
        .values(row)
        .onConflictDoUpdate({
          target: [tokenUsageSnapshots.threadId, tokenUsageSnapshots.turnId],
          set: {
            totalTokens: row.totalTokens,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            outputTokens: row.outputTokens,
            reasoningOutputTokens: row.reasoningOutputTokens,
            lastTotalTokens: row.lastTotalTokens,
            lastInputTokens: row.lastInputTokens,
            lastCachedInputTokens: row.lastCachedInputTokens,
            lastOutputTokens: row.lastOutputTokens,
            lastReasoningOutputTokens: row.lastReasoningOutputTokens,
            modelContextWindow: row.modelContextWindow,
            rawPayload: row.rawPayload,
            updatedAt: row.updatedAt,
          },
        })
        .run();
    } catch (err) {
      this.logger.warn(
        `Failed to persist token usage for thread=${threadId} turn=${turnId}: ${(err as Error).message}`,
      );
    }
  }

  private toInsert(
    threadId: string,
    turnId: string,
    usage: v2.ThreadTokenUsage,
  ): typeof tokenUsageSnapshots.$inferInsert {
    return {
      threadId,
      turnId,
      totalTokens: usage.total.totalTokens,
      inputTokens: usage.total.inputTokens,
      cachedInputTokens: usage.total.cachedInputTokens,
      outputTokens: usage.total.outputTokens,
      reasoningOutputTokens: usage.total.reasoningOutputTokens,
      lastTotalTokens: usage.last.totalTokens,
      lastInputTokens: usage.last.inputTokens,
      lastCachedInputTokens: usage.last.cachedInputTokens,
      lastOutputTokens: usage.last.outputTokens,
      lastReasoningOutputTokens: usage.last.reasoningOutputTokens,
      modelContextWindow: usage.modelContextWindow,
      rawPayload: JSON.stringify(usage),
      updatedAt: Date.now(),
    };
  }

  private toTurnUsage(row: TokenUsageSnapshot): TurnTokenUsageDto {
    return {
      turnId: row.turnId,
      usage: {
        total: this.toTotalBreakdown(row),
        last: this.toLastBreakdown(row),
        modelContextWindow: row.modelContextWindow,
      },
      updatedAt: row.updatedAt,
    };
  }

  private toTotalBreakdown(row: TokenUsageSnapshot): TokenUsageBreakdownDto {
    return {
      totalTokens: row.totalTokens,
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      outputTokens: row.outputTokens,
      reasoningOutputTokens: row.reasoningOutputTokens,
    };
  }

  private toLastBreakdown(row: TokenUsageSnapshot): TokenUsageBreakdownDto {
    return {
      totalTokens: row.lastTotalTokens,
      inputTokens: row.lastInputTokens,
      cachedInputTokens: row.lastCachedInputTokens,
      outputTokens: row.lastOutputTokens,
      reasoningOutputTokens: row.lastReasoningOutputTokens,
    };
  }
}
