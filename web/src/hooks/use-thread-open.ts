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
import { useMutation } from '@tanstack/react-query';
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
import { showSnackbar } from '@/stores/snackbar-store';
import { useTimelineStore } from '@/stores/timeline-store';

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
function hydrateAuxiliaryData(threadId: string): void {
  const store = useTimelineStore.getState();
  void tokenUsageReadThreadTokenUsage({ path: { threadId } })
    .then(({ data }) => data && store.hydrateTokenUsageForThread(threadId, data.turns))
    .catch(() => undefined);
  void turnDiffReadThreadTurnDiffs({ path: { threadId } })
    .then(({ data }) => data && store.hydrateTurnDiffsForThread(threadId, data.turns))
    .catch(() => undefined);
  void turnErrorsReadThreadTurnErrors({ path: { threadId } })
    .then(({ data }) => data && store.hydrateTurnErrorsForThread(threadId, data.errors))
    .catch(() => undefined);
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
  hydrateAuxiliaryData(threadId);
}

/**
 * Applies an open response to the store.
 *
 * Exported because opening is not only user-initiated: reconnecting and
 * recovering after a refresh reopen threads in the background. They must
 * interpret the response the same way, or `thread.turns` — empty by design
 * since history became metadata-first — silently renders those threads blank.
 */
export function applyOpenResponse(response: ThreadOpenResponseDto): void {
  const store = useTimelineStore.getState();
  const threadId = response.thread.id;

  // Guard against a response that outlived its thread. Every path that opens a
  // thread creates its runtime before issuing the request, and deletion removes
  // it; so a missing runtime here means the conversation was destroyed while
  // this was in flight. Applying anyway would recreate it — the store writes
  // through a create-if-absent helper — and put a deleted conversation back on
  // screen with content.
  if (!store.getThreadRuntime(threadId)) return;

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

  // `thread.turns` is empty by construction now, so an in-progress turn has to
  // be recognised from the page that was returned instead.
  const activeTurn = response.initialTurnsPage.data.find(
    (turn) => turn.status === 'inProgress',
  );
  store.setActiveTurnIdForThread(threadId, activeTurn?.id ?? null);
  store.setLoadingForThread(threadId, Boolean(activeTurn));

  hydrateAuxiliaryData(threadId);
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
  const { t } = useTranslation();

  return useMutation({
    ...threadsResumeThreadMutation(),
    onMutate: (variables) => {
      const threadId = variables.path.threadId;
      const store = useTimelineStore.getState();
      store.setActiveThread(threadId);
      const runtime = store.getThreadRuntime(threadId);
      if (!runtime?.hydrated) store.setLoadingForThread(threadId, true);
    },
    onSuccess: (response: ThreadOpenResponseDto) => {
      applyOpenResponse(response);
      if (response.mode === 'readOnly') {
        showSnackbar(
          t('This conversation is open in another client; opened read-only.'),
          'warning',
        );
      }
    },
    onError: (_err, variables) => {
      // Same guard as the success path, for the same reason: the store's
      // setters create a runtime when one is absent, so clearing the loading
      // flag on a thread that was deleted mid-request would rebuild the shell
      // of a conversation that no longer exists.
      const store = useTimelineStore.getState();
      if (store.getThreadRuntime(variables.path.threadId)) {
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
      if (!data) {
        store.setHistoryLoadingForThread(threadId, false);
        return;
      }
      store.prependHistoryForThread(threadId, data.data, data.nextCursor);
    } catch {
      // Leaving the cursor untouched keeps the control available for a retry;
      // clearing it would silently declare the history complete.
      store.setHistoryLoadingForThread(threadId, false);
    }
  }, [threadId]);
}
