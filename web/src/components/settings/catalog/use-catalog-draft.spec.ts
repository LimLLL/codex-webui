/**
 * Draft reconciliation and defensive parsing.
 *
 * `committed` is the optimistic-concurrency precondition sent with every write,
 * so it may never drift away from the content `working` was derived from —
 * otherwise a save carries a fresh precondition with stale content and the
 * backend accepts an overwrite nobody asked for.
 */
import { describe, expect, it } from 'vitest';
import { parseCatalogDocument, reconcileDraft } from './use-catalog-draft';

describe('parseCatalogDocument', () => {
  it('refuses a models array holding something that is not an entry', () => {
    // Valid JSON, and reading any field off these while rendering would throw.
    expect(parseCatalogDocument('{"models":[null]}')).toBeNull();
    expect(parseCatalogDocument('{"models":["gpt"]}')).toBeNull();
    expect(parseCatalogDocument('{"models":[[]]}')).toBeNull();
  });

  it('refuses a document without a models array, and unparseable text', () => {
    expect(parseCatalogDocument('{"models":{}}')).toBeNull();
    expect(parseCatalogDocument('{not json')).toBeNull();
    expect(parseCatalogDocument(null)).toBeNull();
  });

  it('accepts a well-formed document', () => {
    expect(parseCatalogDocument('{"models":[{"slug":"a"}]}')).toEqual({
      models: [{ slug: 'a' }],
    });
  });
});

describe('reconcileDraft', () => {
  it('adopts the server draft on first read', () => {
    expect(
      reconcileDraft({ seen: undefined, committed: null, working: null }, 'A'),
    ).toEqual({ seen: 'A', committed: 'A', working: 'A' });
  });

  it('adopts a change made elsewhere while nothing local is dirty', () => {
    expect(
      reconcileDraft({ seen: 'A', committed: 'A', working: 'A' }, 'B'),
    ).toEqual({ seen: 'B', committed: 'B', working: 'B' });
  });

  it('leaves unsaved edits alone rather than moving the precondition', () => {
    // Adopting 'B' as `committed` while `working` still derives from 'A' would
    // make the next save a precondition-satisfying overwrite of 'B'.
    expect(
      reconcileDraft({ seen: 'A', committed: 'A', working: 'A + mine' }, 'B'),
    ).toBeNull();
  });

  it('does nothing when the server content is already the one in hand', () => {
    expect(
      reconcileDraft({ seen: 'A', committed: 'A', working: 'A' }, 'A'),
    ).toBeNull();
  });

  it('adopts any differing server content once clean, including staler text', () => {
    // Deliberately pinned, because it is the reason writes must publish their
    // own result into the query cache. Reconciliation cannot tell "newer" from
    // "older" — it only sees difference — so a save that left the pre-save
    // content cached would be rolled straight back by this rule.
    expect(
      reconcileDraft({ seen: 'B', committed: 'B', working: 'B' }, 'A'),
    ).toEqual({ seen: 'A', committed: 'A', working: 'A' });
  });

  it('adopts an absent draft, so a deleted one does not linger', () => {
    expect(
      reconcileDraft({ seen: 'A', committed: 'A', working: 'A' }, null),
    ).toEqual({ seen: null, committed: null, working: null });
  });
});
