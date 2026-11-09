/** Marker kept in the built index and replaced for each HTML response. */
export const PUBLIC_BASE_PATH_TOKEN = '__CODEX_WEBUI_BASE_PATH__';

const UNSAFE_PREFIX_CHARS = /["'<>?#\\]/;

function normalizeSegments(candidate: string): string {
  const segments = candidate.split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}/` : '/';
}

/**
 * Normalizes a trusted reverse-proxy prefix for use in an HTML base href.
 * Invalid values fall back to the domain root instead of entering the page.
 */
export function normalizeForwardedPrefix(
  header: string | string[] | undefined,
): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const candidate = raw?.split(',', 1)[0]?.trim();
  if (!candidate || candidate === '/') return '/';
  if (!candidate.startsWith('/') || UNSAFE_PREFIX_CHARS.test(candidate)) {
    return '/';
  }
  return normalizeSegments(candidate);
}

/** True when the header carries a prefix that can be safely used. */
export function isValidForwardedPrefix(
  header: string | string[] | undefined,
): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  const candidate = raw?.split(',', 1)[0]?.trim();
  if (!candidate) return false;
  if (candidate === '/') return true;
  return candidate.startsWith('/') && !UNSAFE_PREFIX_CHARS.test(candidate);
}

/**
 * Normalizes the startup `CODEX_WEBUI_BASE_PATH` fallback. Unlike a proxy
 * header this value is trusted, so a missing leading slash is tolerated.
 */
export function normalizeConfiguredBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '.' || trimmed === '/') return '/';
  const candidate = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (UNSAFE_PREFIX_CHARS.test(candidate)) return '/';
  return normalizeSegments(candidate);
}

/**
 * Resolves the browser-facing prefix.
 * Priority: `X-Forwarded-Prefix` > `CODEX_WEBUI_BASE_PATH` > root.
 */
export function resolveBasePath(options: {
  forwardedPrefix: string | string[] | undefined;
  configuredBasePath: string;
}): string {
  if (isValidForwardedPrefix(options.forwardedPrefix)) {
    return normalizeForwardedPrefix(options.forwardedPrefix);
  }
  return options.configuredBasePath;
}

/** Renders the built SPA index for the current public proxy prefix. */
export function renderIndexHtml(indexHtml: string, basePath: string): string {
  return indexHtml.replaceAll(PUBLIC_BASE_PATH_TOKEN, basePath);
}
