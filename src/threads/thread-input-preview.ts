/** Derives short display labels from turn input, for branch version switchers. */
import type { v2 } from '../codex/codex-schema';

const PREVIEW_MAX_LENGTH = 500;

/** Caps a preview at the stored length, shared by every producer. */
export function truncatePreview(text: string): string {
  return text.slice(0, PREVIEW_MAX_LENGTH);
}

/** Builds a short stable preview for branch version labels. */
export function previewFromUserInput(input: v2.UserInput[]): string {
  const text = input
    .map((item) => {
      switch (item.type) {
        case 'text':
          return item.text;
        case 'skill':
        case 'mention':
          return `@${item.name}`;
        case 'image':
        case 'localImage':
          return '[image]';
        case 'audio':
        case 'localAudio':
          return '[audio]';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncatePreview(text);
}
