/** Exercises the real generated migrations on populated pre-instance request history. */
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('preserves legacy rows and permits distinct instances with the same restarted wire identity', () => {
  const sqlite = new Database(':memory:');
  try {
    const migrations = readMigrationFiles({ migrationsFolder: 'drizzle' });
    for (const migration of migrations.slice(0, 10))
      for (const sql of migration.sql) sqlite.exec(sql);
    const legacy = sqlite.prepare(
      "INSERT INTO pending_server_requests (generation, request_id, thread_id, method, params_json, status, created_at, updated_at) VALUES (?, ?, 'old', 'item/fileChange/requestApproval', '{}', 'pending', 1, 1)",
    );
    legacy.run(1, '0');
    legacy.run(1, '1');
    for (const migration of migrations.slice(10))
      for (const sql of migration.sql) sqlite.exec(sql);
    expect(
      sqlite
        .prepare('SELECT instance_id, thread_id FROM pending_server_requests')
        .all(),
    ).toEqual([
      { instance_id: null, thread_id: 'old' },
      { instance_id: null, thread_id: 'old' },
    ]);
    const insert = sqlite.prepare(
      "INSERT INTO pending_server_requests (instance_id, generation, request_id, thread_id, method, params_json, status, created_at, updated_at) VALUES (?, 1, '0', 'new', 'item/fileChange/requestApproval', '{}', 'pending', 1, 1)",
    );
    insert.run('first-instance');
    insert.run('second-instance');
    expect(() => insert.run('first-instance')).toThrow(/UNIQUE/);
    expect(
      sqlite
        .prepare('SELECT count(*) AS total FROM pending_server_requests')
        .get(),
    ).toEqual({ total: 4 });
  } finally {
    sqlite.close();
  }
});

it('serializes competing writers and enforces non-null identity uniqueness while preserving legacy nulls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pending-instance-race-'));
  const path = join(directory, 'requests.sqlite');
  const first = new Database(path);
  const second = new Database(path, { timeout: 0 });
  try {
    first.pragma('journal_mode = WAL');
    for (const migration of readMigrationFiles({ migrationsFolder: 'drizzle' }))
      for (const sql of migration.sql) first.exec(sql);
    const sql =
      "INSERT INTO pending_server_requests (instance_id, generation, request_id, thread_id, method, params_json, status, created_at, updated_at) VALUES (?, 1, '0', 't', 'item/fileChange/requestApproval', '{}', 'pending', 1, 1)";
    const insertFirst = first.prepare(sql);
    const insertSecond = second.prepare(sql);
    first.exec('BEGIN IMMEDIATE');
    insertFirst.run('same-instance');
    // A second connection cannot write past an uncommitted competing insert.
    expect(() => insertSecond.run('same-instance')).toThrow(/locked/);
    first.exec('COMMIT');
    expect(() => insertSecond.run('same-instance')).toThrow(/UNIQUE/);
    insertSecond.run('different-instance');
    insertFirst.run(null);
    insertSecond.run(null);
    expect(
      second
        .prepare(
          'SELECT instance_id FROM pending_server_requests ORDER BY instance_id',
        )
        .all(),
    ).toEqual([
      { instance_id: null },
      { instance_id: null },
      { instance_id: 'different-instance' },
      { instance_id: 'same-instance' },
    ]);
  } finally {
    second.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
