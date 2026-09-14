/** Origin-scoped submission reconciliation closes the gap before a turn-start notification arrives. */
import type { ThreadsStartTurnResponse } from '@/generated/api';
import type { TimelineEntry } from '@/types/timeline';
import { useTimelineStore } from '@/stores/timeline-store';
import { getApiErrorMessage } from './api-error';

export interface TurnSubmission {
  threadId: string;
  prompt: TimelineEntry | undefined;
}

/** Captures the optimistic prompt identity, which a later submission cannot accidentally share. */
export function captureTurnSubmission(threadId: string): TurnSubmission {
  return {
    threadId,
    prompt: useTimelineStore
      .getState()
      .getThreadRuntime(threadId)
      ?.timeline.findLast((entry) => entry.kind === 'user' && !entry.turnId),
  };
}

/** Settles only this submission; late HTTP success cannot revive a finished turn or clear a newer send. */
export function acceptTurnSubmission(
  submission: TurnSubmission,
  response: ThreadsStartTurnResponse,
): void {
  const store = useTimelineStore.getState();
  const runtime = store.getThreadRuntime(submission.threadId);
  if (!runtime || runtime.deletedRemotely) return;
  const turn = response.turn;
  if (runtime.activeTurnId && runtime.activeTurnId !== turn.id) return;
  const pending = runtime.timeline.findLast(
    (entry) => entry.kind === 'user' && !entry.turnId,
  );
  // The pending flag may already have been released by a fatal error. Prompt
  // identity still prevents an old HTTP acknowledgement from binding a later draft.
  if (pending !== submission.prompt && runtime.activeTurnId !== turn.id) return;
  store.setActiveTurnIdForThread(submission.threadId, turn.id);
  if (
    turn.status !== 'inProgress' ||
    runtime.timeline.some(
      (entry) =>
        entry.kind === 'turn' && entry.turnId === turn.id && entry.completed,
    )
  ) {
    store.updateCurrentTurnForThread(submission.threadId, turn.id, (items) => ({
      items,
      completed: true,
    }));
    store.clearActiveTurnForThread(submission.threadId);
  }
  store.setTurnStartPendingForThread(submission.threadId, false);
}

/** Reports an origin-scoped failure; uncertain transport delivery remains pending for lifecycle recovery. */
export function rejectTurnSubmission(
  submission: TurnSubmission,
  error: unknown,
): void {
  const store = useTimelineStore.getState();
  const runtime = store.getThreadRuntime(submission.threadId);
  if (!runtime) return;
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode)
      : null;
  const pending = runtime.timeline.findLast(
    (entry) => entry.kind === 'user' && !entry.turnId,
  );
  if (
    status !== null &&
    status >= 400 &&
    status < 500 &&
    pending === submission.prompt
  ) {
    store.setTurnStartPendingForThread(submission.threadId, false);
  }
  store.addSystemErrorForThread(submission.threadId, getApiErrorMessage(error));
}
