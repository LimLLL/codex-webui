/**
 * Runtime settings service with SQLite persistence, validation, and cache.
 *
 * Reads follow the priority chain: DB override → env fallback → hardcoded default.
 * On startup, code-owned definitions are reconciled into the DB: missing keys are
 * inserted, changed metadata/constraints/defaults are updated, but user-set values
 * are never overwritten.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { settings, type SettingRow } from '../database/schema';
import {
  SETTINGS_DEFINITION_BY_KEY,
  SETTINGS_DEFINITIONS,
  SETTING_CATEGORIES,
  type JsonValue,
  type SettingCategory,
  type SettingConstraints,
  type SettingDefinition,
  type SettingType,
  type SettingValue,
} from './settings.definitions';

export type SettingSource = 'db' | 'env' | 'default';

export interface ResolvedSetting {
  key: string;
  value: SettingValue;
  source: SettingSource;
  type: SettingType;
  category: SettingCategory;
  description: string;
  defaultValue: SettingValue;
  constraints: SettingConstraints;
  updatedAt: number;
}

export type SettingChangedEvent = ResolvedSetting;
export type SettingsChangeListener = (event: SettingChangedEvent) => void;

interface PreparedUpdate {
  definition: SettingDefinition;
  encodedValue: string | null;
}

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private readonly cache = new Map<string, SettingRow>();
  private readonly listeners = new Set<SettingsChangeListener>();
  private initialized = false;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    this.initialize();
  }

  /** Lists settings in definition order, optionally filtered by category. */
  listSettings(category?: string): ResolvedSetting[] {
    this.ensureInitialized();
    const normalizedCategory = this.normalizeCategory(category);
    return SETTINGS_DEFINITIONS.filter(
      (d) => !normalizedCategory || d.category === normalizedCategory,
    ).map((d) => this.resolveDefinition(d));
  }

  /** Reads one setting by key using DB > env > default priority. */
  getSetting(key: string): ResolvedSetting {
    this.ensureInitialized();
    return this.resolveDefinition(this.getDefinitionOrThrow(key));
  }

  /** Reads a numeric setting; throws if the definition is not numeric. */
  getNumberSetting(key: string): number {
    const s = this.getSetting(key);
    if (typeof s.value !== 'number') {
      throw new Error(`Runtime setting ${key} is not numeric`);
    }
    return s.value;
  }

  /** Reads a string setting; returns empty string as null for convenience. */
  getStringSetting(key: string): string | null {
    const s = this.getSetting(key);
    if (typeof s.value !== 'string') return null;
    return s.value || null;
  }

  /** Updates one setting; a null value clears the DB override. */
  updateSetting(key: string, value: unknown): ResolvedSetting {
    this.ensureInitialized();
    const prepared = this.prepareUpdate(key, value);
    this.persistUpdates([prepared]);
    const resolved = this.resolveDefinition(prepared.definition);
    this.emitChange(resolved);
    return resolved;
  }

  /** Clears a setting override so reads fall back to env/default. */
  resetSetting(key: string): ResolvedSetting {
    return this.updateSetting(key, null);
  }

  /** Atomically updates multiple settings after validating every entry. */
  updateSettings(
    updates: readonly { key: string; value: unknown }[],
  ): ResolvedSetting[] {
    this.ensureInitialized();
    if (!Array.isArray(updates)) {
      throw new BadRequestException('updates must be an array');
    }

    const seen = new Set<string>();
    const prepared = updates.map((entry: { key: string; value: unknown }) => {
      if (!entry || typeof entry.key !== 'string') {
        throw new BadRequestException('Each update requires a setting key');
      }
      if (seen.has(entry.key)) {
        throw new BadRequestException(`Duplicate setting key: ${entry.key}`);
      }
      seen.add(entry.key);
      return this.prepareUpdate(entry.key, entry.value);
    });

    this.persistUpdates(prepared);
    const resolved = prepared.map((p) => this.resolveDefinition(p.definition));
    for (const s of resolved) this.emitChange(s);
    return resolved;
  }

  /** Registers an in-process listener for setting changes. */
  onChange(listener: SettingsChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Initialization ──────────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.initialized) this.initialize();
  }

  /**
   * Reconciles code-owned definitions into SQLite.
   *
   * - INSERT rows for newly added settings (value = null → env/default fallback).
   * - UPDATE metadata/constraints/defaults when they change in code.
   * - Never overwrite user-set `value`.
   */
  private initialize(): void {
    if (this.initialized) return;

    const existingRows = this.db.select().from(settings).all();
    const existingByKey = new Map(existingRows.map((r) => [r.key, r]));
    const now = Date.now();

    this.db.transaction((tx) => {
      for (const def of SETTINGS_DEFINITIONS) {
        const meta = this.toMetadataRow(def, now);
        const existing = existingByKey.get(def.key);

        if (!existing) {
          tx.insert(settings)
            .values({ ...meta, key: def.key, value: null })
            .run();
          continue;
        }

        if (this.hasMetadataChanged(existing, meta)) {
          tx.update(settings).set(meta).where(eq(settings.key, def.key)).run();
        }
      }
    });

    this.reloadCache();
    this.initialized = true;
    this.logger.log(
      `Reconciled ${SETTINGS_DEFINITIONS.length} setting definitions`,
    );
  }

  // ── Cache ───────────────────────────────────────────────────────────

  private reloadCache(): void {
    this.cache.clear();
    for (const row of this.db.select().from(settings).all()) {
      this.cache.set(row.key, row);
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private persistUpdates(updates: readonly PreparedUpdate[]): void {
    if (updates.length === 0) return;
    const now = Date.now();

    this.db.transaction((tx) => {
      for (const u of updates) {
        tx.update(settings)
          .set({ value: u.encodedValue, updatedAt: now })
          .where(eq(settings.key, u.definition.key))
          .run();
      }
    });

    this.reloadCache();
  }

  private prepareUpdate(key: string, value: unknown): PreparedUpdate {
    const definition = this.getDefinitionOrThrow(key);
    if (value === null) return { definition, encodedValue: null };
    const normalized = this.validateValue(definition, value);
    return { definition, encodedValue: this.encodeJson(normalized) };
  }

  // ── Resolution chain ────────────────────────────────────────────────

  private resolveDefinition(definition: SettingDefinition): ResolvedSetting {
    const row = this.cache.get(definition.key);
    if (!row) {
      throw new NotFoundException(
        `Runtime setting not found: ${definition.key}`,
      );
    }

    const storedValue = this.decodeStoredValue(row, definition);
    if (storedValue !== null) {
      return this.toResolved(definition, row, storedValue, 'db');
    }

    const envValue = this.readEnvValue(definition);
    if (envValue !== null) {
      return this.toResolved(definition, row, envValue, 'env');
    }

    return this.toResolved(definition, row, definition.defaultValue, 'default');
  }

  private decodeStoredValue(
    row: SettingRow,
    definition: SettingDefinition,
  ): SettingValue | null {
    if (row.value === null) return null;
    try {
      return this.validateValue(definition, JSON.parse(row.value) as unknown);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Ignoring invalid stored setting ${definition.key}: ${msg}`,
      );
      return null;
    }
  }

  private readEnvValue(definition: SettingDefinition): SettingValue | null {
    if (!definition.envKey) return null;
    const raw =
      this.configService.get<string>(definition.envKey) ??
      process.env[definition.envKey];
    const trimmed = raw?.trim();
    if (!trimmed) return null;

    try {
      return this.parseEnvValue(definition, trimmed);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Ignoring invalid env value for ${definition.envKey}: ${msg}`,
      );
      return null;
    }
  }

  /** Parses env string with silent clamping (matches legacy terminal env behavior). */
  private parseEnvValue(
    definition: SettingDefinition,
    raw: string,
  ): SettingValue {
    if (definition.type === 'number') {
      const parsed = definition.constraints?.integer
        ? Number.parseInt(raw, 10)
        : Number(raw);
      if (!Number.isFinite(parsed)) {
        throw new Error('value must be a finite number');
      }
      return this.clampNumber(parsed, definition.constraints);
    }

    if (definition.type === 'boolean') {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      throw new Error('value must be a boolean');
    }

    if (definition.type === 'json') {
      return this.validateValue(definition, JSON.parse(raw) as unknown);
    }

    return this.validateValue(definition, raw);
  }

  // ── Validation (strict — rejects out-of-range, no silent clamp) ─────

  private validateValue(
    definition: SettingDefinition,
    value: unknown,
  ): SettingValue {
    let normalized: SettingValue;

    if (definition.type === 'string') {
      if (typeof value !== 'string') {
        throw new BadRequestException(`${definition.key} must be a string`);
      }
      normalized = value;
    } else if (definition.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new BadRequestException(`${definition.key} must be a number`);
      }
      if (definition.constraints?.integer && !Number.isInteger(value)) {
        throw new BadRequestException(`${definition.key} must be an integer`);
      }
      if (
        definition.constraints?.min !== undefined &&
        value < definition.constraints.min
      ) {
        throw new BadRequestException(
          `${definition.key} must be >= ${definition.constraints.min}`,
        );
      }
      if (
        definition.constraints?.max !== undefined &&
        value > definition.constraints.max
      ) {
        throw new BadRequestException(
          `${definition.key} must be <= ${definition.constraints.max}`,
        );
      }
      normalized = value;
    } else if (definition.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new BadRequestException(`${definition.key} must be a boolean`);
      }
      normalized = value;
    } else {
      if (!this.isJsonValue(value) || value === null) {
        throw new BadRequestException(`${definition.key} must be JSON`);
      }
      normalized = value;
    }

    if (
      definition.constraints?.enum &&
      !definition.constraints.enum.some((c) =>
        this.sameJsonValue(c, normalized),
      )
    ) {
      throw new BadRequestException(
        `${definition.key} is not an allowed value`,
      );
    }

    return normalized;
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private clampNumber(
    value: number,
    constraints: SettingConstraints | undefined,
  ): number {
    let next = constraints?.integer ? Math.trunc(value) : value;
    if (constraints?.min !== undefined) next = Math.max(constraints.min, next);
    if (constraints?.max !== undefined) next = Math.min(constraints.max, next);
    return next;
  }

  private isJsonValue(value: unknown): value is JsonValue {
    if (value === null) return true;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      return t !== 'number' || Number.isFinite(value);
    }
    if (Array.isArray(value)) {
      return value.every((item) => this.isJsonValue(item));
    }
    if (t === 'object') {
      return Object.values(value as Record<string, unknown>).every((v) =>
        this.isJsonValue(v),
      );
    }
    return false;
  }

  private sameJsonValue(left: SettingValue, right: SettingValue): boolean {
    return this.encodeJson(left) === this.encodeJson(right);
  }

  private getDefinitionOrThrow(key: string): SettingDefinition {
    const def = SETTINGS_DEFINITION_BY_KEY.get(key);
    if (!def) {
      throw new NotFoundException(`Runtime setting not found: ${key}`);
    }
    return def;
  }

  private normalizeCategory(
    category: string | undefined,
  ): SettingCategory | null {
    if (!category) return null;
    if ((SETTING_CATEGORIES as readonly string[]).includes(category)) {
      return category as SettingCategory;
    }
    throw new BadRequestException(`Invalid settings category: ${category}`);
  }

  private toMetadataRow(
    def: SettingDefinition,
    updatedAt: number,
  ): Omit<typeof settings.$inferInsert, 'key' | 'value'> {
    return {
      type: def.type,
      category: def.category,
      description: def.description,
      defaultValue: this.encodeJson(def.defaultValue),
      constraints: this.encodeJson(def.constraints ?? {}),
      updatedAt,
    };
  }

  private hasMetadataChanged(
    row: SettingRow,
    meta: Omit<typeof settings.$inferInsert, 'key' | 'value'>,
  ): boolean {
    return (
      row.type !== meta.type ||
      row.category !== meta.category ||
      row.description !== meta.description ||
      row.defaultValue !== meta.defaultValue ||
      row.constraints !== meta.constraints
    );
  }

  private toResolved(
    def: SettingDefinition,
    row: SettingRow,
    value: SettingValue,
    source: SettingSource,
  ): ResolvedSetting {
    return {
      key: def.key,
      value: structuredClone(value),
      source,
      type: def.type,
      category: def.category,
      description: def.description,
      defaultValue: structuredClone(def.defaultValue),
      constraints: { ...def.constraints },
      updatedAt: row.updatedAt,
    };
  }

  private encodeJson(value: JsonValue | SettingConstraints): string {
    return JSON.stringify(value);
  }

  private emitChange(setting: ResolvedSetting): void {
    for (const listener of this.listeners) {
      try {
        listener(setting);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Runtime setting listener failed for ${setting.key}: ${msg}`,
        );
      }
    }
  }
}
