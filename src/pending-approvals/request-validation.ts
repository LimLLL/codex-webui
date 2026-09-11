/** Small runtime checks shared by request admission and response encoding. */
import { isDeepStrictEqual } from 'node:util';

/** Returns a JSON object without coercing arrays, null, or primitive values. */
export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Rejects semantic fields this implementation would otherwise silently drop. */
export function onlyKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Checks a nonempty identifier or display subject without normalizing its contents. */
export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Accepts only an advertised action, preserving the entire nested proposal. */
export function advertised(value: unknown, options: unknown[]): boolean {
  return options.some((option) => isDeepStrictEqual(option, value));
}
