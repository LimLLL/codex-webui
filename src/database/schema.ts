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

/** Persists the cumulative turn-level diff from turn/diff/updated notifications. */
export const turnDiffs = sqliteTable(
  'turn_diffs',
  {
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    diff: text('diff').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.turnId] }),
    index('idx_turn_diffs_thread').on(table.threadId),
  ],
);

export type TurnDiffRow = typeof turnDiffs.$inferSelect;
export type InsertTurnDiffRow = typeof turnDiffs.$inferInsert;

/** Generic runtime-configurable settings seeded from code-owned definitions. */
export const settings = sqliteTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: text('value'),
    type: text('type').notNull(),
    category: text('category').notNull(),
    description: text('description').notNull(),
    defaultValue: text('default_value').notNull(),
    constraints: text('constraints').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_settings_category').on(table.category)],
);

export type SettingRow = typeof settings.$inferSelect;
export type InsertSettingRow = typeof settings.$inferInsert;
