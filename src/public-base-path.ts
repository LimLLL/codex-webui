/** Marker kept in the built index and replaced for each HTML response. */
export const PUBLIC_BASE_PATH_TOKEN = '__CODEX_WEBUI_BASE_PATH__';

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
  if (!candidate.startsWith('/') || /["'<>?#\\]/.test(candidate)) return '/';

  const segments = candidate.split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}/` : '/';
}

/** Renders the built SPA index for the current public proxy prefix. */
export function renderIndexHtml(indexHtml: string, basePath: string): string {
  return indexHtml.replaceAll(PUBLIC_BASE_PATH_TOKEN, basePath);
}
