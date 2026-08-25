import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AppDatabase } from '../database/database.constants';
import * as schema from '../database/schema';
import {
  ConversationBranchMutationsService,
  OrphanedLocalTopologyError,
} from './conversation-branch-mutations.service';
import { ConversationBranchesService } from './conversation-branches.service';

describe('ConversationBranchesService', () => {
  let sqlite: Database.Database;
  let service: ConversationBranchesService;
  let mutations: ConversationBranchMutationsService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE conversation_branch_groups (
        group_id TEXT PRIMARY KEY NOT NULL,
        tree_root_thread_id TEXT NOT NULL,
        common_prefix_turn_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX uniq_branch_group_root_prefix
        ON conversation_branch_groups (tree_root_thread_id, common_prefix_turn_id);

      CREATE TABLE conversation_branch_versions (
        version_id TEXT PRIMARY KEY NOT NULL,
        group_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        version_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        message_turn_id TEXT,
        preview_text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX uniq_branch_version_group_thread
        ON conversation_branch_versions (group_id, thread_id);
      CREATE UNIQUE INDEX uniq_branch_version_group_index
        ON conversation_branch_versions (group_id, version_index);

      CREATE TABLE conversation_branch_edges (
        child_thread_id TEXT PRIMARY KEY NOT NULL,
        parent_thread_id TEXT NOT NULL,
        tree_root_thread_id TEXT NOT NULL,
        fork_before_turn_id TEXT NOT NULL,
        common_prefix_turn_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        inherited_turn_ids TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_branch_edge_parent
        ON conversation_branch_edges (parent_thread_id);
      CREATE INDEX idx_branch_edge_root
        ON conversation_branch_edges (tree_root_thread_id);
    `);
    const db = drizzle(sqlite, { schema }) as AppDatabase;
    service = new ConversationBranchesService(db);
    mutations = new ConversationBranchMutationsService(db);
  });

  afterEach(() => sqlite.close());

  it('records the original and branch versions for an empty-prefix edit', () => {
    const result = service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'child-1',
      treeRootThreadId: 'root',
      commonPrefixTurnId: null,
      editedTurnId: 'turn-1',
      inheritedTurnIds: [],
      originalPreviewText: 'original text',
      branchPreviewText: 'edited text',
    });

    expect(result.group).toMatchObject({
      treeRootThreadId: 'root',
      commonPrefixTurnId: null,
    });
    expect(result.group.versions).toMatchObject([
      {
        threadId: 'root',
        versionIndex: 1,
        kind: 'original',
        messageTurnId: 'turn-1',
        previewText: 'original text',
      },
      {
        threadId: 'child-1',
        versionIndex: 2,
        kind: 'branch',
        messageTurnId: null,
        previewText: 'edited text',
      },
    ]);
    expect(service.readBranchState('root')).toMatchObject({
      treeRootThreadId: 'root',
      tracked: true,
      hasKnownDescendants: true,
      knownTreeThreadIds: ['root', 'child-1'],
    });
  });

  it('keeps re-edits of one message in a single version group', () => {
    // Editing the same logical message from inside a branch names a different
    // edited turn (turn-1 vs turn-1b) but leaves the common prefix unchanged,
    // which is why the prefix — not the edited turn — is the grouping key.
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'child-1',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'original text',
      branchPreviewText: 'edited text',
    });
    service.attachPendingVersionTurn('child-1', 'turn-1b', 'edited text');

    service.recordMessageBranch({
      sourceThreadId: 'child-1',
      childThreadId: 'child-2',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1b',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'unused',
      branchPreviewText: 'edited again',
    });

    const tree = service.readBranchTree('child-2');
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0].versions.map((version) => version.threadId)).toEqual([
      'root',
      'child-1',
      'child-2',
    ]);
  });

  it('starts a nested group when a later message is edited inside a branch', () => {
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'child-1',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'original text',
      branchPreviewText: 'edited text',
    });
    service.recordMessageBranch({
      sourceThreadId: 'child-1',
      childThreadId: 'child-2',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-1b',
      editedTurnId: 'turn-2b',
      inheritedTurnIds: ['turn-0', 'turn-1b'],
      originalPreviewText: 'downstream text',
      branchPreviewText: 'downstream edit',
    });

    const tree = service.readBranchTree('root');
    expect(tree.groups.map((group) => group.commonPrefixTurnId)).toEqual([
      'turn-0',
      'turn-1b',
    ]);
  });

  it('bounds provenance to the turns a branch actually inherited', () => {
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'child-1',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'original text',
      branchPreviewText: 'edited text',
    });

    const provenance = service.resolveProvenance('child-1');
    expect(provenance.threadIds).toEqual(['root', 'child-1']);
    // turn-1 stayed behind in the parent; the branch must not read its data.
    expect(provenance.inheritedTurnIds?.has('turn-0')).toBe(true);
    expect(provenance.inheritedTurnIds?.has('turn-1')).toBe(false);
  });

  it('bounds provenance correctly three forks deep', () => {
    // root ─fork before t2→ b1 ─fork before t3→ b2 ─fork before t4→ b3
    // Each fork response carries the complete inherited prefix, so one hop's
    // stored list must already cover every ancestor's contribution.
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'b1',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 't1',
      editedTurnId: 't2',
      inheritedTurnIds: ['t1'],
      originalPreviewText: 'one',
      branchPreviewText: 'one edited',
    });
    service.recordMessageBranch({
      sourceThreadId: 'b1',
      childThreadId: 'b2',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 't2b',
      editedTurnId: 't3b',
      inheritedTurnIds: ['t1', 't2b'],
      originalPreviewText: 'two',
      branchPreviewText: 'two edited',
    });
    service.recordMessageBranch({
      sourceThreadId: 'b2',
      childThreadId: 'b3',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 't3c',
      editedTurnId: 't4c',
      inheritedTurnIds: ['t1', 't2b', 't3c'],
      originalPreviewText: 'three',
      branchPreviewText: 'three edited',
    });

    const provenance = service.resolveProvenance('b3');
    expect(provenance.threadIds).toEqual(['root', 'b1', 'b2', 'b3']);
    expect([...provenance.inheritedTurnIds!].sort()).toEqual([
      't1',
      't2b',
      't3c',
    ]);
    // Turns each ancestor produced after being forked from stay out of scope.
    expect(provenance.inheritedTurnIds?.has('t2')).toBe(false);
    expect(provenance.inheritedTurnIds?.has('t3b')).toBe(false);
    expect(provenance.inheritedTurnIds?.has('t4c')).toBe(false);
  });

  it('reports untracked threads as unrestricted', () => {
    expect(service.resolveProvenance('lonely')).toEqual({
      threadIds: ['lonely'],
      inheritedTurnIds: null,
    });
    expect(service.readBranchState('lonely')).toMatchObject({
      tracked: false,
      hasKnownDescendants: false,
      knownTreeThreadIds: ['lonely'],
    });
  });

  it('tracks descendants for compaction and deletion guards', () => {
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'child-1',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'original text',
      branchPreviewText: 'edited text',
    });
    service.recordMessageBranch({
      sourceThreadId: 'child-1',
      childThreadId: 'child-2',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-1b',
      editedTurnId: 'turn-2b',
      inheritedTurnIds: ['turn-0', 'turn-1b'],
      originalPreviewText: 'downstream text',
      branchPreviewText: 'downstream edit',
    });

    expect(service.hasKnownDescendants('root')).toBe(true);
    expect(service.hasKnownDescendants('child-1')).toBe(true);
    expect(service.hasKnownDescendants('child-2')).toBe(false);
  });

  it('resequences surviving versions after a sibling is deleted', () => {
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'child-1',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'original text',
      branchPreviewText: 'edited text',
    });
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'child-2',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'unused',
      branchPreviewText: 'edited again',
    });

    mutations.reapDeletedThread('child-1', new Set(['child-1']));

    const versions = service
      .readBranchTree('root')
      .groups[0].versions.map((version) => ({
        threadId: version.threadId,
        versionIndex: version.versionIndex,
        kind: version.kind,
      }));
    expect(versions).toEqual([
      { threadId: 'root', versionIndex: 1, kind: 'original' },
      { threadId: 'child-2', versionIndex: 2, kind: 'branch' },
    ]);
  });

  it('dissolves a group when fewer than two versions survive', () => {
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'child-1',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'original text',
      branchPreviewText: 'edited text',
    });

    mutations.reapDeletedThread('child-1', new Set(['child-1']));

    expect(service.readBranchTree('root')).toMatchObject({
      tracked: false,
      members: [{ threadId: 'root', parentThreadId: null }],
      groups: [],
    });
  });

  it("holds the invariant that a group's original owns every other version", () => {
    // Two edits of the same message, the second made from inside the first
    // branch, which is the shape that puts versions on different depths.
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'v2',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'hello v1',
      branchPreviewText: 'hello v2',
    });
    service.recordMessageBranch({
      sourceThreadId: 'v2',
      childThreadId: 'v3',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'hello v2',
      branchPreviewText: 'hello v3',
    });

    const tree = service.readBranchTree('root');
    const group = tree.groups[0];
    const original = group.versions.find((v) => v.kind === 'original')!;
    const others = group.versions
      .filter((v) => v.versionId !== original.versionId)
      .map((v) => v.threadId);

    const parentOf = new Map(
      tree.members.map((m) => [m.threadId, m.parentThreadId]),
    );
    const descendsFromOriginal = (threadId: string): boolean => {
      let cursor = parentOf.get(threadId) ?? null;
      while (cursor) {
        if (cursor === original.threadId) return true;
        cursor = parentOf.get(cursor) ?? null;
      }
      return false;
    };

    // This is why the switcher must refuse to delete an `original`: the cascade
    // that deletes it necessarily takes the entire group with it.
    expect(others.length).toBeGreaterThan(0);
    for (const threadId of others) {
      expect(descendsFromOriginal(threadId)).toBe(true);
    }
  });

  it('tags each member with the group that created it, not the one it hosts', () => {
    // Edit the first message → branch B is version 2 of the outer group.
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'branch',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'hello v1',
      branchPreviewText: 'hello v2',
    });
    // Edit a later message *inside* B → B is also the original of a nested
    // group, holding a completely different preview.
    service.recordMessageBranch({
      sourceThreadId: 'branch',
      childThreadId: 'grandchild',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-5',
      editedTurnId: 'turn-6',
      inheritedTurnIds: ['turn-0', 'turn-5'],
      originalPreviewText: 'later v1',
      branchPreviewText: 'later v2',
    });

    const tree = service.readBranchTree('root');
    const byThread = new Map(tree.members.map((m) => [m.threadId, m]));

    // Without this key a client cannot tell which of B's two version rows
    // describes B itself, and labelling it by the wrong one makes the branch
    // look like it is named after an edit made inside it.
    expect(byThread.get('root')?.commonPrefixTurnId).toBeNull();
    expect(byThread.get('branch')?.commonPrefixTurnId).toBe('turn-0');
    expect(byThread.get('grandchild')?.commonPrefixTurnId).toBe('turn-5');
  });

  it('lists trees that only have fork edges and no version group', () => {
    // An ordinary fork, and any adopted fork whose boundary is unknown, records
    // an edge without a group. Enumerating roots from groups alone hid these
    // trees from every caller that discovers descendants through this list.
    sqlite
      .prepare(
        `INSERT INTO conversation_branch_edges
           (child_thread_id, parent_thread_id, tree_root_thread_id,
            fork_before_turn_id, common_prefix_turn_id, source,
            inherited_turn_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('child-1', 'root', 'root', 'turn-1', 'turn-0', 'local', '[]', 1);

    const trees = service.listBranchTrees();

    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({
      treeRootThreadId: 'root',
      members: [
        { threadId: 'root', parentThreadId: null },
        { threadId: 'child-1', parentThreadId: 'root' },
      ],
    });
  });

  it('refuses to reap a thread when local descendants would survive', () => {
    service.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'child-1',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-0',
      editedTurnId: 'turn-1',
      inheritedTurnIds: ['turn-0'],
      originalPreviewText: 'original text',
      branchPreviewText: 'edited text',
    });
    service.recordMessageBranch({
      sourceThreadId: 'child-1',
      childThreadId: 'child-2',
      treeRootThreadId: 'root',
      commonPrefixTurnId: 'turn-1b',
      editedTurnId: 'turn-2b',
      inheritedTurnIds: ['turn-0', 'turn-1b'],
      originalPreviewText: 'downstream text',
      branchPreviewText: 'downstream edit',
    });

    expect(() =>
      mutations.reapDeletedThread('child-1', new Set(['child-1'])),
    ).toThrow(OrphanedLocalTopologyError);
  });
});
