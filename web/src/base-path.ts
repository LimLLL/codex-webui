/** Public path injected into the document by the backend at request time. */
const documentBasePath = new URL(
  document.querySelector('base')?.getAttribute('href') ?? '/',
  window.location.origin,
).pathname;

export const BASE_PATH = documentBasePath.replace(/\/+$/, '');

/** Prefixes an application URL with the configured public base path. */
export function withBasePath(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_PATH}${normalizedPath}`;
}
