/**
 * The one channel for asking the session panel to open a file.
 *
 * Chat messages sit far below the route that owns the panel, and the request
 * crosses that gap as a window event rather than through the render tree. The
 * shape lives here so both message surfaces and the receiving route agree on
 * it — the panel gained a line target only after this was centralised, and a
 * second ad-hoc dispatch site would have silently kept the old payload.
 */

/** Event name carrying an open-file request to the thread route. */
export const OPEN_FILE_EVENT = 'codex-webui:open-file';

/** Payload of an open-file request. */
export interface OpenFileRequestDetail {
  /** Absolute path to open. */
  path: string;
  /**
   * One-based line to reveal once the file loads, when the reference named one.
   * Only the text editor honours it; other viewers consume and discard it.
   */
  line?: number | null;
  /**
   * Conversation the request was raised in.
   *
   * The receiving route rejects requests from a conversation that is no longer
   * on screen: opening is asynchronous, and a request raised just before a
   * thread switch would otherwise land in the wrong conversation's panel.
   */
  sourceThreadId?: string | null;
}

/**
 * Asks the thread route to open a file in the session panel.
 *
 * @param detail - Absolute path, optional line target, and originating thread
 */
export function requestOpenFile(detail: OpenFileRequestDetail): void {
  window.dispatchEvent(new CustomEvent(OPEN_FILE_EVENT, { detail }));
}
