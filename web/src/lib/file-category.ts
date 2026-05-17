/** File type classification utilities for viewer routing. */

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif',
]);

/** Returns the lowercase file extension without the dot. */
function getExtension(filePath: string): string {
  const name = filePath.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Detects file type category from extension. */
export function getFileCategory(filePath: string): 'image' | 'code' {
  const ext = getExtension(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  // Future: 'pdf', 'video', 'office', 'binary', etc.
  return 'code';
}
