/** Isolated filesystem fixtures shared by catalog behavior tests. */
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CatalogPathsService } from './catalog-paths.service';
import { CatalogStorageService } from './catalog-storage.service';

export const draftCatalog = JSON.stringify({
  models: [
    {
      slug: 'custom-model',
      visibility: 'list',
      base_instructions: 'Be useful.',
    },
  ],
});

/** Creates a disposable Codex home, never touching the developer's configuration or database. */
export function catalogFixture() {
  const home = mkdtempSync(join(tmpdir(), 'catalog-test-'));
  const paths = new CatalogPathsService(
    new ConfigService({
      CODEX_HOME: home,
      CODEX_BIN: resolve('node_modules/.bin/codex'),
    }),
  );
  const storage = new CatalogStorageService(paths);
  storage.ensureDirectory();
  return {
    home,
    paths,
    storage,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
