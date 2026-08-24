import {
  normalizeForwardedPrefix,
  PUBLIC_BASE_PATH_TOKEN,
  renderIndexHtml,
} from './public-base-path';

describe('public base path', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['/', '/'],
    ['/codex', '/codex/'],
    ['/codex/', '/codex/'],
    ['//tools///codex//', '/tools/codex/'],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeForwardedPrefix(input)).toBe(expected);
  });

  it.each(['codex', '/codex?<script>', '/codex#fragment', '/codex\\path']) (
    'rejects unsafe value %p',
    (input) => {
      expect(normalizeForwardedPrefix(input)).toBe('/');
    },
  );

  it('replaces the runtime marker', () => {
    expect(
      renderIndexHtml(`<base href="${PUBLIC_BASE_PATH_TOKEN}">`, '/codex/'),
    ).toBe('<base href="/codex/">');
  });
});
