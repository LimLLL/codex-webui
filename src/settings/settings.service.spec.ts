/** Unit tests for SettingsService: seed, reconcile, DB/env/default chain. */
import { ConfigService } from '@nestjs/config';
import { BusinessException } from '../common/business.exception';
import { createTestDatabase } from '../database/database.testing';
import { TERMINAL_SETTING_KEYS } from './settings.definitions';
import { SettingsService } from './settings.service';

function createService(env: Record<string, string | undefined> = {}) {
  const { db, sqlite } = createTestDatabase();
  const config = {
    get: vi.fn((key: string) => env[key]),
  } as unknown as ConfigService;
  const service = new SettingsService(db, config);
  return { service, sqlite };
}

describe('SettingsService', () => {
  it('seeds definitions with default source when DB is empty', () => {
    const { service, sqlite } = createService();
    try {
      const all = service.listSettings('terminal');
      expect(all).toHaveLength(4);
      expect(all[0]).toMatchObject({
        key: TERMINAL_SETTING_KEYS.maxSessions,
        source: 'default',
        value: 10,
      });
      expect(all[1]).toMatchObject({
        key: TERMINAL_SETTING_KEYS.graceMs,
        source: 'default',
        value: 45_000,
      });
      expect(all[2]).toMatchObject({
        key: TERMINAL_SETTING_KEYS.scrollback,
        source: 'default',
        value: 5_000,
      });
    } finally {
      sqlite.close();
    }
  });

  it('falls back to env with clamping for out-of-range values', () => {
    const { service, sqlite } = createService({
      WEBUI_TERMINAL_MAX_SESSIONS: '75',
    });
    try {
      const s = service.getSetting(TERMINAL_SETTING_KEYS.maxSessions);
      expect(s.source).toBe('env');
      expect(s.value).toBe(50); // clamped to max
    } finally {
      sqlite.close();
    }
  });

  it('validates DB overrides and supports reset to fallback', () => {
    const { service, sqlite } = createService({
      WEBUI_TERMINAL_MAX_SESSIONS: '12',
    });
    try {
      // Out-of-range → 400
      expect(() =>
        service.updateSetting(TERMINAL_SETTING_KEYS.maxSessions, 0),
      ).toThrow(BusinessException);

      // Non-integer → 400
      expect(() =>
        service.updateSetting(TERMINAL_SETTING_KEYS.maxSessions, 3.5),
      ).toThrow(BusinessException);

      // Valid override → source 'db'
      const updated = service.updateSetting(
        TERMINAL_SETTING_KEYS.maxSessions,
        8,
      );
      expect(updated).toMatchObject({ source: 'db', value: 8 });

      // Reset → falls back to env
      const reset = service.resetSetting(TERMINAL_SETTING_KEYS.maxSessions);
      expect(reset).toMatchObject({ source: 'env', value: 12 });
    } finally {
      sqlite.close();
    }
  });

  it('reconciles changed metadata while preserving user values', () => {
    const { service, sqlite } = createService();
    try {
      // Pre-insert a row with outdated metadata but valid user value
      sqlite
        .prepare(
          `INSERT INTO settings (key, value, type, category, description, default_value, constraints, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          TERMINAL_SETTING_KEYS.maxSessions,
          '7',
          'number',
          'terminal',
          'old description',
          '1',
          '{}',
          1,
        );

      // Service initialization should reconcile metadata but keep value=7
      const s = service.getSetting(TERMINAL_SETTING_KEYS.maxSessions);
      expect(s.source).toBe('db');
      expect(s.value).toBe(7);
      expect(s.description).toContain('Maximum concurrent');
      expect(s.defaultValue).toBe(10);
    } finally {
      sqlite.close();
    }
  });

  it('fires change listeners on update', () => {
    const { service, sqlite } = createService();
    try {
      const events: string[] = [];
      const unsub = service.onChange((e) => events.push(e.key));

      service.updateSetting(TERMINAL_SETTING_KEYS.scrollback, 1000);
      expect(events).toEqual([TERMINAL_SETTING_KEYS.scrollback]);

      unsub();
      service.updateSetting(TERMINAL_SETTING_KEYS.scrollback, 2000);
      expect(events).toHaveLength(1); // no new event after unsub
    } finally {
      sqlite.close();
    }
  });

  it('batch update rejects entirely on any invalid entry', () => {
    const { service, sqlite } = createService();
    try {
      expect(() =>
        service.updateSettings([
          { key: TERMINAL_SETTING_KEYS.scrollback, value: 500 },
          { key: TERMINAL_SETTING_KEYS.maxSessions, value: -1 }, // invalid
        ]),
      ).toThrow(BusinessException);

      // scrollback should still be default (batch was atomic)
      const s = service.getSetting(TERMINAL_SETTING_KEYS.scrollback);
      expect(s.source).toBe('default');
    } finally {
      sqlite.close();
    }
  });

  it('throws BusinessException for unknown setting key', () => {
    const { service, sqlite } = createService();
    try {
      expect(() => service.getSetting('nonexistent.key')).toThrow(
        BusinessException,
      );
    } finally {
      sqlite.close();
    }
  });

  it('getNumberSetting returns numeric value', () => {
    const { service, sqlite } = createService();
    try {
      const val = service.getNumberSetting(TERMINAL_SETTING_KEYS.graceMs);
      expect(val).toBe(45_000);
    } finally {
      sqlite.close();
    }
  });
});
