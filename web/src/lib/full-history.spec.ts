/** First-page readiness distinguishes legitimate pagination from missing item coverage. */
import { expect, it } from 'vitest';
import type { ThreadTurnsPageDto, TurnDto } from '@/generated/api';
import { assertFullHistoryPage } from './full-history';

function turn(
  itemsView: TurnDto['itemsView'],
  status: TurnDto['status'] = 'completed',
): TurnDto {
  return {
    id: 'turn',
    itemsView,
    status,
    items: [],
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

it('accepts empty history and a short full page that still has older turns', () => {
  expect(() =>
    assertFullHistoryPage({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    }),
  ).not.toThrow();
  expect(() =>
    assertFullHistoryPage({
      data: [turn('full')],
      nextCursor: 'older',
      backwardsCursor: 'newer',
    }),
  ).not.toThrow();
});

it('accepts currently persisted full items in a running turn without waiting for execution', () => {
  expect(() =>
    assertFullHistoryPage({
      data: [turn('full', 'inProgress')],
      nextCursor: null,
      backwardsCursor: null,
    }),
  ).not.toThrow();
});

it('rejects summary/not-loaded and malformed pages rather than displaying provisional transcript content', () => {
  for (const view of ['summary', 'notLoaded'] as const) {
    expect(() =>
      assertFullHistoryPage({
        data: [turn(view)],
        nextCursor: null,
        backwardsCursor: null,
      }),
    ).toThrow('Full conversation history');
  }
  expect(() => assertFullHistoryPage({} as ThreadTurnsPageDto)).toThrow(
    'Full conversation history',
  );
});
