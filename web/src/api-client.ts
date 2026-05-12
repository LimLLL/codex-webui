/** Configures the Hey API generated client with auth and error handling. */
import { client } from './generated/api/client.gen';
import { getApiToken, clearApiToken } from './auth-token';
import { showSnackbar } from './stores/snackbar-store';
import i18n from './i18n';

/** HMR-safe guard — bound to the client instance, survives module reload. */
const clientAny = client as Record<string, unknown>;

/** Call once at app startup. Idempotent — safe to call during HMR. */
export function configureApiClient() {
  if (clientAny.__codexWebuiConfigured) return;
  clientAny.__codexWebuiConfigured = true;

  client.interceptors.request.use((request) => {
    if (request.url.includes('/api/auth/login')) return request;
    const token = getApiToken();
    if (token) {
      request.headers.set('Authorization', `Bearer ${token}`);
    }
    return request;
  });

  client.interceptors.response.use((response) => {
    if (response.status === 401) {
      clearApiToken();
      window.dispatchEvent(new Event('codex-webui:auth-expired'));
    }
    return response;
  });

  client.interceptors.error.use((error, response, _request, options) => {
    // Skip aborted requests (page refresh, component unmount, cancelled queries)
    const errName = error instanceof Error ? error.name : (error as { name?: string })?.name;
    const errMsg = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    if (errName === 'AbortError' || errMsg.includes('abort')) return error;

    // Skip snackbar for 401 (handled by auth flow) and explicit silent requests
    const meta = (options as unknown as { meta?: Record<string, unknown> } | undefined)?.meta;
    if (response?.status === 401 || meta?.silent) {
      return error;
    }

    // String error — show directly
    if (typeof error === 'string' && error.trim()) {
      showSnackbar(error, 'error');
      return error;
    }

    // Extract error message from API error shape
    const apiError = error as { message?: string | string[] } | undefined;
    let message = i18n.t('Request failed');
    if (apiError?.message) {
      message = Array.isArray(apiError.message)
        ? apiError.message.join(', ')
        : apiError.message;
    } else if (response?.status) {
      message = i18n.t('Request failed ({{status}})', { status: response.status });
    }

    showSnackbar(message, 'error');
    return error;
  });
}
