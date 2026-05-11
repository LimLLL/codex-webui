/** Manages the WebUI API key for REST and WebSocket authentication. */

const STORAGE_KEY = 'codex.webui.apiKey';

/** Returns the stored API key, or null if not yet set. */
export function getApiToken(): string | null {
  return (
    sessionStorage.getItem(STORAGE_KEY) ??
    localStorage.getItem(STORAGE_KEY)
  );
}

/** Stores the API key in session storage. */
export function setApiToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token);
}

/** Clears the stored API key. */
export function clearApiToken(): void {
  sessionStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(STORAGE_KEY);
}

/** Returns the Authorization header value, or null if no token. */
export function getAuthorizationHeader(): string | null {
  const token = getApiToken();
  return token ? `Bearer ${token}` : null;
}
