/** Bounded paging restores a remembered reading point when its runtime was evicted. */
import { threadsListTurns } from '@/generated/api/sdk.gen';
import i18n from '@/i18n';
import { HISTORY_PAGE_SIZE } from './history-prefetch';
import { useTimelineStore } from '@/stores/timeline-store';
import { currentThreadEpoch } from './thread-recovery-epoch';
import { assertFullHistoryPage } from './full-history';
import {
  readingAnchorTurnId,
  readTranscriptBookmark,
  saveTranscriptBookmark,
} from './transcript-anchor';

/** Retrieves at most ten ordinary full pages; a missing anchor is reported rather than falsely restored. */
export async function restoreHistoryBookmark(threadId: string): Promise<void> {
  const bookmark = readTranscriptBookmark(threadId);
  if (!bookmark?.anchor || bookmark.follow) return;
  const store = useTimelineStore.getState();
  const epoch = currentThreadEpoch(threadId);
  const turnId = readingAnchorTurnId(bookmark.anchor);
  const present = () =>
    store
      .getThreadRuntime(threadId)
      ?.timeline.some((entry) =>
        turnId
          ? 'turnId' in entry && entry.turnId === turnId
          : entry.kind === 'interaction' &&
            bookmark.anchor!.rowKey === `interaction:${entry.instanceId}`,
      );
  // A live interaction may still be retained. A missing non-pageable row must
  // fall back explicitly; keeping an unresolved anchor would lose its offset.
  if (!turnId) {
    if (!present()) {
      saveTranscriptBookmark(threadId, { ...bookmark, anchor: null });
      store.setOpenStateForThread(threadId, {
        historyError: i18n.t(
          'The previous reading position is outside the available history. Showing retained messages.',
        ),
      });
    }
    return;
  }
  const seen = new Set<string>();
  for (let page = 0; page < 10 && !present(); page++) {
    const runtime = store.getThreadRuntime(threadId);
    if (!runtime || epoch !== currentThreadEpoch(threadId)) return;
    const cursor = runtime.historyCursor;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
    const { data } = await threadsListTurns({
      path: { threadId },
      query: {
        cursor,
        itemsView: 'full',
        limit: HISTORY_PAGE_SIZE,
        sortDirection: 'desc',
      },
      throwOnError: true,
    });
    if (
      !store.getThreadRuntime(threadId) ||
      epoch !== currentThreadEpoch(threadId)
    )
      return;
    assertFullHistoryPage(data);
    store.prependHistoryForThread(threadId, data.data, data.nextCursor);
  }
  if (
    !present() &&
    store.getThreadRuntime(threadId) &&
    epoch === currentThreadEpoch(threadId)
  ) {
    saveTranscriptBookmark(threadId, { ...bookmark, anchor: null });
    store.setOpenStateForThread(threadId, {
      historyError: i18n.t(
        'The previous reading position is outside the available history. Showing retained messages.',
      ),
    });
  }
}
