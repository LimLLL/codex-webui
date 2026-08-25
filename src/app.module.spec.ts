/**
 * Smoke test that the whole dependency graph resolves.
 *
 * Every other suite mocks its collaborators, so a provider that injects a token
 * its module never imports type-checks, passes unit tests, and only fails when
 * the process actually boots. Compiling AppModule here turns that into a test
 * failure instead of a startup crash.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

describe('AppModule', () => {
  // Compiling the real module constructs the real DatabaseService, which opens
  // and migrates whatever `WEBUI_DB_PATH` points at. Left unset it would run
  // migrations against the developer's own database.
  let dbDir: string;
  let previousDbPath: string | undefined;

  beforeAll(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'codex-webui-appmodule-'));
    previousDbPath = process.env.WEBUI_DB_PATH;
    process.env.WEBUI_DB_PATH = join(dbDir, 'test.sqlite');
  });

  afterAll(() => {
    if (previousDbPath === undefined) delete process.env.WEBUI_DB_PATH;
    else process.env.WEBUI_DB_PATH = previousDbPath;
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('resolves every provider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.close();
  });
});
