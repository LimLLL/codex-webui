import { defineConfig } from 'drizzle-kit';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function resolveDatabaseUrl(): string {
  const explicit = process.env.WEBUI_DB_PATH?.trim();
  if (explicit) return explicit;
  const codexHome = process.env.CODEX_HOME?.trim();
  return join(codexHome || join(homedir(), '.codex'), 'codex-webui.sqlite');
}

const dbPath = resolveDatabaseUrl();
mkdirSync(dirname(dbPath), { recursive: true });

export default defineConfig({
  schema: './src/database/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: dbPath,
  },
});
