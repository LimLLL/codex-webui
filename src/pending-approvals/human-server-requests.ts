/** Explicitly separates human decisions from machine-facing protocol requests. */
import { isBrowserRequestMethod } from '../codex/server-request-owner';

/** Method support is declared once at ingress; admission also validates the payload. */
export function isHumanServerRequest(method: string): boolean {
  return isBrowserRequestMethod(method);
}
