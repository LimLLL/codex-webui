/** Persists and resolves local conversation branch topology. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
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
import type {
  BranchGroupDto,
  BranchStateDto,
  BranchTreeDto,
  BranchTreeMemberDto,
  BranchVersionDto,
} from './dto/conversation-branches.dto';
import type { ThreadProvenance } from './provenance';

/** Inputs needed to persist one fork as a tracked message version. */
export interface RecordMessageBranchParams {
  /** Thread the user was viewing when they edited the message. */
  sourceThreadId: string;
  /** Thread id returned by `thread/fork`. */
  childThreadId: string;
  /** Root of the local branch tree both threads belong to. */
  treeRootThreadId: string;
  /** Last turn of the common prefix; null when the first turn was edited. */
  commonPrefixTurnId: string | null;
  /** Turn being replaced, as named in the source thread. */
  editedTurnId: string;
  /** Turn ids the fork inherited, taken from the fork response. */
  inheritedTurnIds: string[];
  /** Preview of the message being replaced, for the original version row. */
  originalPreviewText: string;
  /** Preview of the edited message, shown until its turn actually starts. */
  branchPreviewText: string;
}

/** Local topology as it stands right after a branch was recorded. */
export interface RecordedMessageBranch {
  tree: BranchTreeDto;
  group: BranchGroupDto;
  version: BranchVersionDto;
}

@Injectable()
export class ConversationBranchesService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: AppDatabase) {}

  /** Resolves the locally tracked tree root for a thread, or the thread itself. */
  resolveTreeRootThreadId(threadId: string): string {
    const edge = this.db
      .select({ treeRootThreadId: conversationBranchEdges.treeRootThreadId })
      .from(conversationBranchEdges)
      .where(eq(conversationBranchEdges.childThreadId, threadId))
      .get();
    if (edge) return edge.treeRootThreadId;

    const group = this.db
      .select({ treeRootThreadId: conversationBranchGroups.treeRootThreadId })
      .from(conversationBranchGroups)
      .innerJoin(
        conversationBranchVersions,
        eq(
          conversationBranchVersions.groupId,
          conversationBranchGroups.groupId,
        ),
      )
      .where(eq(conversationBranchVersions.threadId, threadId))
      .limit(1)
      .get();
    return group?.treeRootThreadId ?? threadId;
  }

  /** Returns the known local thread ids for the branch tree containing `threadId`. */
  listKnownTreeThreadIds(threadId: string): string[] {
    const rootThreadId = this.resolveTreeRootThreadId(threadId);
    return this.collectTreeThreadIds(rootThreadId);
  }

  /**
   * Resolves the ancestor chain and inherited turns for provenance read-through.
   *
   * Untracked threads resolve to themselves with no inherited turns, so callers
   * need no special case for conversations that were never branched.
   */
  resolveProvenance(threadId: string): ThreadProvenance {
    const edges = this.listTreeEdges(this.resolveTreeRootThreadId(threadId));
    const edgeByChild = new Map(
      edges.map((edge) => [edge.childThreadId, edge]),
    );

    const ownEdge = edgeByChild.get(threadId);
    if (!ownEdge) return { threadIds: [threadId], inheritedTurnIds: null };

    // The fork response carries the *complete* inherited prefix, so a single
    // hop already bounds every ancestor's contribution.
    const inheritedTurnIds = new Set(this.parseTurnIds(ownEdge));

    const chain = [threadId];
    let current: string | undefined = ownEdge.parentThreadId;
    while (current && !chain.includes(current)) {
      chain.unshift(current);
      current = edgeByChild.get(current)?.parentThreadId;
    }
    return { threadIds: chain, inheritedTurnIds };
  }

  /** Returns true when the thread has locally tracked descendants. */
  hasKnownDescendants(threadId: string): boolean {
    return this.listKnownDescendants(threadId).length > 0;
  }

  /** Capability state used by clients to disable unsafe thread operations. */
  readBranchState(threadId: string): BranchStateDto {
    const rootThreadId = this.resolveTreeRootThreadId(threadId);
    const knownTreeThreadIds = this.collectTreeThreadIds(rootThreadId);
    const hasKnownDescendants =
      this.listKnownDescendants(threadId, rootThreadId).length > 0;

    return {
      threadId,
      treeRootThreadId: rootThreadId,
      tracked: knownTreeThreadIds.length > 1 || this.hasVersionRows(threadId),
      hasKnownDescendants,
      knownTreeThreadIds,
    };
  }

  /** Reads the complete local branch tree containing a thread. */
  readBranchTree(threadId: string): BranchTreeDto {
    return this.buildTreeDto(this.resolveTreeRootThreadId(threadId));
  }

  /**
   * Reads all locally tracked branch trees.
   *
   * Roots come from the union of version groups and fork edges. Groups alone
   * are not enough: a fork that is pure topology (an ordinary fork, or an
   * adopted one whose boundary is unknown) has an edge but no group, and a tree
   * made only of those would be invisible to every caller that discovers
   * descendants through this list — including the sidebar's fold decision and
   * the branch graph entry point, which would then disagree with what a delete
   * actually removes.
   */
  listBranchTrees(): BranchTreeDto[] {
    const groupRoots = this.db
      .selectDistinct({
        treeRootThreadId: conversationBranchGroups.treeRootThreadId,
      })
      .from(conversationBranchGroups)
      .all();
    const edgeRoots = this.db
      .selectDistinct({
        treeRootThreadId: conversationBranchEdges.treeRootThreadId,
      })
      .from(conversationBranchEdges)
      .all();
    const rootThreadIds = new Set(
      [...groupRoots, ...edgeRoots].map((row) => row.treeRootThreadId),
    );
    return [...rootThreadIds].map((rootThreadId) =>
      this.buildTreeDto(rootThreadId),
    );
  }

  /**
   * Records the original and branch version rows plus the child fork edge.
   *
   * Runs as one transaction: a fork whose metadata is not durable is worse than
   * no fork at all, because the caller can still delete an unrecorded child.
   *
   * The original version row is written for `sourceThreadId` only, which makes
   * groups **path-local**: editing a turn inherited from an ancestor registers
   * the branch the edit was made in, not the ancestor. That is intended — the
   * ancestor's copy of that turn is unchanged, so it is not an alternative
   * version of anything.
   *
   * @param params - Fork outcome plus the grouping key derived from the prefix
   * @returns The refreshed tree, the affected group, and the new version row
   */
  recordMessageBranch(
    params: RecordMessageBranchParams,
  ): RecordedMessageBranch {
    const now = Date.now();
    const commonPrefixTurnId =
      params.commonPrefixTurnId ?? BRANCH_START_SENTINEL;

    const { groupId, version } = this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(conversationBranchGroups)
        .where(
          and(
            eq(
              conversationBranchGroups.treeRootThreadId,
              params.treeRootThreadId,
            ),
            eq(conversationBranchGroups.commonPrefixTurnId, commonPrefixTurnId),
          ),
        )
        .get();

      let currentGroupId: string;
      if (existing) {
        currentGroupId = existing.groupId;
        tx.update(conversationBranchGroups)
          .set({ updatedAt: now })
          .where(eq(conversationBranchGroups.groupId, currentGroupId))
          .run();
      } else {
        currentGroupId = randomUUID();
        tx.insert(conversationBranchGroups)
          .values({
            groupId: currentGroupId,
            treeRootThreadId: params.treeRootThreadId,
            commonPrefixTurnId,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        // The pre-existing continuation is version 1 of the new group.
        tx.insert(conversationBranchVersions)
          .values({
            versionId: randomUUID(),
            groupId: currentGroupId,
            threadId: params.sourceThreadId,
            versionIndex: 1,
            kind: 'original',
            source: 'local',
            messageTurnId: params.editedTurnId,
            previewText: params.originalPreviewText,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }

      tx.insert(conversationBranchEdges)
        .values({
          childThreadId: params.childThreadId,
          parentThreadId: params.sourceThreadId,
          treeRootThreadId: params.treeRootThreadId,
          forkBeforeTurnId: params.editedTurnId,
          commonPrefixTurnId,
          source: 'local',
          inheritedTurnIds: JSON.stringify(params.inheritedTurnIds),
          createdAt: now,
        })
        .run();

      const siblings = tx
        .select({ versionIndex: conversationBranchVersions.versionIndex })
        .from(conversationBranchVersions)
        .where(eq(conversationBranchVersions.groupId, currentGroupId))
        .all();
      const inserted = tx
        .insert(conversationBranchVersions)
        .values({
          versionId: randomUUID(),
          groupId: currentGroupId,
          threadId: params.childThreadId,
          versionIndex:
            Math.max(0, ...siblings.map((row) => row.versionIndex)) + 1,
          kind: 'branch',
          source: 'local',
          messageTurnId: null,
          previewText: params.branchPreviewText,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      return { groupId: currentGroupId, version: inserted };
    });

    const tree = this.buildTreeDto(params.treeRootThreadId);
    const group = tree.groups.find((item) => item.groupId === groupId);
    if (!group) {
      throw new Error(`branch group ${groupId} vanished after insert`);
    }
    return { tree, group, version: this.toVersionDto(version) };
  }

  /**
   * Binds a freshly started turn to the branch version awaiting it.
   *
   * A branch version is created before its turn exists, so the switcher has no
   * turn to anchor to until the edited message is actually sent.
   *
   * @param threadId - Thread the turn was started in
   * @param turnId - Turn id returned by `turn/start`
   * @param previewText - Preview derived from the turn input; blank keeps the existing one
   */
  attachPendingVersionTurn(
    threadId: string,
    turnId: string,
    previewText: string,
  ): void {
    const pending = this.db
      .select()
      .from(conversationBranchVersions)
      .where(
        and(
          eq(conversationBranchVersions.threadId, threadId),
          eq(conversationBranchVersions.kind, 'branch'),
          isNull(conversationBranchVersions.messageTurnId),
        ),
      )
      .orderBy(conversationBranchVersions.createdAt)
      .get();
    if (!pending) return;

    this.db
      .update(conversationBranchVersions)
      .set({
        messageTurnId: turnId,
        previewText: previewText || pending.previewText,
        updatedAt: Date.now(),
      })
      .where(eq(conversationBranchVersions.versionId, pending.versionId))
      .run();
  }

  private listTreeEdges(rootThreadId: string): ConversationBranchEdge[] {
    return this.db
      .select()
      .from(conversationBranchEdges)
      .where(eq(conversationBranchEdges.treeRootThreadId, rootThreadId))
      .all();
  }

  private parseTurnIds(edge: ConversationBranchEdge): string[] {
    try {
      const parsed: unknown = JSON.parse(edge.inheritedTurnIds);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      // A corrupt row must not widen provenance; an empty prefix is the safe read.
      return [];
    }
  }

  private collectTreeThreadIds(rootThreadId: string): string[] {
    const edges = this.listTreeEdges(rootThreadId);
    return [
      ...new Set([rootThreadId, ...edges.map((edge) => edge.childThreadId)]),
    ];
  }

  private listKnownDescendants(
    threadId: string,
    rootThreadId = this.resolveTreeRootThreadId(threadId),
  ): string[] {
    const childrenByParent = new Map<string, string[]>();
    for (const edge of this.listTreeEdges(rootThreadId)) {
      const children = childrenByParent.get(edge.parentThreadId) ?? [];
      children.push(edge.childThreadId);
      childrenByParent.set(edge.parentThreadId, children);
    }

    const descendants = new Set<string>();
    const queue = [...(childrenByParent.get(threadId) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || descendants.has(current)) continue;
      descendants.add(current);
      queue.push(...(childrenByParent.get(current) ?? []));
    }
    return [...descendants];
  }

  private hasVersionRows(threadId: string): boolean {
    const row = this.db
      .select({ versionId: conversationBranchVersions.versionId })
      .from(conversationBranchVersions)
      .where(eq(conversationBranchVersions.threadId, threadId))
      .limit(1)
      .get();
    return Boolean(row);
  }

  private buildTreeDto(rootThreadId: string): BranchTreeDto {
    const edges = this.listTreeEdges(rootThreadId);
    const groups = this.db
      .select()
      .from(conversationBranchGroups)
      .where(eq(conversationBranchGroups.treeRootThreadId, rootThreadId))
      .orderBy(conversationBranchGroups.createdAt)
      .all();
    const versions =
      groups.length === 0
        ? []
        : this.db
            .select()
            .from(conversationBranchVersions)
            .where(
              inArray(
                conversationBranchVersions.groupId,
                groups.map((group) => group.groupId),
              ),
            )
            .orderBy(conversationBranchVersions.versionIndex)
            .all();

    return {
      treeRootThreadId: rootThreadId,
      tracked: groups.length > 0 || edges.length > 0,
      members: this.toMemberDtos(rootThreadId, edges),
      groups: groups.map((group) => this.toGroupDto(group, versions)),
    };
  }

  private toMemberDtos(
    rootThreadId: string,
    edges: ConversationBranchEdge[],
  ): BranchTreeMemberDto[] {
    const parentIds = new Set(edges.map((edge) => edge.parentThreadId));
    const members: BranchTreeMemberDto[] = [
      {
        threadId: rootThreadId,
        parentThreadId: null,
        hasChildren: parentIds.has(rootThreadId),
        source: 'local',
        commonPrefixTurnId: null,
      },
    ];

    for (const edge of edges) {
      if (edge.childThreadId === rootThreadId) continue;
      members.push({
        threadId: edge.childThreadId,
        parentThreadId: edge.parentThreadId,
        hasChildren: parentIds.has(edge.childThreadId),
        source: edge.source === 'adopted' ? 'adopted' : 'local',
        // Identifies which version group describes *this* fork. A thread can
        // appear in several groups — it is a branch of the group it was forked
        // into, and the original of any group created from its own later turns
        // — and only the one keyed by this prefix says how it differs from its
        // parent.
        commonPrefixTurnId:
          edge.commonPrefixTurnId === BRANCH_START_SENTINEL
            ? null
            : edge.commonPrefixTurnId,
      });
    }
    return members;
  }

  private toGroupDto(
    group: ConversationBranchGroup,
    versions: ConversationBranchVersion[],
  ): BranchGroupDto {
    return {
      groupId: group.groupId,
      treeRootThreadId: group.treeRootThreadId,
      commonPrefixTurnId:
        group.commonPrefixTurnId === BRANCH_START_SENTINEL
          ? null
          : group.commonPrefixTurnId,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      versions: versions
        .filter((version) => version.groupId === group.groupId)
        .map((version) => this.toVersionDto(version)),
    };
  }

  private toVersionDto(version: ConversationBranchVersion): BranchVersionDto {
    return {
      versionId: version.versionId,
      groupId: version.groupId,
      threadId: version.threadId,
      versionIndex: version.versionIndex,
      kind: version.kind === 'original' ? 'original' : 'branch',
      source: version.source === 'adopted' ? 'adopted' : 'local',
      messageTurnId: version.messageTurnId,
      previewText: version.previewText,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
    };
  }
}
