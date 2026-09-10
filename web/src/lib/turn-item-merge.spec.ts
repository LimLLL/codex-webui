/**
 * Covers the item authority table and the ordering rules, which exist because
 * app-server persists in completion order while a client renders in start
 * order. Both behaviours were established by measurement against the pinned
 * app-server, so these cases pin the conclusions, not an implementation detail.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptsStreamedUpdate,
  currentObservationSeq,
  mergeRecoveredItems,
  nextObservationSeq,
} from './turn-item-merge';
import type { AgentMessageTurnItem, TurnItem } from '@/types/timeline';

/** Minimal message item; content and lifecycle are what the rules act on. */
function msg(
  itemId: string,
  content: string,
  completed: boolean,
  observedSeq?: number,
): AgentMessageTurnItem {
  return {
    type: 'agentMessage',
    itemId,
    content,
    questions: [],
    completed,
    ...(observedSeq !== undefined && { observedSeq }),
  };
}

const ids = (items: TurnItem[]) => items.map((item) => item.itemId);

describe('mergeRecoveredItems ordering', () => {
  it('appends persisted items the live list never saw', () => {
    const persisted = [msg('A', '', true), msg('B', '', true), msg('C', '', true)];
    const live = [msg('A', '', true, 1), msg('C', '', true, 2), msg('D', '', true, 3)];
    expect(ids(mergeRecoveredItems(persisted, live, { baselineSeq: 0 })))
      .toEqual(['A', 'B', 'C', 'D']);
  });

  it('places a persisted-only item after its persisted predecessor', () => {
    const persisted = [msg('A', '', true), msg('B', '', true), msg('C', '', true)];
    const live = [msg('A', '', true, 1), msg('X', '', false, 2), msg('C', '', true, 3)];
    expect(ids(mergeRecoveredItems(persisted, live, { baselineSeq: 0 })))
      .toEqual(['A', 'B', 'X', 'C']);
  });

  it('puts wholly disjoint persisted items before the live ones', () => {
    const persisted = [msg('A', '', true), msg('B', '', true)];
    const live = [msg('X', '', false, 1), msg('Y', '', false, 2)];
    expect(ids(mergeRecoveredItems(persisted, live, { baselineSeq: 0 })))
      .toEqual(['A', 'B', 'X', 'Y']);
  });

  it('never duplicates an item present in both lists', () => {
    const items = [msg('A', '', true), msg('B', '', true), msg('C', '', true)];
    expect(ids(mergeRecoveredItems(items, items, { baselineSeq: 0 })))
      .toEqual(['A', 'B', 'C']);
  });

  it('returns the other list untouched when either side is empty', () => {
    const live = [msg('A', 'x', false, 1)];
    const persisted = [msg('B', 'y', true)];
    expect(mergeRecoveredItems([], live, { baselineSeq: 0 })).toBe(live);
    expect(mergeRecoveredItems(persisted, [], { baselineSeq: 0 })).toBe(persisted);
  });

  it('keeps live order when persistence disagrees, since live saw the starts', () => {
    // The measured divergence: a slow item starts first but finishes last, so
    // persistence lists it second while a streaming client rendered it first.
    const persisted = [msg('QUICK', '', true), msg('SLOW', '', true)];
    const live = [msg('SLOW', '', false, 1), msg('QUICK', '', true, 2)];
    expect(ids(mergeRecoveredItems(persisted, live, { baselineSeq: 0 })))
      .toEqual(['SLOW', 'QUICK']);
  });
});

describe('mergeRecoveredItems payload authority', () => {
  it('replaces a streamed fragment with the accumulated terminal payload', () => {
    // The terminal payload carries the whole result, so this is a replacement.
    // Concatenating would yield "worldhello world".
    const persisted = [msg('A', 'hello world', true)];
    const live = [msg('A', 'world', false, 5)];
    const [merged] = mergeRecoveredItems(persisted, live, { baselineSeq: 0 });
    expect((merged as AgentMessageTurnItem).content).toBe('hello world');
    expect(merged.completed).toBe(true);
  });

  it('keeps a terminal observation that arrived while the request was in flight', () => {
    const persisted = [msg('A', 'stale', true)];
    const live = [msg('A', 'fresher', true, 9)];
    const [merged] = mergeRecoveredItems(persisted, live, { baselineSeq: 4 });
    expect((merged as AgentMessageTurnItem).content).toBe('fresher');
  });

  it('prefers the snapshot over a terminal observation that predates the request', () => {
    const persisted = [msg('A', 'authoritative', true)];
    const live = [msg('A', 'older', true, 2)];
    const [merged] = mergeRecoveredItems(persisted, live, { baselineSeq: 7 });
    expect((merged as AgentMessageTurnItem).content).toBe('authoritative');
  });

  it('lets an explicitly unfinished snapshot fill blanks only', () => {
    const persisted = [msg('A', 'snapshot text', false)];
    const live = [msg('A', 'streaming text', false, 3)];
    const [merged] = mergeRecoveredItems(persisted, live, { baselineSeq: 0 });
    expect((merged as AgentMessageTurnItem).content).toBe('streaming text');
    expect(merged.completed).toBe(false);
  });

  it('does not let a snapshot resurrect content for an item live never had', () => {
    const persisted = [msg('A', 'restored', true)];
    const live: TurnItem[] = [msg('B', 'live only', false, 1)];
    const merged = mergeRecoveredItems(persisted, live, { baselineSeq: 0 });
    expect(merged).toHaveLength(2);
    expect((merged[0] as AgentMessageTurnItem).content).toBe('restored');
  });
});

describe('acceptsStreamedUpdate', () => {
  it('accepts the first delta for an item not yet held', () => {
    expect(acceptsStreamedUpdate(undefined)).toBe(true);
  });

  it('accepts deltas while the item is still streaming', () => {
    expect(acceptsStreamedUpdate(msg('A', 'partial', false))).toBe(true);
  });

  it('refuses a delta that arrives after the terminal payload', () => {
    expect(acceptsStreamedUpdate(msg('A', 'final', true))).toBe(false);
  });
});

describe('observation counter', () => {
  it('advances only on request and is readable without advancing', () => {
    const before = currentObservationSeq();
    expect(currentObservationSeq()).toBe(before);
    const stamped = nextObservationSeq();
    expect(stamped).toBeGreaterThan(before);
    expect(currentObservationSeq()).toBe(stamped);
  });
});
