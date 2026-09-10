/**
 * Pins the open-path reconciliation. The first case is the reported bug:
 * refreshing during a running turn erased what the agent had already produced,
 * because the open response replaced a timeline that concurrent notifications
 * had already written into.
 */
import { describe, expect, it } from 'vitest';
import { reconcileTimeline, sharesHistory } from './timeline-reconcile';
import type { TimelineEntry, TurnItem } from '@/types/timeline';

function item(itemId: string, content: string, completed = true): TurnItem {
  return { type: 'agentMessage', itemId, content, questions: [], completed };
}

function turn(
  turnId: string,
  items: TurnItem[] = [],
  overrides: Partial<Extract<TimelineEntry, { kind: 'turn' }>> = {},
): TimelineEntry {
  return { kind: 'turn', turnId, items, completed: true, ...overrides };
}

const shape = (entries: TimelineEntry[]) =>
  entries.map((e) =>
    e.kind === 'system' ? 'system' : `${e.kind}:${e.turnId}`,
  );

describe('reconcileTimeline', () => {
  it('keeps live entries a not-yet-hydrated open would have replaced', () => {
    // Notifications for the running turn landed before the open response did.
    const live = [
      turn('T3', [item('a', 'thinking', false)], { completed: false }),
    ];
    const page = [turn('T1'), turn('T2')];
    expect(shape(reconcileTimeline(page, live))).toEqual([
      'turn:T1',
      'turn:T2',
      'turn:T3',
    ]);
  });

  it('merges a shared turn instead of duplicating it', () => {
    const live = [
      turn('T1', [item('a', 'live text', false)], { completed: false }),
    ];
    const page = [turn('T1', [item('a', 'final text'), item('b', 'restored')])];
    const merged = reconcileTimeline(page, live);
    expect(shape(merged)).toEqual(['turn:T1']);
    const entry = merged[0];
    if (entry.kind !== 'turn') throw new Error('expected a turn entry');
    expect(entry.items.map((i) => i.itemId)).toEqual(['a', 'b']);
    // The persisted terminal payload repairs the streamed fragment.
    expect((entry.items[0] as { content: string }).content).toBe('final text');
    // Either side reporting completion settles the turn.
    expect(entry.completed).toBe(true);
  });

  it('appends page turns the live timeline has never seen after the overlap', () => {
    const live = [turn('T1'), turn('T2')];
    const page = [turn('T2'), turn('T3')];
    expect(shape(reconcileTimeline(page, live))).toEqual([
      'turn:T1',
      'turn:T2',
      'turn:T3',
    ]);
  });

  it('keeps the richer detail level when the page is only a summary', () => {
    const live = [turn('T1', [item('a', 'x')], { itemsView: 'full' })];
    const page = [turn('T1', [], { itemsView: 'summary' })];
    const entry = reconcileTimeline(page, live)[0];
    if (entry.kind !== 'turn') throw new Error('expected a turn entry');
    expect(entry.itemsView).toBe('full');
    expect(entry.items).toHaveLength(1);
  });

  it('does not collapse a turn’s user entry into its turn entry', () => {
    const live: TimelineEntry[] = [
      { kind: 'user', content: 'hello', turnId: 'T1' },
      turn('T1', [item('a', 'reply')]),
    ];
    const page: TimelineEntry[] = [
      { kind: 'user', content: 'hello', turnId: 'T1' },
      turn('T1', [item('a', 'reply')]),
    ];
    expect(shape(reconcileTimeline(page, live))).toEqual([
      'user:T1',
      'turn:T1',
    ]);
  });

  it('returns the other side untouched when either is empty', () => {
    const live = [turn('T1')];
    const page = [turn('T2')];
    expect(reconcileTimeline([], live)).toBe(live);
    expect(reconcileTimeline(page, [])).toBe(page);
  });

  // The case above gives both sides the same row kinds for the shared turn,
  // which is why it passed while reconciliation was losing rows. These two are
  // asymmetric, and each reproduced a real defect.

  it('keeps a row only the page has for a turn the live timeline knows', () => {
    // The user message was persisted but this client never rendered it — the
    // turn counted as "already represented", so the row was dropped entirely.
    const live = [turn('T1', [item('a', 'reply')])];
    const page: TimelineEntry[] = [
      { kind: 'user', content: 'hello', turnId: 'T1' },
      turn('T1', [item('a', 'reply')]),
    ];
    expect(shape(reconcileTimeline(page, live))).toEqual([
      'user:T1',
      'turn:T1',
    ]);
  });

  it('emits a trailing turn once, not once per row of its anchor', () => {
    // The page introduces T2 after a shared T1 that contributes two rows. The
    // trailing group used to be re-emitted after each of them.
    const live: TimelineEntry[] = [
      { kind: 'user', content: 'hello', turnId: 'T1' },
      turn('T1', [item('a', 'reply')]),
    ];
    const page: TimelineEntry[] = [
      { kind: 'user', content: 'hello', turnId: 'T1' },
      turn('T1', [item('a', 'reply')]),
      { kind: 'user', content: 'again', turnId: 'T2' },
      turn('T2', [item('b', 'second')]),
    ];
    expect(shape(reconcileTimeline(page, live))).toEqual([
      'user:T1',
      'turn:T1',
      'user:T2',
      'turn:T2',
    ]);
  });
});

describe('sharesHistory', () => {
  it('detects an overlapping window', () => {
    expect(
      sharesHistory([turn('T2'), turn('T3')], [turn('T1'), turn('T2')]),
    ).toBe(true);
  });

  it('reports disconnected windows, which must not be interleaved', () => {
    expect(
      sharesHistory([turn('T8'), turn('T9')], [turn('T1'), turn('T2')]),
    ).toBe(false);
  });
});
