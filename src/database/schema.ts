/** Drizzle table declarations for Codex WebUI persistence. */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const tokenUsageSnapshots = sqliteTable(
  'token_usage_snapshots',
  {
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cachedInputTokens: integer('cached_input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    reasoningOutputTokens: integer('reasoning_output_tokens').notNull(),
    lastTotalTokens: integer('last_total_tokens').notNull(),
    lastInputTokens: integer('last_input_tokens').notNull(),
    lastCachedInputTokens: integer('last_cached_input_tokens').notNull(),
    lastOutputTokens: integer('last_output_tokens').notNull(),
    lastReasoningOutputTokens: integer(
      'last_reasoning_output_tokens',
    ).notNull(),
    modelContextWindow: integer('model_context_window'),
    rawPayload: text('raw_payload').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.turnId] }),
    index('idx_token_usage_thread_updated').on(table.threadId, table.updatedAt),
  ],
);

export type TokenUsageSnapshot = typeof tokenUsageSnapshots.$inferSelect;
export type InsertTokenUsageSnapshot = typeof tokenUsageSnapshots.$inferInsert;
