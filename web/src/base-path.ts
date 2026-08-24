/** Public path baked into the frontend by Vite. */
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** Prefixes an application URL with the configured public base path. */
export function withBasePath(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_PATH}${normalizedPath}`;
}
