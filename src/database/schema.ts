/** Drizzle table declarations for Codex WebUI persistence. */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
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

/** Persisted app-server requests that require a user response, such as approvals. */
export const pendingServerRequests = sqliteTable(
  'pending_server_requests',
  {
    generation: integer('generation').notNull(),
    requestId: text('request_id').notNull(),
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id'),
    itemId: text('item_id'),
    method: text('method').notNull(),
    paramsJson: text('params_json').notNull(),
    status: text('status').notNull(),
    resolvedBy: text('resolved_by'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    resolvedAt: integer('resolved_at'),
  },
  (table) => [
    primaryKey({ columns: [table.generation, table.requestId] }),
    index('idx_pending_requests_thread_status').on(
      table.threadId,
      table.status,
    ),
    index('idx_pending_requests_status_updated').on(
      table.status,
      table.updatedAt,
    ),
  ],
);

export type PendingServerRequestRow = typeof pendingServerRequests.$inferSelect;
export type InsertPendingServerRequestRow =
  typeof pendingServerRequests.$inferInsert;

/** Persists final turn errors for hydration after page refresh. */
export const turnErrors = sqliteTable(
  'turn_errors',
  {
    threadId: text('thread_id').notNull(),
    turnId: text('turn_id').notNull(),
    message: text('message').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.turnId] }),
    index('idx_turn_errors_thread').on(table.threadId),
  ],
);

export type TurnErrorRow = typeof turnErrors.$inferSelect;
export type InsertTurnErrorRow = typeof turnErrors.$inferInsert;

/**
 * Grouping key stored when the edited message is the first turn, i.e. the
 * common prefix is empty. Turn ids are uuids, so this never collides.
 */
export const BRANCH_START_SENTINEL = '__start__';

/**
 * Topology-only fork boundary used when a child was forked after the parent's
 * last known turn. UUID turn ids cannot collide with this sentinel.
 */
export const BRANCH_END_SENTINEL = '__end__';

/**
 * One logical message-version group inside a locally tracked branch tree.
 *
 * Identified by `(treeRootThreadId, commonPrefixTurnId)`. The grouping key is
 * the last turn of the common prefix — not the edited turn — because editing
 * the same logical message from inside a branch names a different edited turn
 * each time while the prefix stays identical.
 */
export const conversationBranchGroups = sqliteTable(
  'conversation_branch_groups',
  {
    groupId: text('group_id').primaryKey(),
    treeRootThreadId: text('tree_root_thread_id').notNull(),
    /** Last turn id of the common prefix, or `BRANCH_START_SENTINEL`. */
    commonPrefixTurnId: text('common_prefix_turn_id').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uidx_branch_groups_root_prefix').on(
      table.treeRootThreadId,
      table.commonPrefixTurnId,
    ),
    index('idx_branch_groups_root').on(table.treeRootThreadId),
  ],
);

export type ConversationBranchGroup =
  typeof conversationBranchGroups.$inferSelect;
export type InsertConversationBranchGroup =
  typeof conversationBranchGroups.$inferInsert;

/**
 * A concrete sibling version for one edited user-message group.
 *
 * A thread appears once per group it participates in, so the same thread can
 * hold several rows: the root thread is the `original` version of every group
 * created from one of its own turns.
 */
export const conversationBranchVersions = sqliteTable(
  'conversation_branch_versions',
  {
    versionId: text('version_id').primaryKey(),
    groupId: text('group_id').notNull(),
    threadId: text('thread_id').notNull(),
    /** 1-based position rendered as `< n/m >`. */
    versionIndex: integer('version_index').notNull(),
    /** `original` for the pre-existing continuation, `branch` for forks. */
    kind: text('kind').notNull(),
    /** `local` rows came from this client; `adopted` rows came from disk scan. */
    source: text('source').notNull().default('local'),
    /** Turn carrying this version's user message; null until the turn starts. */
    messageTurnId: text('message_turn_id'),
    previewText: text('preview_text').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uidx_branch_versions_group_thread').on(
      table.groupId,
      table.threadId,
    ),
    uniqueIndex('uidx_branch_versions_group_index').on(
      table.groupId,
      table.versionIndex,
    ),
    index('idx_branch_versions_thread').on(table.threadId),
    index('idx_branch_versions_group').on(table.groupId),
  ],
);

export type ConversationBranchVersion =
  typeof conversationBranchVersions.$inferSelect;
export type InsertConversationBranchVersion =
  typeof conversationBranchVersions.$inferInsert;

/**
 * Fork edge captured locally because app-server does not expose the boundary.
 *
 * Recorded per child thread rather than per version row: a thread has exactly
 * one origin, but participates in as many version groups as it has edited
 * turns, so inlining provenance into version rows would duplicate it.
 */
export const conversationBranchEdges = sqliteTable(
  'conversation_branch_edges',
  {
    childThreadId: text('child_thread_id').primaryKey(),
    parentThreadId: text('parent_thread_id').notNull(),
    treeRootThreadId: text('tree_root_thread_id').notNull(),
    /** Turn the fork excluded; the child's history stops right before it. */
    forkBeforeTurnId: text('fork_before_turn_id').notNull(),
    commonPrefixTurnId: text('common_prefix_turn_id').notNull(),
    /** `local` rows came from this client; `adopted` rows came from disk scan. */
    source: text('source').notNull().default('local'),
    /**
     * JSON array of turn ids this child inherited from its ancestors, captured
     * from the fork response. Bounds provenance read-through so a child never
     * reads per-turn data its parent produced after the fork point.
     */
    inheritedTurnIds: text('inherited_turn_ids').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_branch_edges_parent').on(table.parentThreadId),
    index('idx_branch_edges_root').on(table.treeRootThreadId),
  ],
);

export type ConversationBranchEdge =
  typeof conversationBranchEdges.$inferSelect;
export type InsertConversationBranchEdge =
  typeof conversationBranchEdges.$inferInsert;
