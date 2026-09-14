/** Non-pageable reading identities must not exhaust the history pager or lose their fallback offset. */
import { beforeEach, expect, it, vi } from 'vitest';
import { useTimelineStore } from '@/stores/timeline-store';
import { threadsListTurns } from '@/generated/api/sdk.gen';
import { restoreHistoryBookmark } from './restore-history-bookmark';
import {
  saveTranscriptBookmark,
  readTranscriptBookmark,
  forgetTranscriptBookmarks,
} from './transcript-anchor';

vi.mock('@/socket', () => ({ getSocket: () => ({ emit: vi.fn() }) }));
vi.mock('@/generated/api/sdk.gen', () => ({ threadsListTurns: vi.fn() }));
const initial = useTimelineStore.getState();
beforeEach(() => {
  vi.clearAllMocks();
  forgetTranscriptBookmarks(['t']);
  useTimelineStore.setState(initial, true);
  useTimelineStore.getState().ensureThreadState({ threadId: 't' });
  useTimelineStore
    .getState()
    .hydrateOpenedThread({
      threadId: 't',
      turnsNewestFirst: [],
      historyCursor: 'older',
      readOnlyReason: null,
    });
});

/** Stores a reading identity without introducing any DOM geometry into this data-only test. */
function bookmark(rowKey: string) {
  saveTranscriptBookmark('t', {
    offset: 1200,
    follow: false,
    width: 800,
    anchor: {
      rowKey,
      itemId: null,
      block: -1,
      blockKey: null,
      textOffset: null,
      viewportY: 8,
      rowViewportY: 8,
    },
  });
}

it('falls back explicitly when an interaction disappeared, without trying turn pages', async () => {
  bookmark('interaction:missing');
  await restoreHistoryBookmark('t');
  expect(threadsListTurns).not.toHaveBeenCalled();
  expect(readTranscriptBookmark('t')).toMatchObject({
    offset: 1200,
    follow: false,
    anchor: null,
  });
});

it('retains an interaction that is still present in the runtime', async () => {
  useTimelineStore.setState((state) => ({
    threadsById: {
      ...state.threadsById,
      t: {
        ...state.threadsById.t,
        timeline: [
          { kind: 'interaction', requestId: 'r', instanceId: 'retained' },
        ],
      },
    },
  }));
  bookmark('interaction:retained');
  await restoreHistoryBookmark('t');
  expect(threadsListTurns).not.toHaveBeenCalled();
  expect(readTranscriptBookmark('t')?.anchor?.rowKey).toBe(
    'interaction:retained',
  );
});

it('does not page for a system row or a prompt that has never acquired a turn identity', async () => {
  for (const key of ['system:pending:0', 'user:pending:0']) {
    bookmark(key);
    await restoreHistoryBookmark('t');
    expect(readTranscriptBookmark('t')?.anchor).toBeNull();
  }
  expect(threadsListTurns).not.toHaveBeenCalled();
});
