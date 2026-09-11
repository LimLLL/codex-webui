/**
 * Canonical thread open.
 *
 * Opening used to happen twice for one click: the sidebar row resumed the
 * thread and then navigated, and the route resumed it again on the threadId
 * change. Each success handler independently pulled token usage, turn diffs and
 * turn errors, so a single click cost eight requests and transferred the turn
 * payload twice. Worse, resume takes writer ownership of a paginated thread, so
 * the duplicate was two attempts to claim the same thing.
 *
 * There is exactly one owner now: the route. Every other surface navigates.
 */
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invalidateThreadDetails } from '@/lib/query-invalidation';
import { useTranslation } from 'react-i18next';
import { threadsResumeThreadMutation } from '@/generated/api/@tanstack/react-query.gen';
import {
  threadsListTurns,
  tokenUsageReadThreadTokenUsage,
  turnDiffReadThreadTurnDiffs,
  turnErrorsReadThreadTurnErrors,
} from '@/generated/api/sdk.gen';
import type {
  ThreadOpenResponseDto,
  ThreadReadResponseDto,
  ThreadTurnsPageDto,
} from '@/generated/api/types.gen';
import { recoverThreadAfterReconnect } from '@/lib/thread-recovery';
import { currentRecoveryEpoch, currentThreadEpoch, invalidateThreadEpoch } from '@/lib/thread-recovery-epoch';
import { useModelStore, type ReasoningEffort } from '@/stores/model-store';
import { showSnackbar } from '@/stores/snackbar-store';
import { useTimelineStore } from '@/stores/timeline-store';
import { nextObservationSeq } from '@/lib/turn-item-merge';
import { refreshThreadPolicy, settleIfObserved } from '@/stores/thread-policy-store';

/** Turns fetched per older-history page. */
export const HISTORY_PAGE_SIZE = 20;

/** Extracts a display label from a thread DTO. */
function threadLabel(thread: {
  name?: string | null;
  preview?: string | null;
}): string {
  return thread.name ?? thread.preview ?? '';
}

/**
 * Loads the auxiliary per-turn datasets that live in this app's own database.
 *
 * Kept off the open path's critical section: none of them is needed to paint
 * the conversation, and a failure in any one must not stop the other two.
 */
export async function hydrateAuxiliaryData(threadId: string): Promise<void> {
  const store = useTimelineStore.getState();
  const baseline = store.getThreadRuntime(threadId);
  if (!baseline) return;
  const epoch = currentRecoveryEpoch(threadId);
  const current = () => currentRecoveryEpoch(threadId) === epoch && Boolean(store.getThreadRuntime(threadId));
  await Promise.all([
  tokenUsageReadThreadTokenUsage({ path: { threadId } })
    .then(({ data }) => data && current() && store.hydrateTokenUsageForThread(threadId, data.turns, baseline))
    .catch(() => undefined),
  turnDiffReadThreadTurnDiffs({ path: { threadId } })
    .then(({ data }) => data && current() && store.hydrateTurnDiffsForThread(threadId, data.turns, baseline))
    .catch(() => undefined),
  turnErrorsReadThreadTurnErrors({ path: { threadId } })
    .then(({ data }) => data && current() && store.hydrateTurnErrorsForThread(threadId, data.errors))
    .catch(() => undefined),
  ]);
}

/**
 * Applies the degraded read-only open from metadata plus its newest turn page.
 *
 * This deliberately mirrors the normal metadata-first opener instead of
 * rebuilding the complete transcript server-side. The returned cursor keeps
 * earlier history behind the existing explicit load-earlier affordance.
 */
export function applyReadOnlySnapshot(
  response: ThreadReadResponseDto,
  initialTurnsPage: ThreadTurnsPageDto,
): void {
  const store = useTimelineStore.getState();
  const threadId = response.thread.id;
  if (!store.getThreadRuntime(threadId)) return;

  store.setReadOnlyThread(response.thread);
  // The failed open already created this runtime without a label, and
  // `ensureThreadState` will not relabel an existing one — so the title has to
  // be applied here exactly as the normal open path applies it.
  store.setThreadTitleForThread(threadId, threadLabel(response.thread));
  store.hydrateOpenedThread({
    threadId,
    turnsNewestFirst: initialTurnsPage.data,
    historyCursor: initialTurnsPage.nextCursor,
    readOnlyReason: null,
    cwd: response.thread.cwd,
  });
  store.setThreadStatusForThread(threadId, response.thread.status);
  void hydrateAuxiliaryData(threadId);
}

/**
 * Applies an open response to the store.
 *
 * Exported because opening is not only user-initiated: reconnecting and
 * recovering after a refresh reopen threads in the background. They must
 * interpret the response the same way, or the metadata-only `thread.turns`
 * field silently renders those threads blank.
 *
 * @param response - Metadata and the initial summary page from the backend
 * @param baselineSeq - Observation sequence captured before requesting the open
 * @param joined - Optional room acknowledgement; triggers a fresh post-join page
 * @returns Completion of repair reads; initial rendering happens synchronously
 */
export function applyOpenResponse(
  response: ThreadOpenResponseDto,
  baselineSeq: number = -1,
  joined?: Promise<boolean>,
): Promise<void> {
  const store = useTimelineStore.getState();
  const threadId = response.thread.id;

  // Guard against a response that outlived its thread. Every path that opens a
  // thread creates its runtime before issuing the request, and deletion removes
  // it; so a missing runtime here means the conversation was destroyed while
  // this was in flight. Applying anyway would recreate it — the store writes
  // through a create-if-absent helper — and put a deleted conversation back on
  // screen with content.
  if (!store.getThreadRuntime(threadId)) return Promise.resolve();

  store.setThreadTitleForThread(threadId, threadLabel(response.thread));
  store.hydrateOpenedThread({
    threadId,
    turnsNewestFirst: response.initialTurnsPage.data,
    historyCursor: response.initialTurnsPage.nextCursor,
    readOnlyReason:
      response.mode === 'readOnly'
        ? (response.ownershipRefusalMessage ?? '')
        : null,
    cwd: response.cwd,
  });
  store.setThreadStatusForThread(threadId, response.thread.status);
  // The first hook read can precede resume and report observed:false. Opening
  // (including restart recovery) is the point at which settings are available.
  const policy = refreshThreadPolicy(threadId).then(() => settleIfObserved(threadId));

  // Seed the composer's display-only view of this thread's resolved settings.
  // `thread/settings/updated` only fires when settings change, so without this
  // a reopened thread would fall back to catalog defaults — the speed picker
  // would claim "Standard" for a thread already running on a paid tier while
  // the composer omits `serviceTier`, leaving that tier in force.
  //
  // Stamped with the baseline captured BEFORE the request rather than with the
  // current counter: this response describes the thread as it was when the
  // request was served, so a settings notification that arrived while it was in
  // flight is newer and must not be overwritten by it.
  useModelStore.getState().setObservedThreadSettings(
    threadId,
    {
      effort: (response.reasoningEffort ?? null) as ReasoningEffort | null,
      serviceTier: response.serviceTier,
    },
    baselineSeq,
  );

  // `thread.turns` is empty by construction now, so an in-progress turn has to
  // be recognised from the page that was returned instead.
  //
  // A page is a snapshot taken when the request was SERVED. If that turn's
  // `turn/completed` arrived while this response was in flight, the page still
  // calls it running, and adopting it would revive a turn this client already
  // watched finish — leaving the composer spinning forever on a finished turn.
  // `settleTurnLifecycleForThread` refuses the same thing on the reconnect path;
  // this is the open path's half of that rule.
  const locallyTerminalTurnIds = new Set(
    (store.getThreadRuntime(threadId)?.timeline ?? []).flatMap((entry) =>
      entry.kind === 'turn' && entry.completed ? [entry.turnId] : [],
    ),
  );
  const activeTurn = response.initialTurnsPage.data.find(
    (turn) =>
      turn.status === 'inProgress' && !locallyTerminalTurnIds.has(turn.id),
  );
  // A page that names no running turn is not proof there is none. It was built
  // when the request was served, and a turn started since — or started while
  // this was in flight — will not be in it. Only clear the pointer when this
  // page actually covers the turn it names and reports it finished; otherwise
  // the live lifecycle events remain the better-informed source.
  const known = store.getThreadRuntime(threadId)?.activeTurnId ?? null;
  const pageCoversKnownTurn =
    known !== null &&
    response.initialTurnsPage.data.some((turn) => turn.id === known);
  if (activeTurn) {
    store.setActiveTurnIdForThread(threadId, activeTurn.id);
  } else if (known === null || pageCoversKnownTurn) {
    store.setActiveTurnIdForThread(threadId, null);
  }
  store.setLoadingForThread(
    threadId,
    Boolean(activeTurn) || (known !== null && !pageCoversKnownTurn),
  );

  // A running turn arrives empty: the page is fetched in the `summary` view,
  // which carries only user messages and a turn's final assistant message, and
  // a turn still running has no final message yet. Its finished items are
  // durable all the same — persistence happens per item, not per turn — so
  // they are read separately instead of leaving the transcript blank until the
  // turn ends. The per-turn top-up cannot do this: it is gated on completion.
  const epoch = currentThreadEpoch(threadId);
  const repair = (joined ?? Promise.resolve(false)).then(async (acknowledged) => {
    if (epoch !== currentThreadEpoch(threadId) || !store.getThreadRuntime(threadId)) return;
    // HTTP and Socket.IO are independent. An acknowledged join needs a fresh
    // page after it; an HTTP-only open can still repair its returned page.
    await recoverThreadAfterReconnect(threadId, acknowledged ? undefined : response.initialTurnsPage);
    if (epoch === currentThreadEpoch(threadId)) await hydrateAuxiliaryData(threadId);
  });
  return Promise.all([repair, policy]).then(() => undefined);
}

/**
 * Opens a thread, rendering already-hydrated state immediately.
 *
 * A thread this client has open in memory needs no loading presentation: the
 * content is already correct and the request that follows only refreshes it.
 * Showing a spinner over content we can already draw was most of what made
 * switching conversations feel broken.
 */
export function useOpenThread() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    ...threadsResumeThreadMutation(),
    onMutate: (variables) => {
      const threadId = variables.path.threadId;
      const store = useTimelineStore.getState();
      invalidateThreadEpoch(threadId);
      const joined = store.setActiveThread(threadId);
      store.setHistoryLoadingForThread(threadId, false);
      const runtime = store.getThreadRuntime(threadId);
      if (!runtime?.hydrated) store.setLoadingForThread(threadId, true);
      // Captured before the request goes out, so anything observed while it is
      // in flight outranks the snapshot the response carries.
      return { baselineSeq: nextObservationSeq(), epoch: currentThreadEpoch(threadId), joined };
    },
    onSuccess: (response: ThreadOpenResponseDto, _variables, context) => {
      if (context?.epoch !== currentThreadEpoch(response.thread.id)) return;
      const repair = applyOpenResponse(response, context?.baselineSeq, context.joined);
      invalidateThreadDetails(queryClient, response.thread.id);
      if (response.mode === 'readOnly') {
        showSnackbar(
          t('This conversation is open in another client; opened read-only.'),
          'warning',
        );
      }
      return repair;
    },
    onError: (_err, variables, context) => {
      // Same guard as the success path, for the same reason: the store's
      // setters create a runtime when one is absent, so clearing the loading
      // flag on a thread that was deleted mid-request would rebuild the shell
      // of a conversation that no longer exists.
      const store = useTimelineStore.getState();
      if (context?.epoch === currentThreadEpoch(variables.path.threadId) && store.getThreadRuntime(variables.path.threadId)) {
        store.setLoadingForThread(variables.path.threadId, false);
      }
    },
  });
}

/**
 * Fetches the next older page of history for a thread.
 *
 * Returns a no-op when there is nothing older or a page is already in flight,
 * so callers can wire it straight to a scroll handler without guarding.
 */
export function useLoadOlderHistory(threadId: string | null) {
  return useCallback(async () => {
    if (!threadId) return;
    const store = useTimelineStore.getState();
    const runtime = store.getThreadRuntime(threadId);
    if (!runtime?.historyCursor || runtime.historyLoading) return;

    const epoch = currentRecoveryEpoch(threadId);
    const current = () => currentRecoveryEpoch(threadId) === epoch && Boolean(store.getThreadRuntime(threadId));
    store.setHistoryLoadingForThread(threadId, true);
    try {
      const { data } = await threadsListTurns({
        path: { threadId },
        query: {
          cursor: runtime.historyCursor,
          limit: HISTORY_PAGE_SIZE,
          sortDirection: 'desc',
          itemsView: 'full',
        },
      });
      if (!current()) return;
      if (!data) {
        store.setHistoryLoadingForThread(threadId, false);
        return;
      }
      store.prependHistoryForThread(threadId, data.data, data.nextCursor);
    } catch {
      // Leaving the cursor untouched keeps the control available for a retry;
      // clearing it would silently declare the history complete.
      if (current()) store.setHistoryLoadingForThread(threadId, false);
    }
  }, [threadId]);
}
