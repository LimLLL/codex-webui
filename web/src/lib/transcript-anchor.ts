/** Semantic reading points refer to existing measured content, never spacer or sentinel nodes. */

export interface ReadingAnchor {
  rowKey: string;
  itemId: string | null;
  block: number;
  blockKey: string | null;
  textOffset: number | null;
  viewportY: number;
  rowViewportY: number;
}

export interface TranscriptBookmark {
  follow: boolean;
  anchor: ReadingAnchor | null;
  offset: number;
  width: number;
}

const bookmarks = new Map<string, TranscriptBookmark>();
const BLOCKS = 'p,pre,li,h1,h2,h3,blockquote,td,[data-reading-block]';

/** Reads a browser-session bookmark; it contains no DOM references or persisted measurements. */
export function readTranscriptBookmark(
  threadId: string,
): TranscriptBookmark | undefined {
  return bookmarks.get(threadId);
}

/** Extracts only recoverable turn identities; interaction/system/optimistic rows cannot be paged. */
export function readingAnchorTurnId(anchor: ReadingAnchor): string | null {
  const id = /^(?:user|turn|turnFailure):(.+):\d+$/.exec(anchor.rowKey)?.[1];
  return id && id !== 'pending' ? id : null;
}

/** Retains the last user intent across tab and conversation navigation. */
export function saveTranscriptBookmark(
  threadId: string,
  bookmark: TranscriptBookmark,
): void {
  bookmarks.set(threadId, bookmark);
}

/** Actual deletion, unlike runtime eviction, removes a conversation's reading position. */
export function forgetTranscriptBookmarks(threadIds: readonly string[]): void {
  for (const id of threadIds) bookmarks.delete(id);
}

/** Returns text nodes in document order, independent of syntax-highlighter span boundaries. */
function textNodes(element: Element): Text[] {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const result: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.length) result.push(node as Text);
  }
  return result;
}

/** Locates a logical character after React or syntax highlighting replaced its DOM text node. */
function characterRect(element: Element, offset: number): DOMRect | null {
  let remaining = offset;
  for (const node of textNodes(element)) {
    const length = node.length;
    if (remaining >= length) {
      remaining -= length;
      continue;
    }
    const range = document.createRange();
    range.setStart(node, remaining);
    range.setEnd(node, remaining + 1);
    return range.getClientRects()[0] ?? null;
  }
  return null;
}

/** Finds the first text character crossing the reading line, using logarithmic search per node. */
function textPoint(
  element: Element,
  readingY: number,
): { offset: number; top: number } | null {
  let offset = 0;
  for (const node of textNodes(element)) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const bounds = range.getBoundingClientRect();
    if (bounds.bottom <= readingY || bounds.height === 0) {
      offset += node.length;
      continue;
    }
    let low = 0;
    let high = node.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      range.setStart(node, mid);
      range.setEnd(node, mid + 1);
      if (range.getBoundingClientRect().bottom <= readingY) low = mid + 1;
      else high = mid;
    }
    range.setStart(node, low);
    range.setEnd(node, low + 1);
    return { offset: offset + low, top: range.getBoundingClientRect().top };
  }
  return null;
}

/**
 * Finds the first element crossing the reading line and still inside the viewport.
 *
 * One rect per candidate: this runs on every scroll event while history is
 * being read, and asking twice per node doubled the layout reads for nothing.
 */
function firstAtReadingLine(
  nodes: Iterable<HTMLElement>,
  readingY: number,
  viewportBottom: number,
): HTMLElement | undefined {
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > readingY && rect.top < viewportBottom) return node;
  }
  return undefined;
}

/** Captures a visible item/block/text point inside a row already measured by the virtualizer. */
export function captureReadingAnchor(
  scroller: HTMLElement,
): ReadingAnchor | null {
  const viewport = scroller.getBoundingClientRect();
  const readingY = viewport.top + 8;
  const row = firstAtReadingLine(
    scroller.querySelectorAll<HTMLElement>('[data-transcript-row]'),
    readingY,
    viewport.bottom,
  );
  if (!row) return null;
  const item = firstAtReadingLine(
    row.querySelectorAll<HTMLElement>('[data-transcript-item]'),
    readingY,
    viewport.bottom,
  );
  const root = item ?? row;
  const marked = [
    ...root.querySelectorAll<HTMLElement>('[data-reading-block]'),
  ];
  const blocks = marked.length
    ? marked
    : [...root.querySelectorAll<HTMLElement>(BLOCKS)];
  const block = blocks.findIndex((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > readingY && rect.height > 0;
  });
  const element = blocks[block] ?? root;
  const point = textPoint(element, readingY);
  return {
    rowKey: row.dataset.transcriptRow!,
    itemId: item?.dataset.transcriptItem ?? null,
    block,
    blockKey: element.dataset.readingBlock ?? null,
    textOffset: point?.offset ?? null,
    viewportY:
      (point?.top ?? element.getBoundingClientRect().top) - viewport.top,
    rowViewportY: row.getBoundingClientRect().top - viewport.top,
  };
}

/** Measures the remaining displacement after the library has applied its own adjustments. */
export function readingAnchorDelta(
  scroller: HTMLElement,
  anchor: ReadingAnchor,
): number | null {
  const row = [
    ...scroller.querySelectorAll<HTMLElement>('[data-transcript-row]'),
  ].find((node) => node.dataset.transcriptRow === anchor.rowKey);
  if (!row) return null;
  const top = scroller.getBoundingClientRect().top;
  const item =
    anchor.itemId === null
      ? row
      : [...row.querySelectorAll<HTMLElement>('[data-transcript-item]')].find(
          (node) => node.dataset.transcriptItem === anchor.itemId,
        );
  if (!item) return row.getBoundingClientRect().top - top - anchor.rowViewportY;
  const block =
    anchor.blockKey !== null
      ? [...item.querySelectorAll<HTMLElement>('[data-reading-block]')].find(
          (node) => node.dataset.readingBlock === anchor.blockKey,
        )
      : anchor.block < 0
        ? item
        : item.querySelectorAll<HTMLElement>(BLOCKS)[anchor.block];
  if (!block)
    return row.getBoundingClientRect().top - top - anchor.rowViewportY;
  const rect =
    anchor.textOffset === null
      ? block.getBoundingClientRect()
      : characterRect(block, anchor.textOffset);
  return rect ? rect.top - top - anchor.viewportY : null;
}
