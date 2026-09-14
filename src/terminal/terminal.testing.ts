/** Terminal fixtures use the production migration chain and real filesystem directories. */
import { Test } from '@nestjs/testing';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTestDatabase,
  type TestDatabase,
} from '../database/database.testing';
import { DRIZZLE_DB } from '../database/database.constants';
import { FilesService } from '../files/files.service';
import {
  SettingsService,
  type SettingsChangeListener,
} from '../settings/settings.service';
import { TerminalService } from './terminal.service';
import { TerminalRegistryService } from './terminal-registry.service';

/** Builds the real service/registry pair; only settings and the workspace path service are substitutes. */
export async function terminalFixture(
  database: TestDatabase = createTestDatabase(),
) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'webui-terminal-')),
  );
  const values = {
    maxSessions: 10,
    graceMs: 30,
    scrollback: 100,
    defaultCwd: null as string | null,
  };
  const files = {
    resolveSafePath: (path: string) => Promise.resolve(realpathSync(path)),
    getHomeDir: () => directory,
  };
  let listener: SettingsChangeListener;
  const module = await Test.createTestingModule({
    providers: [
      TerminalService,
      TerminalRegistryService,
      { provide: DRIZZLE_DB, useValue: database.db },
      { provide: FilesService, useValue: files },
      {
        provide: SettingsService,
        useValue: {
          getNumberSetting: (key: string) =>
            values[key.slice(9) as 'maxSessions' | 'graceMs' | 'scrollback'],
          getStringSetting: () => values.defaultCwd,
          onChange: (callback: SettingsChangeListener) => {
            listener = callback;
            return () => undefined;
          },
        },
      },
    ],
  }).compile();
  return {
    database,
    directory,
    values,
    update: (changes: Partial<typeof values>) => {
      Object.assign(values, changes);
      listener({
        key: 'terminal.defaultCwd',
        value: values.defaultCwd ?? '',
        type: 'string',
        category: 'terminal',
        source: 'db',
        description: '',
        defaultValue: '',
        constraints: {},
        updatedAt: Date.now(),
      });
    },
    files,
    service: module.get(TerminalService),
    registry: module.get(TerminalRegistryService),
    dispose: async () => {
      await module.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
