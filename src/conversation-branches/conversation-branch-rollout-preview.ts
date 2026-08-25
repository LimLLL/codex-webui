/** Preview extraction for user messages found in raw rollout records. */
const PREVIEW_MAX_LENGTH = 500;

/** Returns a user-message preview when a rollout payload carries one. */
export function extractRolloutUserPreview(
  payload: Record<string, unknown>,
): string | null {
  const candidates = [
    payload,
    asRecord(payload.item),
    asRecord(payload.message),
  ].filter((item): item is Record<string, unknown> => Boolean(item));
  for (const item of candidates) {
    if (
      readString(item, ['type']) === 'userMessage' ||
      readString(item, ['role']) === 'user'
    ) {
      return previewFromUnknownContent(item.content);
    }
  }
  return null;
}

function previewFromUnknownContent(value: unknown): string {
  if (typeof value === 'string') return truncate(value);
  if (!Array.isArray(value)) return '';
  const text = value
    .map((item) => previewPart(item))
    .filter((item): item is string => Boolean(item))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text);
}

function previewPart(value: unknown): string | null {
  const item = asRecord(value);
  if (!item) return typeof value === 'string' ? value : null;
  const type = readString(item, ['type']);
  if (type === 'image' || type === 'localImage' || type === 'input_image') {
    return '[image]';
  }
  if (type === 'audio' || type === 'localAudio' || type === 'input_audio') {
    return '[audio]';
  }
  const text = readString(item, ['text', 'content']);
  const name = readString(item, ['name']);
  if (text) return text;
  return name && (type === 'skill' || type === 'mention') ? `@${name}` : null;
}

function truncate(text: string): string {
  return text.slice(0, PREVIEW_MAX_LENGTH);
}

function readString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
