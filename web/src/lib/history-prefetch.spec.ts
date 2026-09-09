import { describe, expect, it } from 'vitest';
import { PREFETCH_OLDER_PX, shouldPrefetchOlder } from './history-prefetch';

const base = {
  scrollTop: 0,
  previousScrollTop: PREFETCH_OLDER_PX * 2,
  hasCursor: true,
  loading: false,
};

describe('shouldPrefetchOlder', () => {
  it('fetches when scrolling up into the margin', () => {
    expect(shouldPrefetchOlder(base)).toBe(true);
  });

  it('does not fetch while moving down, which is what every deliberate write does', () => {
    // Landing on open, returning to latest, following an append and the anchor
    // restoration after a prepend all move the offset down or leave it put. A
    // proximity-only test would fetch a page on each of them — and returning to
    // the latest message in a short transcript would page in history nobody
    // asked for.
    expect(
      shouldPrefetchOlder({ ...base, scrollTop: 40, previousScrollTop: 0 }),
    ).toBe(false);
    expect(
      shouldPrefetchOlder({ ...base, scrollTop: 40, previousScrollTop: 40 }),
    ).toBe(false);
  });

  it('does not fetch while still far from the top', () => {
    expect(
      shouldPrefetchOlder({
        ...base,
        scrollTop: PREFETCH_OLDER_PX + 1,
        previousScrollTop: PREFETCH_OLDER_PX * 3,
      }),
    ).toBe(false);
  });

  it('does not fetch without a cursor or with a page already in flight', () => {
    expect(shouldPrefetchOlder({ ...base, hasCursor: false })).toBe(false);
    expect(shouldPrefetchOlder({ ...base, loading: true })).toBe(false);
  });
});
