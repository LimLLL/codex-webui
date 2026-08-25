/** Mutating helpers for branch topology rows. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  BRANCH_START_SENTINEL,
  conversationBranchEdges,
  conversationBranchGroups,
  conversationBranchVersions,
  type ConversationBranchEdge,
  type ConversationBranchGroup,
  type ConversationBranchVersion,
} from '../database/schema';

type BranchTransaction = Parameters<
  Parameters<AppDatabase['transaction']>[0]
>[0];

export interface AdoptedForkRecord {
  childThreadId: string;
  parentThreadId: string;
  treeRootThreadId: string;
  forkBeforeTurnId: string;
  commonPrefixTurnId: string | null;
  inheritedTurnIds: string[];
  messageVersion?: {
    originalMessageTurnId: string;
    originalPreviewText: string;
    branchMessageTurnId: string | null;
    branchPreviewText: string;
  };
}

export interface AdoptedForkPersistResult {
  adoptedEdges: number;
  adoptedVersions: number;
  topologyOnlyEdges: number;
}

export interface ReapDeletedThreadResult {
  removedVersionRows: number;
  removedEdges: number;
  dissolvedGroups: number;
  resequencedGroups: number;
}

export class OrphanedLocalTopologyError extends Error {
  constructor(
    readonly threadId: string,
    readonly childThreadIds: string[],
  ) {
    super(
      `Cannot reap ${threadId}; surviving local children would be orphaned: ${childThreadIds.join(
        ', ',
      )}`,
    );
    this.name = 'OrphanedLocalTopologyError';
  }
}

@Injectable()
export class ConversationBranchMutationsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: AppDatabase) {}

  /** Reads all known fork edges, local and adopted. */
  listEdges(): ConversationBranchEdge[] {
    return this.db.select().from(conversationBranchEdges).all();
  }

  /** Reads only locally authored fork edges. Scanner imports must not overwrite these. */
  listLocalEdges(): ConversationBranchEdge[] {
    return this.db
      .select()
      .from(conversationBranchEdges)
      .where(eq(conversationBranchEdges.source, 'local'))
      .all();
  }

  /** Reads all version groups for scanner conflict checks. */
  listGroups(): ConversationBranchGroup[] {
    return this.db.select().from(conversationBranchGroups).all();
  }

  /** Reads all version rows for scanner conflict checks and delete previews. */
  listVersions(): ConversationBranchVersion[] {
    return this.db.select().from(conversationBranchVersions).all();
  }

  /**
   * Replaces the entire scanner-owned topology set.
   *
   * Local rows are left untouched. Adopted rows are disposable because the scan
   * is a startup observation of app-server files, not a user-authored record.
   */
  replaceAdoptedForks(records: AdoptedForkRecord[]): AdoptedForkPersistResult {
    const now = Date.now();
    return this.db.transaction((tx) => {
      // Group cleanup is deferred to the end of the transaction on purpose.
      // Between clearing and re-inserting, a group that mixes local and adopted
      // versions is transiently under-populated, and dissolving on that reading
      // would delete locally authored rows the scanner must never touch.
      const touchedGroupIds = this.clearAdoptedRows(tx);

      let adoptedEdges = 0;
      let topologyOnlyEdges = 0;
      const versionRecords = new Map<string, AdoptedForkRecord[]>();
      for (const record of records) {
        const existingLocalEdge = tx
          .select({ childThreadId: conversationBranchEdges.childThreadId })
          .from(conversationBranchEdges)
          .where(
            and(
              eq(conversationBranchEdges.childThreadId, record.childThreadId),
              eq(conversationBranchEdges.source, 'local'),
            ),
          )
          .get();
        if (existingLocalEdge) continue;

        const commonPrefixTurnId =
          record.commonPrefixTurnId ?? BRANCH_START_SENTINEL;
        tx.insert(conversationBranchEdges)
          .values({
            childThreadId: record.childThreadId,
            parentThreadId: record.parentThreadId,
            treeRootThreadId: record.treeRootThreadId,
            forkBeforeTurnId: record.forkBeforeTurnId,
            commonPrefixTurnId,
            source: 'adopted',
            inheritedTurnIds: JSON.stringify(record.inheritedTurnIds),
            createdAt: now,
          })
          .run();
        adoptedEdges += 1;

        if (!record.messageVersion) {
          topologyOnlyEdges += 1;
          continue;
        }
        const groupKey = this.groupKey(
          record.treeRootThreadId,
          commonPrefixTurnId,
        );
        const groupRecords = versionRecords.get(groupKey) ?? [];
        groupRecords.push(record);
        versionRecords.set(groupKey, groupRecords);
      }

      const versionResult = this.persistAdoptedVersionGroups(
        tx,
        versionRecords,
        now,
      );
      this.cleanupGroups(tx, touchedGroupIds, now);

      return {
        adoptedEdges,
        adoptedVersions: versionResult.adoptedVersions,
        topologyOnlyEdges: topologyOnlyEdges + versionResult.topologyOnlyEdges,
      };
    });
  }

  /**
   * Removes all local metadata for one server-confirmed deleted thread.
   *
   * The caller passes the whole doomed set so this method can refuse to create
   * a local orphan if app-server and local metadata disagree.
   */
  reapDeletedThread(
    threadId: string,
    confirmedDeleteSet: Set<string>,
  ): ReapDeletedThreadResult {
    return this.db.transaction((tx) => {
      const survivingChildren = tx
        .select({ childThreadId: conversationBranchEdges.childThreadId })
        .from(conversationBranchEdges)
        .where(eq(conversationBranchEdges.parentThreadId, threadId))
        .all()
        .map((row) => row.childThreadId)
        .filter((childThreadId) => !confirmedDeleteSet.has(childThreadId));
      if (survivingChildren.length > 0) {
        throw new OrphanedLocalTopologyError(threadId, survivingChildren);
      }

      const affectedGroupIds = tx
        .select({ groupId: conversationBranchVersions.groupId })
        .from(conversationBranchVersions)
        .where(eq(conversationBranchVersions.threadId, threadId))
        .all()
        .map((row) => row.groupId);

      const removedVersions = tx
        .delete(conversationBranchVersions)
        .where(eq(conversationBranchVersions.threadId, threadId))
        .run();
      const removedEdges = tx
        .delete(conversationBranchEdges)
        .where(eq(conversationBranchEdges.childThreadId, threadId))
        .run();
      const cleanup = this.cleanupGroups(tx, affectedGroupIds, Date.now());

      return {
        removedVersionRows: removedVersions.changes,
        removedEdges: removedEdges.changes,
        dissolvedGroups: cleanup.dissolvedGroups,
        resequencedGroups: cleanup.resequencedGroups,
      };
    });
  }

  /**
   * Drops every scanner-owned row and reports the groups that lost members.
   *
   * Cleanup is intentionally left to the caller: dissolving groups here would
   * act on a half-rebuilt table. See {@link replaceAdoptedForks}.
   *
   * @returns Group ids whose membership changed and need a later cleanup pass
   */
  private clearAdoptedRows(tx: BranchTransaction): string[] {
    const affectedGroupIds = tx
      .select({ groupId: conversationBranchVersions.groupId })
      .from(conversationBranchVersions)
      .where(eq(conversationBranchVersions.source, 'adopted'))
      .all()
      .map((row) => row.groupId);

    tx.delete(conversationBranchVersions)
      .where(eq(conversationBranchVersions.source, 'adopted'))
      .run();
    tx.delete(conversationBranchEdges)
      .where(eq(conversationBranchEdges.source, 'adopted'))
      .run();
    return affectedGroupIds;
  }

  private persistAdoptedVersionGroups(
    tx: BranchTransaction,
    versionRecords: Map<string, AdoptedForkRecord[]>,
    now: number,
  ): { adoptedVersions: number; topologyOnlyEdges: number } {
    let adoptedVersions = 0;
    let topologyOnlyEdges = 0;
    for (const records of versionRecords.values()) {
      const first = records[0];
      const commonPrefixTurnId =
        first.commonPrefixTurnId ?? BRANCH_START_SENTINEL;
      let group = this.findGroup(
        tx,
        first.treeRootThreadId,
        commonPrefixTurnId,
      );

      if (!group) {
        const original = this.findOriginalVersionRecord(records);
        if (!original?.messageVersion) {
          topologyOnlyEdges += records.length;
          continue;
        }
        group = this.createGroupWithOriginal(
          tx,
          first.treeRootThreadId,
          commonPrefixTurnId,
          original.parentThreadId,
          original.messageVersion.originalMessageTurnId,
          original.messageVersion.originalPreviewText,
          now,
        );
        adoptedVersions += 1;
      }

      for (const record of this.orderVersionRecords(records)) {
        if (!record.messageVersion) continue;
        const parentVersion = this.findVersion(
          tx,
          group.groupId,
          record.parentThreadId,
        );
        if (!parentVersion) {
          topologyOnlyEdges += 1;
          continue;
        }
        if (this.findVersion(tx, group.groupId, record.childThreadId)) continue;
        this.insertBranchVersion(tx, group.groupId, record, now);
        adoptedVersions += 1;
      }
    }
    return { adoptedVersions, topologyOnlyEdges };
  }

  private findGroup(
    tx: BranchTransaction,
    treeRootThreadId: string,
    commonPrefixTurnId: string,
  ): ConversationBranchGroup | undefined {
    return tx
      .select()
      .from(conversationBranchGroups)
      .where(
        and(
          eq(conversationBranchGroups.treeRootThreadId, treeRootThreadId),
          eq(conversationBranchGroups.commonPrefixTurnId, commonPrefixTurnId),
        ),
      )
      .get();
  }

  private createGroupWithOriginal(
    tx: BranchTransaction,
    treeRootThreadId: string,
    commonPrefixTurnId: string,
    threadId: string,
    messageTurnId: string,
    previewText: string,
    now: number,
  ): ConversationBranchGroup {
    const existing = tx
      .select()
      .from(conversationBranchGroups)
      .where(
        and(
          eq(conversationBranchGroups.treeRootThreadId, treeRootThreadId),
          eq(conversationBranchGroups.commonPrefixTurnId, commonPrefixTurnId),
        ),
      )
      .get();
    if (existing) return existing;

    const inserted = tx
      .insert(conversationBranchGroups)
      .values({
        groupId: randomUUID(),
        treeRootThreadId,
        commonPrefixTurnId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    tx.insert(conversationBranchVersions)
      .values({
        versionId: randomUUID(),
        groupId: inserted.groupId,
        threadId,
        versionIndex: 1,
        kind: 'original',
        source: 'adopted',
        messageTurnId,
        previewText,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return inserted;
  }

  private findVersion(
    tx: BranchTransaction,
    groupId: string,
    threadId: string,
  ): { versionId: string } | undefined {
    return tx
      .select({ versionId: conversationBranchVersions.versionId })
      .from(conversationBranchVersions)
      .where(
        and(
          eq(conversationBranchVersions.groupId, groupId),
          eq(conversationBranchVersions.threadId, threadId),
        ),
      )
      .get();
  }

  private insertBranchVersion(
    tx: BranchTransaction,
    groupId: string,
    record: AdoptedForkRecord,
    now: number,
  ): void {
    const siblings = tx
      .select({ versionIndex: conversationBranchVersions.versionIndex })
      .from(conversationBranchVersions)
      .where(eq(conversationBranchVersions.groupId, groupId))
      .all();
    tx.insert(conversationBranchVersions)
      .values({
        versionId: randomUUID(),
        groupId,
        threadId: record.childThreadId,
        versionIndex:
          Math.max(0, ...siblings.map((row) => row.versionIndex)) + 1,
        kind: 'branch',
        source: 'adopted',
        messageTurnId: record.messageVersion?.branchMessageTurnId ?? null,
        previewText: record.messageVersion?.branchPreviewText ?? '',
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  private findOriginalVersionRecord(
    records: AdoptedForkRecord[],
  ): AdoptedForkRecord | undefined {
    const childIds = new Set(records.map((record) => record.childThreadId));
    return this.orderVersionRecords(records).find(
      (record) => !childIds.has(record.parentThreadId),
    );
  }

  private orderVersionRecords(
    records: AdoptedForkRecord[],
  ): AdoptedForkRecord[] {
    const byParent = new Map<string, AdoptedForkRecord[]>();
    const childIds = new Set(records.map((record) => record.childThreadId));
    for (const record of records) {
      const siblings = byParent.get(record.parentThreadId) ?? [];
      siblings.push(record);
      byParent.set(record.parentThreadId, siblings);
    }

    const ordered: AdoptedForkRecord[] = [];
    const seen = new Set<string>();
    const visit = (record: AdoptedForkRecord) => {
      if (seen.has(record.childThreadId)) return;
      seen.add(record.childThreadId);
      ordered.push(record);
      const children = byParent.get(record.childThreadId) ?? [];
      children.sort((a, b) => a.childThreadId.localeCompare(b.childThreadId));
      children.forEach(visit);
    };

    const byChildId = (a: AdoptedForkRecord, b: AdoptedForkRecord) =>
      a.childThreadId.localeCompare(b.childThreadId);
    records
      .filter((record) => !childIds.has(record.parentThreadId))
      .sort(byChildId)
      .forEach(visit);
    // Copy before sorting: `records` is the caller's array, and this method is
    // called twice per group, so sorting in place would reorder its input.
    [...records].sort(byChildId).forEach(visit);
    return ordered;
  }

  private groupKey(
    treeRootThreadId: string,
    commonPrefixTurnId: string,
  ): string {
    return `${treeRootThreadId}\u0000${commonPrefixTurnId}`;
  }

  private cleanupGroups(
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
}
