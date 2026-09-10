/**
 * Field derivation for the catalog entry form.
 *
 * The field set is derived from the template entry rather than hardcoded. The
 * upstream schema carries about forty fields and gains more over CLI upgrades;
 * a hand-written list would silently stop exposing whatever was added, and
 * dropping an unknown field on a form round trip would quietly change the
 * model. Types come from the template's own values, so a field this app has
 * never heard of still gets a usable editor.
 */
import type { CatalogEntry } from './use-catalog-draft';

export type FieldKind = 'string' | 'number' | 'boolean' | 'json';

export interface CatalogField {
  key: string;
  kind: FieldKind;
  /** True when the template carries null, so the editor must allow clearing. */
  nullable: boolean;
}

/**
 * Fields shown before the collapsed remainder, in the order a user reasons
 * about them: identity first, then the numbers this whole feature exists for.
 */
const PRIMARY_KEYS = [
  'slug',
  'display_name',
  'description',
  'visibility',
  'priority',
  'context_window',
  'max_context_window',
  'effective_context_window_percent',
  'auto_compact_token_limit',
];

/** Values `visibility` accepts; the upstream parser refuses anything else. */
export const VISIBILITY_VALUES = ['list', 'hide', 'none'];

/** Infers an editor kind from a concrete value. */
function kindOf(value: unknown): FieldKind {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'json';
}

/**
 * Builds the ordered field list for an entry.
 *
 * @param entry - Entry being edited.
 * @param template - Entry the values were inherited from, used to type fields
 *   the edited entry left absent.
 * @returns Primary fields first, then everything else alphabetically.
 */
export function catalogFields(
  entry: CatalogEntry,
  template: CatalogEntry | null,
): CatalogField[] {
  const keys = new Set([
    ...PRIMARY_KEYS,
    ...Object.keys(template ?? {}),
    ...Object.keys(entry),
  ]);
  const field = (key: string): CatalogField => {
    const own = entry[key];
    const reference = own === undefined || own === null ? template?.[key] : own;
    return {
      key,
      kind: kindOf(reference),
      nullable: own === null || (own === undefined && template?.[key] === null),
    };
  };
  const primary = PRIMARY_KEYS.filter((key) => keys.has(key)).map(field);
  const rest = [...keys]
    .filter((key) => !PRIMARY_KEYS.includes(key))
    .sort()
    .map(field);
  return [...primary, ...rest];
}

/**
 * Applies one edited field onto an entry without disturbing the others.
 *
 * Absent, null and empty string mean different things upstream, so an empty
 * input clears the key back to null rather than writing `""`, and `undefined`
 * removes it entirely so the model falls back to the schema default.
 *
 * @param entry - Entry to copy and update.
 * @param field - Field being written.
 * @param raw - Editor text, or the boolean for a switch.
 * @returns Updated copy, or an error message when the value cannot be parsed.
 */
export function applyField(
  entry: CatalogEntry,
  field: CatalogField,
  raw: string | boolean,
): { entry: CatalogEntry } | { error: string } {
  const next = { ...entry };
  if (field.kind === 'boolean') {
    next[field.key] = Boolean(raw);
    return { entry: next };
  }
  const text = String(raw);
  if (text.trim() === '') {
    if (field.nullable) next[field.key] = null;
    else delete next[field.key];
    return { entry: next };
  }
  if (field.kind === 'number') {
    const value = Number(text);
    if (!Number.isFinite(value)) return { error: 'Must be a number' };
    next[field.key] = value;
    return { entry: next };
  }
  if (field.kind === 'json') {
    try {
      next[field.key] = JSON.parse(text);
    } catch {
      return { error: 'Must be valid JSON' };
    }
    return { entry: next };
  }
  next[field.key] = text;
  return { entry: next };
}

/**
 * Places an edited entry into the model list.
 *
 * Located by the slug the dialog opened with, never by object identity: the
 * draft document is reparsed on every render, so the entry handed to the dialog
 * is a different object from the one in the current list and an identity lookup
 * silently misses. A rename still has to land on the original row.
 *
 * @param models - Current model list.
 * @param originalSlug - Slug of the entry being edited, or null when adding.
 * @param entry - Edited entry to write.
 * @returns The updated list, or a missing marker when the edited entry is gone.
 */
export function placeEntry(
  models: CatalogEntry[],
  originalSlug: string | null,
  entry: CatalogEntry,
): { models: CatalogEntry[] } | { missing: string } {
  const slugOf = (item: CatalogEntry) =>
    typeof item.slug === 'string' ? item.slug : '';
  const target = originalSlug ?? slugOf(entry);
  const index = models.findIndex((item) => slugOf(item) === target);
  if (originalSlug !== null && index < 0) return { missing: originalSlug };
  const next = [...models];
  if (index >= 0) next[index] = entry;
  else next.push(entry);
  return { models: next };
}

/** Renders a field's current value as editor text. */
export function fieldText(entry: CatalogEntry, field: CatalogField): string {
  const value = entry[field.key];
  if (value === undefined || value === null) return '';
  if (field.kind === 'json') return JSON.stringify(value, null, 2);
  return String(value);
}
