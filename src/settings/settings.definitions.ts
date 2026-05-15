/** Code-owned runtime setting definitions and shared types. */

export const SETTING_TYPES = ['string', 'number', 'boolean', 'json'] as const;
export const SETTING_CATEGORIES = [
  'terminal',
  'files',
  'security',
  'general',
] as const;

export type SettingType = (typeof SETTING_TYPES)[number];
export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SettingValue = Exclude<JsonValue, null>;

export interface SettingConstraints {
  readonly min?: number;
  readonly max?: number;
  readonly enum?: readonly SettingValue[];
  /** Marks number settings that must be integral. */
  readonly integer?: boolean;
}

export interface SettingDefinition<TValue extends SettingValue = SettingValue> {
  readonly key: string;
  readonly type: SettingType;
  readonly category: SettingCategory;
  readonly description: string;
  readonly defaultValue: TValue;
  readonly constraints?: SettingConstraints;
  /** Env var key used as fallback when no DB override exists. */
  readonly envKey?: string;
}

export const TERMINAL_SETTING_KEYS = {
  maxSessions: 'terminal.maxSessions',
  graceMs: 'terminal.graceMs',
  scrollback: 'terminal.scrollback',
  defaultCwd: 'terminal.defaultCwd',
} as const;

export const FILES_SETTING_KEYS = {
  uploadMaxBytes: 'files.uploadMaxBytes',
} as const;

export const SECURITY_SETTING_KEYS = {
  workspaceRoots: 'security.workspaceRoots',
} as const;

export const TERMINAL_SETTING_DEFAULTS = {
  maxSessions: 10,
  graceMs: 45_000,
  scrollback: 5_000,
} as const;

const DEFAULT_UPLOAD_MAX_BYTES = 104_857_600; // 100 MB

/**
 * Authoritative list of all runtime settings.
 *
 * To add a new setting, append an entry here. The startup reconcile will
 * automatically INSERT the row (without overwriting existing user values)
 * and UPDATE metadata/constraints/defaults if they change.
 */
export const SETTINGS_DEFINITIONS = [
  {
    key: TERMINAL_SETTING_KEYS.maxSessions,
    type: 'number',
    category: 'terminal',
    description: 'Maximum concurrent terminal sessions retained by the server.',
    defaultValue: TERMINAL_SETTING_DEFAULTS.maxSessions,
    envKey: 'WEBUI_TERMINAL_MAX_SESSIONS',
    constraints: { min: 1, max: 50, integer: true },
  },
  {
    key: TERMINAL_SETTING_KEYS.graceMs,
    type: 'number',
    category: 'terminal',
    description:
      'Milliseconds to keep a detached terminal alive before cleanup.',
    defaultValue: TERMINAL_SETTING_DEFAULTS.graceMs,
    envKey: 'WEBUI_TERMINAL_GRACE_MS',
    constraints: { min: 10_000, max: 300_000, integer: true },
  },
  {
    key: TERMINAL_SETTING_KEYS.scrollback,
    type: 'number',
    category: 'terminal',
    description: 'Scrollback lines retained by new terminal buffers.',
    defaultValue: TERMINAL_SETTING_DEFAULTS.scrollback,
    envKey: 'WEBUI_TERMINAL_SCROLLBACK',
    constraints: { min: 100, max: 50_000, integer: true },
  },
  {
    key: TERMINAL_SETTING_KEYS.defaultCwd,
    type: 'string',
    category: 'terminal',
    description:
      'Default working directory for new terminals. Must be an existing directory within workspace roots. Empty to use thread cwd or home.',
    defaultValue: '',
    envKey: 'DEFAULT_TERMINAL_CWD',
  },
  {
    key: FILES_SETTING_KEYS.uploadMaxBytes,
    type: 'number',
    category: 'files',
    description: 'Maximum file upload size in bytes.',
    defaultValue: DEFAULT_UPLOAD_MAX_BYTES,
    envKey: 'WEBUI_UPLOAD_MAX_BYTES',
    constraints: { min: 1, max: 10_737_418_240, integer: true },
  },
  {
    key: SECURITY_SETTING_KEYS.workspaceRoots,
    type: 'string',
    category: 'security',
    description:
      'Comma-separated list of allowed workspace root directories. Home directory is always included.',
    defaultValue: '',
    envKey: 'WORKSPACE_ROOTS',
  },
] as const satisfies readonly SettingDefinition[];

export const SETTINGS_DEFINITION_BY_KEY = new Map<string, SettingDefinition>(
  SETTINGS_DEFINITIONS.map((d): [string, SettingDefinition] => [d.key, d]),
);

const TERMINAL_SETTING_KEY_SET = new Set<string>(
  Object.values(TERMINAL_SETTING_KEYS),
);

/** Returns true when a changed setting affects terminal runtime config. */
export function isTerminalSettingKey(key: string): boolean {
  return TERMINAL_SETTING_KEY_SET.has(key);
}

/** Returns true when a changed setting affects file service config. */
export function isFilesSettingKey(key: string): boolean {
  return key === FILES_SETTING_KEYS.uploadMaxBytes;
}

/** Returns true when a changed setting affects workspace roots. */
export function isSecuritySettingKey(key: string): boolean {
  return key === SECURITY_SETTING_KEYS.workspaceRoots;
}
