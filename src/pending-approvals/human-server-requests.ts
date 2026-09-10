/** Explicitly separates human decisions from machine-facing protocol requests. */
import type { ServerRequest } from '../codex/codex-schema';

/** Exhaustive for the pinned schema; unexported/unknown methods never become human prompts. */
const HUMAN_REQUESTS = {
  'item/commandExecution/requestApproval': true,
  'item/fileChange/requestApproval': true,
  'item/tool/requestUserInput': true,
  'mcpServer/elicitation/request': true,
  'item/permissions/requestApproval': true,
  applyPatchApproval: true,
  execCommandApproval: true,
  'item/tool/call': false,
  'account/chatgptAuthTokens/refresh': false,
  'attestation/generate': false,
} satisfies Record<ServerRequest['method'], boolean>;

/** Returns whether a request is a human interaction, rather than executable client work. */
export function isHumanServerRequest(method: string): boolean {
  return (
    Object.hasOwn(HUMAN_REQUESTS, method) &&
    HUMAN_REQUESTS[method as keyof typeof HUMAN_REQUESTS] === true
  );
}
