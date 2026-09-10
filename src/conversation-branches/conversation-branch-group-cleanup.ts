/** Transactional version-group cleanup after adoption replacement or confirmed deletion. */
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../database/database.constants';
import {
  conversationBranchVersions,
  conversationBranchGroups,
} from '../database/schema';
type BranchTransaction = Parameters<
  Parameters<AppDatabase['transaction']>[0]
>[0];

/** Resequences surviving alternatives and removes dissolved groups inside the caller transaction. */
export function cleanupBranchGroups(
  tx: BranchTransaction,
  groupIds: string[],
  now: number,
): { dissolvedGroups: number; resequencedGroups: number } {
  const uniqueGroupIds = [...new Set(groupIds)];
  if (uniqueGroupIds.length === 0) {
    return { dissolvedGroups: 0, resequencedGroups: 0 };
  }

  let dissolvedGroups = 0;
  let resequencedGroups = 0;
  for (const groupId of uniqueGroupIds) {
    const rows = tx
      .select()
      .from(conversationBranchVersions)
      .where(eq(conversationBranchVersions.groupId, groupId))
      .orderBy(conversationBranchVersions.versionIndex)
      .all();

    if (rows.length < 2) {
      tx.delete(conversationBranchVersions)
        .where(eq(conversationBranchVersions.groupId, groupId))
        .run();
      tx.delete(conversationBranchGroups)
        .where(eq(conversationBranchGroups.groupId, groupId))
        .run();
      dissolvedGroups += 1;
      continue;
    }

    const alreadySequenced = rows.every(
      (row, index) => row.versionIndex === index + 1,
    );
    if (alreadySequenced) continue;

    rows.forEach((row, index) => {
      tx.update(conversationBranchVersions)
        .set({ versionIndex: -(index + 1), updatedAt: now })
        .where(eq(conversationBranchVersions.versionId, row.versionId))
        .run();
    });
    rows.forEach((row, index) => {
      tx.update(conversationBranchVersions)
        .set({ versionIndex: index + 1, updatedAt: now })
        .where(eq(conversationBranchVersions.versionId, row.versionId))
        .run();
    });
    tx.update(conversationBranchGroups)
      .set({ updatedAt: now })
      .where(eq(conversationBranchGroups.groupId, groupId))
      .run();
    resequencedGroups += 1;
  }

  return { dissolvedGroups, resequencedGroups };
}
