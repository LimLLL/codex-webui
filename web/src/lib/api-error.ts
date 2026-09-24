/** Translates standardized API error responses into user-facing messages. */
import i18n from '../i18n';

interface ApiErrorBody {
  message?: string | string[];
  errorCode?: string;
  params?: unknown;
}

/**
 * Extracts and translates an API error into a user-facing message.
 * Supports both structured errorCode responses and legacy message-only responses.
 */
export function getApiErrorMessage(
  error: unknown,
  fallback = i18n.t('Request failed'),
): string {
  if (typeof error === 'string' && error.trim()) return error;

  const body = isRecord(error) ? (error as ApiErrorBody) : undefined;
  if (body?.errorCode) {
    const msg = normalizeMessage(body.message) ?? body.errorCode;
    return i18n.t(`error.${body.errorCode}`, {
      ...sanitizeParams(body.params),
      defaultValue: msg,
    });
  }

  const message = normalizeMessage(body?.message);
  if (message) return message;

  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/**
 * Reads the structured error code, for callers that must branch on the kind of
 * failure rather than only show it. Returns undefined for legacy message-only
 * responses and for transport errors, which carry no code to branch on.
 */
export function getApiErrorCode(error: unknown): string | undefined {
  const body = isRecord(error) ? (error as ApiErrorBody) : undefined;
  return typeof body?.errorCode === 'string' ? body.errorCode : undefined;
}

function normalizeMessage(message: unknown): string | undefined {
  if (Array.isArray(message)) {
    const values = message.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
    return values.length > 0 ? values.join(', ') : undefined;
  }
  return typeof message === 'string' && message.trim() ? message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Filters params to only safe primitive values, preventing injection of i18next options. */
function sanitizeParams(params: unknown): Record<string, string | number> {
  if (!isRecord(params)) return {};
  return Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'number',
    ),
  );
}
