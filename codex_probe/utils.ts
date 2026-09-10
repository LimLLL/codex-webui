/** Shared probe timing and display helpers; re-exported by the harness. */
/** Sleeps, for settling windows where no notification marks the boundary. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads an item's protocol type, which differs by view between snake and camel. */
export function itemType(item: unknown): string {
  const record = (item ?? {}) as Record<string, unknown>;
  return text(record.item_type) || text(record.type) || 'unknown';
}

/**
 * Renders an unknown protocol value as text without stringifying an object.
 *
 * Probe output is read by a human comparing orders and statuses, and a stray
 * `[object Object]` in that list is indistinguishable from a real value.
 *
 * @param value - Any field read off an untyped protocol payload
 * @returns The value when it is a string or number, otherwise an empty string
 */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}
