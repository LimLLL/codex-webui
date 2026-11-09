import {
  isValidForwardedPrefix,
  normalizeConfiguredBasePath,
  normalizeForwardedPrefix,
  PUBLIC_BASE_PATH_TOKEN,
  renderIndexHtml,
  resolveBasePath,
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

  it.each(['codex', '/codex?<script>', '/codex#fragment', '/codex\\path'])(
    'rejects unsafe value %p',
    (input) => {
      expect(normalizeForwardedPrefix(input)).toBe('/');
    },
  );

  it.each([
    [undefined, false],
    ['', false],
    ['/', true],
    ['/codex', true],
    ['codex', false],
    ['/codex?<script>', false],
  ])('validates forwarded prefix %p as %p', (input, expected) => {
    expect(isValidForwardedPrefix(input)).toBe(expected);
  });

  it.each([
    [undefined, '/'],
    ['', '/'],
    ['.', '/'],
    ['/', '/'],
    ['codex', '/codex/'],
    ['/codex', '/codex/'],
    ['//tools///codex//', '/tools/codex/'],
  ])('normalizes configured base %p to %p', (input, expected) => {
    expect(normalizeConfiguredBasePath(input)).toBe(expected);
  });

  it.each([
    [{ forwardedPrefix: '/proxy', configuredBasePath: '/env/' }, '/proxy/'],
    [{ forwardedPrefix: '/', configuredBasePath: '/env/' }, '/'],
    [
      {
        forwardedPrefix: 'invalid',
        configuredBasePath: '/env/',
      },
      '/env/',
    ],
    [{ forwardedPrefix: undefined, configuredBasePath: '/env/' }, '/env/'],
    [{ forwardedPrefix: undefined, configuredBasePath: '/' }, '/'],
  ])('resolves %# to %p', (options, expected) => {
    expect(resolveBasePath(options)).toBe(expected);
  });

  it('replaces the runtime marker', () => {
    expect(
      renderIndexHtml(`<base href="${PUBLIC_BASE_PATH_TOKEN}">`, '/codex/'),
    ).toBe('<base href="/codex/">');
  });
});
