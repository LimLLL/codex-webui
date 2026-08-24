/** Resolves which per-turn rows a branched thread inherits from its ancestors. */

/**
 * Which threads and turns a thread may read per-turn local data from.
 *
 * `inheritedTurnIds` is null for untracked threads, meaning "no restriction":
 * every row keyed by the thread itself is in scope.
 */
export interface ThreadProvenance {
  /** Ancestor chain ordered root → thread, so descendants override ancestors. */
  threadIds: string[];
  /** Turn ids inherited from ancestors, or null when the thread has none. */
  inheritedTurnIds: Set<string> | null;
}

/** Minimum shape a per-turn row needs to be resolvable through provenance. */
export interface ProvenanceScopedRow {
  threadId: string;
  turnId: string;
}

/**
 * Picks the rows a thread should see, the nearest ancestor winning per turn.
 *
 * Ancestor rows are only admitted for turns the thread actually inherited.
 * Without that bound a branch would surface per-turn data its parent produced
 * *after* the fork point, which is not part of the branch's history — most
 * visibly by poisoning aggregates such as "latest token usage".
 *
 * @param provenance - Chain and inherited turn ids for the reading thread
 * @param rows - Rows already restricted to `provenance.threadIds`
 * @returns At most one row per visible turn id
 */
export function selectProvenanceRows<T extends ProvenanceScopedRow>(
  provenance: ThreadProvenance,
  rows: T[],
): T[] {
  const { threadIds, inheritedTurnIds } = provenance;
  const ownThreadId = threadIds.at(-1);
  const rankByThreadId = new Map(
    threadIds.map((threadId, index) => [threadId, index]),
  );

  const byTurnId = new Map<string, { row: T; rank: number }>();
  for (const row of rows) {
    const rank = rankByThreadId.get(row.threadId);
    if (rank === undefined) continue;
    // Own rows are always in scope; ancestor rows only for inherited turns.
    if (
      row.threadId !== ownThreadId &&
      inheritedTurnIds !== null &&
      !inheritedTurnIds.has(row.turnId)
    ) {
      continue;
    }
    const existing = byTurnId.get(row.turnId);
    if (!existing || rank >= existing.rank) {
      byTurnId.set(row.turnId, { row, rank });
    }
  }
  return [...byTurnId.values()].map((entry) => entry.row);
}
