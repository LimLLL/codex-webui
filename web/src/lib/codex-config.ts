/** Shared helpers for Codex app-server config values and origin metadata. */
import type { ThreadStartResponseDto } from '@/generated/api/types.gen';

/** Approval reviewer values declared by the app-server contract. */
export type ApprovalReviewerValue = NonNullable<
  ThreadStartResponseDto['approvalsReviewer']
>;

/** UI choices for approval reviewer config fields. */
export const APPROVAL_REVIEWER_VALUES = [
  'user',
  'auto_review',
  'guardian_subagent',
] as const satisfies readonly ApprovalReviewerValue[];

/** Tool approval modes accepted by app-server for app tool policy config. */
export type AppToolApprovalModeValue = 'auto' | 'prompt' | 'writes' | 'approve';

/** UI choices for per-app and per-tool approval mode config fields. */
export const APP_TOOL_APPROVAL_MODE_VALUES = [
  'auto',
  'prompt',
  'writes',
  'approve',
] as const satisfies readonly AppToolApprovalModeValue[];

/** Runtime-safe JSON object shape used by config/read responses. */
export type ConfigRecord = Record<string, unknown>;

/** Resolved effective value plus the config layer that supplied it. */
export interface ResolvedConfigValue<T> {
  /** Effective value after following the documented inheritance chain. */
  value: T;
  /** Origin layer label for the effective value, or `built-in` for fallback defaults. */
  source: string | null;
  /** Key path that supplied the effective value, or null for built-in fallback. */
  sourceKeyPath: string | null;
}

/** Returns true for app and tool id segments accepted by the curated path allowlist. */
export function isEditableConfigSegment(segment: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(segment);
}

/** Returns a nested config value for a dotted key path. */
export function getConfigPathValue(
  config: ConfigRecord | undefined,
  keyPath: string,
): unknown {
  if (!config) return undefined;
  let current: unknown = config;
  for (const segment of keyPath.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Extracts a config origin layer name for a key path from config/read metadata. */
export function originLabel(
  origins: ConfigRecord | undefined,
  keyPath: string,
): string | null {
  if (!origins) return null;
  const meta = origins[keyPath];
  if (isRecord(meta) && isRecord(meta.name)) {
    const type = meta.name.type;
    return typeof type === 'string' ? type : null;
  }
  return null;
}

/** Returns true when the effective value for a key path comes from user config. */
export function isUserConfigOrigin(
  origins: ConfigRecord | undefined,
  keyPath: string,
): boolean {
  return originLabel(origins, keyPath) === 'user';
}

/** Formats a config value for read-only display. */
export function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Converts a config value to an editable draft string. */
export function configValueToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Type guard for approval reviewer values. */
export function isApprovalReviewerValue(
  value: unknown,
): value is ApprovalReviewerValue {
  return (
    typeof value === 'string' &&
    APPROVAL_REVIEWER_VALUES.some((option) => option === value)
  );
}

/** Type guard for app tool approval mode values. */
export function isAppToolApprovalModeValue(
  value: unknown,
): value is AppToolApprovalModeValue {
  return (
    typeof value === 'string' &&
    APP_TOOL_APPROVAL_MODE_VALUES.some((option) => option === value)
  );
}

/** Resolves the first non-null config value in a documented inheritance chain. */
export function resolveConfigValue<T>(
  config: ConfigRecord | undefined,
  origins: ConfigRecord | undefined,
  keyPaths: readonly string[],
  fallback: T,
  isValue: (value: unknown) => value is T,
): ResolvedConfigValue<T> {
  for (const keyPath of keyPaths) {
    const value = getConfigPathValue(config, keyPath);
    if (isValue(value)) {
      return {
        value,
        source: originLabel(origins, keyPath),
        sourceKeyPath: keyPath,
      };
    }
  }

  return {
    value: fallback,
    source: 'built-in',
    sourceKeyPath: null,
  };
}

/** Returns true when a value is a boolean. */
export function isBooleanValue(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
