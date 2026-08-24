import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AppDatabase } from '../database/database.constants';
import * as schema from '../database/schema';
import { ConversationBranchesService } from './conversation-branches.service';

describe('ConversationBranchesService', () => {
  let sqlite: Database.Database;
  let service: ConversationBranchesService;

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
});
