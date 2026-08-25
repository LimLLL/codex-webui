/**
 * Test-only in-memory database built from the real drizzle-kit migrations.
 *
 * Specs used to hand-copy `CREATE TABLE` statements, which drift silently: adding
 * a column to `schema.ts` and generating a migration left those copies behind, so
 * the suite kept passing against a shape production no longer had. Running the
 * actual migration chain makes schema drift a test failure and covers the chain
 * itself as a side effect.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import type { AppDatabase } from './database.constants';
import * as schema from './schema';

export interface TestDatabase {
  /** Drizzle client, typed exactly as the one services receive in production. */
  db: AppDatabase;
  /** Underlying connection, for raw assertions and teardown. */
  sqlite: Database.Database;
}

/**
 * Creates an in-memory SQLite database with every pending migration applied.
 *
 * Mirrors the pragmas `DatabaseService` sets, minus WAL, which has no meaning for
 * an in-memory database.
 *
 * @returns The drizzle client and its underlying connection
 */
export function createTestDatabase(): TestDatabase {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema }) as AppDatabase;
  migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') });
  return { db, sqlite };
}
