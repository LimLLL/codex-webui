import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './schema';

/** Nest provider token for the Drizzle SQLite database instance. */
export const DRIZZLE_DB = Symbol('DRIZZLE_DB');

/** App-wide Drizzle database type with the declared schema attached. */
export type AppDatabase = BetterSQLite3Database<typeof schema>;
