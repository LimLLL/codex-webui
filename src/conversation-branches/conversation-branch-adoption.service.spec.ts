import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { AppDatabase } from '../database/database.constants';
import * as schema from '../database/schema';
import { ConversationBranchAdoptionService } from './conversation-branch-adoption.service';
import { ConversationBranchMutationsService } from './conversation-branch-mutations.service';
import { ConversationBranchesService } from './conversation-branches.service';

describe('ConversationBranchAdoptionService', () => {
  let sqlite: Database.Database;
  let branches: ConversationBranchesService;
  let scanner: ConversationBranchAdoptionService;
  let codexHome: string;

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
    const mutations = new ConversationBranchMutationsService(db);
    branches = new ConversationBranchesService(db);
    scanner = new ConversationBranchAdoptionService(
      {
        addLifecycleListener: jest.fn(),
        getInitResult: jest.fn().mockReturnValue(null),
        getGeneration: jest.fn().mockReturnValue(1),
      } as unknown as CodexProcessManager,
      mutations,
    );
    codexHome = mkdtempSync(join(tmpdir(), 'codex-webui-scan-'));
    mkdirSync(join(codexHome, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    sqlite.close();
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('adopts a paginated message fork as topology and a version group', async () => {
    const parentPrefix = writeSession(codexHome, 'root.jsonl', [
      meta('root'),
      turnContext('turn-1'),
      userItem('turn-1', 'one'),
    ]);
    appendSession(codexHome, 'root.jsonl', [
      turnContext('turn-2'),
      userItem('turn-2', 'two'),
    ]);
    writeSession(codexHome, 'child.jsonl', [
      meta('child', 'root', {
        thread_id: 'root',
        end_ordinal_exclusive: 3,
        end_byte_offset: Buffer.byteLength(parentPrefix),
      }),
      userItem('turn-2b', 'two edited'),
    ]);

    const status = await scanner.scanCodexHome(codexHome, 1);

    expect(status).toMatchObject({
      status: 'ready',
      adoptedEdges: 1,
      adoptedVersions: 2,
      conflicts: 0,
    });
    const tree = branches.readBranchTree('child');
    expect(tree.members).toMatchObject([
      { threadId: 'root', parentThreadId: null, source: 'local' },
      { threadId: 'child', parentThreadId: 'root', source: 'adopted' },
    ]);
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0].commonPrefixTurnId).toBe('turn-1');
    expect(tree.groups[0].versions).toMatchObject([
      {
        threadId: 'root',
        versionIndex: 1,
        kind: 'original',
        source: 'adopted',
        messageTurnId: 'turn-2',
        previewText: 'two',
      },
      {
        threadId: 'child',
        versionIndex: 2,
        kind: 'branch',
        source: 'adopted',
        messageTurnId: 'turn-2b',
        previewText: 'two edited',
      },
    ]);
  });

  it('adopts a fork that never sent a message as topology, not a version', async () => {
    // Reproduces a real leftover: probe forks land on disk having replaced a
    // user message boundary but carrying no message of their own. Presenting
    // them as versions puts a phantom entry in the user's `< n/m >` switcher
    // claiming an edit nobody made.
    const parentPrefix = writeSession(codexHome, 'root.jsonl', [
      meta('root'),
      turnContext('turn-1'),
      userItem('turn-1', 'one'),
    ]);
    appendSession(codexHome, 'root.jsonl', [
      turnContext('turn-2'),
      userItem('turn-2', 'two'),
    ]);
    writeSession(codexHome, 'child.jsonl', [
      meta('child', 'root', {
        thread_id: 'root',
        end_ordinal_exclusive: 3,
        end_byte_offset: Buffer.byteLength(parentPrefix),
      }),
    ]);

    const status = await scanner.scanCodexHome(codexHome, 1);

    expect(status).toMatchObject({
      status: 'ready',
      adoptedEdges: 1,
      adoptedVersions: 0,
      topologyOnlyEdges: 1,
      conflicts: 0,
    });
    const tree = branches.readBranchTree('child');
    expect(tree.members).toMatchObject([
      { threadId: 'root', parentThreadId: null },
      { threadId: 'child', parentThreadId: 'root', source: 'adopted' },
    ]);
    expect(tree.groups).toHaveLength(0);
  });

  it('reconstructs a re-edit group without depending on file scan order', async () => {
    const parentPrefix = writeSession(codexHome, 'root.jsonl', [
      meta('root'),
      turnContext('turn-1'),
      userItem('turn-1', 'one'),
    ]);
    appendSession(codexHome, 'root.jsonl', [
      turnContext('turn-2'),
      userItem('turn-2', 'two'),
    ]);
    const childMeta = meta('child-1', 'root', {
      thread_id: 'root',
      end_ordinal_exclusive: 3,
      end_byte_offset: Buffer.byteLength(parentPrefix),
    });
    writeSession(codexHome, 'z-child-1.jsonl', [
      childMeta,
      turnContext('turn-2b'),
      userItem('turn-2b', 'two edited'),
    ]);
    writeSession(codexHome, 'a-child-2.jsonl', [
      meta('child-2', 'child-1', {
        thread_id: 'child-1',
        end_ordinal_exclusive: 1,
        end_byte_offset: Buffer.byteLength(serialize([childMeta])),
      }),
      userItem('turn-2c', 'two edited again'),
    ]);

    const status = await scanner.scanCodexHome(codexHome, 1);

    expect(status).toMatchObject({
      adoptedEdges: 2,
      adoptedVersions: 3,
      conflicts: 0,
    });
    expect(
      branches.readBranchTree('child-2').groups[0].versions.map((version) => ({
        threadId: version.threadId,
        versionIndex: version.versionIndex,
        kind: version.kind,
      })),
    ).toEqual([
      { threadId: 'root', versionIndex: 1, kind: 'original' },
      { threadId: 'child-1', versionIndex: 2, kind: 'branch' },
      { threadId: 'child-2', versionIndex: 3, kind: 'branch' },
    ]);
  });

  it('adopts a plain fork as topology only when there is no message boundary', async () => {
    const parentContent = writeSession(codexHome, 'root.jsonl', [
      meta('root'),
      turnContext('turn-1'),
      userItem('turn-1', 'one'),
    ]);
    writeSession(codexHome, 'child.jsonl', [
      meta('child', 'root', {
        thread_id: 'root',
        end_ordinal_exclusive: 3,
        end_byte_offset: Buffer.byteLength(parentContent),
      }),
    ]);

    const status = await scanner.scanCodexHome(codexHome, 1);

    expect(status).toMatchObject({
      adoptedEdges: 1,
      adoptedVersions: 0,
      topologyOnlyEdges: 1,
    });
    const tree = branches.readBranchTree('root');
    expect(tree.groups).toEqual([]);
    expect(tree.members).toMatchObject([
      { threadId: 'root', parentThreadId: null },
      { threadId: 'child', parentThreadId: 'root', source: 'adopted' },
    ]);
  });

  it('keeps local topology and reports a conflict when disk disagrees', async () => {
    branches.recordMessageBranch({
      sourceThreadId: 'root',
      childThreadId: 'child',
      treeRootThreadId: 'root',
      commonPrefixTurnId: null,
      editedTurnId: 'local-turn',
      inheritedTurnIds: [],
      originalPreviewText: 'local original',
      branchPreviewText: 'local edit',
    });
    const parentPrefix = writeSession(codexHome, 'root.jsonl', [
      meta('root'),
      turnContext('turn-1'),
      userItem('turn-1', 'one'),
    ]);
    appendSession(codexHome, 'root.jsonl', [
      turnContext('turn-2'),
      userItem('turn-2', 'two'),
    ]);
    writeSession(codexHome, 'child.jsonl', [
      meta('child', 'root', {
        thread_id: 'root',
        end_ordinal_exclusive: 3,
        end_byte_offset: Buffer.byteLength(parentPrefix),
      }),
      userItem('turn-2b', 'two edited'),
    ]);

    const status = await scanner.scanCodexHome(codexHome, 1);

    expect(status.conflicts).toBe(1);
    expect(status.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'local_edge_conflict',
        threadId: 'child',
      }),
    );
    expect(branches.readBranchTree('root').members).toMatchObject([
      { threadId: 'root', parentThreadId: null, source: 'local' },
      { threadId: 'child', parentThreadId: 'root', source: 'local' },
    ]);
  });
});

function meta(
  id: string,
  forkedFromId: string | null = null,
  historyBase?: Record<string, unknown>,
) {
  return {
    type: 'session_meta',
    payload: {
      id,
      forked_from_id: forkedFromId,
      ...(historyBase ? { history_base: historyBase } : {}),
    },
  };
}

function turnContext(turnId: string) {
  return { type: 'turn_context', payload: { turn_id: turnId } };
}

function userItem(turnId: string, text: string) {
  return {
    type: 'response_item',
    payload: {
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
      item: {
        type: 'userMessage',
        content: [{ type: 'text', text }],
      },
    },
  };
}

function writeSession(
  codexHome: string,
  fileName: string,
  records: Record<string, unknown>[],
): string {
  const content = serialize(records);
  writeFileSync(join(codexHome, 'sessions', fileName), content);
  return content;
}

function appendSession(
  codexHome: string,
  fileName: string,
  records: Record<string, unknown>[],
): string {
  const content = serialize(records);
  writeFileSync(join(codexHome, 'sessions', fileName), content, { flag: 'a' });
  return content;
}

function serialize(records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}
