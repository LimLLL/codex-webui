/** Pure projections for app-server turn errors at persistence and browser boundaries. */
import type { ServerNotification, v2 } from '../codex/codex-schema';

/** Turn-error fields that are safe to retain in the local database. */
export interface PersistableTurnError {
  message: string;
  errorCategory: string | null;
  additionalDetails: string | null;
  misalignmentErrorType: string | null;
  misalignmentExplanation: string | null;
}

/** Public misalignment detail deliberately excludes continuation steering. */
export interface ClientMisalignmentDetails {
  errorType: string | null;
  detailedExplanation: string | null;
}

/** Browser-facing turn error with no continuation steering payload. */
export interface ClientTurnError {
  message: string;
  codexErrorInfo: v2.CodexErrorInfo | null;
  additionalDetails: string | null;
  misalignment: ClientMisalignmentDetails | null;
}

/** Browser-facing turn shape used by paged history and socket notifications. */
export type ClientTurn = Omit<v2.Turn, 'error'> & {
  error: ClientTurnError | null;
};

/** Browser-facing thread read shape whose turns cannot contain steering. */
export type ClientThreadReadResponse = Omit<v2.ThreadReadResponse, 'thread'> & {
  thread: Omit<v2.Thread, 'turns'> & { turns: ClientTurn[] };
};

/** Returns the stable discriminator for either string or object error variants. */
export function codexErrorCategory(
  info: v2.CodexErrorInfo | null,
): string | null {
  if (typeof info === 'string') return info;
  if (!info) return null;
  return Object.keys(info)[0] ?? null;
}

/** Extracts the local retention fields while intentionally discarding steering. */
export function toPersistableTurnError(
  error: v2.TurnError,
): PersistableTurnError {
  return {
    message: error.message,
    errorCategory: codexErrorCategory(error.codexErrorInfo),
    additionalDetails: error.additionalDetails ?? null,
    misalignmentErrorType: error.misalignment?.errorType ?? null,
    misalignmentExplanation: error.misalignment?.detailedExplanation ?? null,
  };
}

/** Projects one app-server error for public display, omitting `steer`. */
export function projectTurnErrorForClient(
  error: v2.TurnError | null,
): ClientTurnError | null {
  if (!error) return null;
  return {
    message: error.message,
    codexErrorInfo: error.codexErrorInfo,
    additionalDetails: error.additionalDetails,
    misalignment: error.misalignment
      ? {
          errorType: error.misalignment.errorType,
          detailedExplanation: error.misalignment.detailedExplanation,
        }
      : null,
  };
}

/** Projects a turn without mutating the app-server-owned payload. */
export function projectTurnForClient(turn: v2.Turn): ClientTurn {
  return { ...turn, error: projectTurnErrorForClient(turn.error) };
}

/** Projects a full thread read before it crosses the REST boundary. */
export function projectThreadReadForClient(
  response: v2.ThreadReadResponse,
): ClientThreadReadResponse {
  return {
    ...response,
    thread: {
      ...response.thread,
      turns: response.thread.turns.map(projectTurnForClient),
    },
  };
}

/**
 * Removes steering from the two notifications that can carry terminal errors.
 *
 * The original notification remains available to backend listeners so local
 * persistence can receive the wire payload, while the returned copy is the
 * only value allowed across the WebSocket boundary.
 */
export function projectNotificationForClient(
  notification: ServerNotification,
): { method: string; params: unknown } {
  if (notification.method === 'error') {
    if (!notification.params.error) return notification;
    return {
      method: notification.method,
      params: {
        ...notification.params,
        error: projectTurnErrorForClient(notification.params.error),
      },
    };
  }
  if (notification.method === 'turn/completed') {
    return {
      method: notification.method,
      params: {
        ...notification.params,
        turn: projectTurnForClient(notification.params.turn),
      },
    };
  }
  return notification;
}
