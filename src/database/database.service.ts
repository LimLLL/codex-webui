/** Owns the SQLite connection, Drizzle instance, and drizzle-kit migrations. */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as schema from './schema';
import type { AppDatabase } from './database.constants';

const DEFAULT_DB_FILENAME = 'codex-webui.sqlite';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly sqlite: Database.Database;
  readonly db: AppDatabase;

  constructor(private readonly config: ConfigService) {
    const dbPath = this.resolveDatabasePath();
    mkdirSync(dirname(dbPath), { recursive: true });

    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this.db = drizzle(this.sqlite, { schema });

    this.runMigrations();
    this.logger.log(`SQLite database ready at ${dbPath}`);
  }

  onModuleDestroy(): void {
    this.sqlite.close();
  }

  private resolveDatabasePath(): string {
    const explicitPath = this.config.get<string>('WEBUI_DB_PATH')?.trim();
    if (explicitPath) return explicitPath;

    const codexHome = this.config.get<string>('CODEX_HOME')?.trim();
    const baseDir = codexHome || join(homedir(), '.codex');
    return join(baseDir, DEFAULT_DB_FILENAME);
  }

  /** Applies pending drizzle-kit migrations at application startup. */
  private runMigrations(): void {
    migrate(this.db, {
      migrationsFolder: join(process.cwd(), 'drizzle'),
    });
  }
}
