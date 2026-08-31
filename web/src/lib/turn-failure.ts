/** Pure normalization and merge helpers for live and persisted terminal errors. */
import type { PersistedTurnErrorDto } from '@/generated/api';
import type { TurnFailure } from '@/types/timeline';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Reads the discriminator of string and object `codexErrorInfo` variants. */
function errorCategory(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return record ? (Object.keys(record)[0] ?? null) : null;
}

/** Normalizes a client-projected app-server error; no steering field is read. */
export function normalizeLiveTurnFailure(
  turnId: string,
  value: unknown,
): TurnFailure {
  const error = asRecord(value);
  const misalignment = asRecord(error?.misalignment);
  return {
    turnId,
    message: nullableString(error?.message) ?? 'Unknown error',
    errorCategory: errorCategory(error?.codexErrorInfo),
    additionalDetails: nullableString(error?.additionalDetails),
    misalignmentErrorType: nullableString(misalignment?.errorType),
    misalignmentExplanation: nullableString(
      misalignment?.detailedExplanation,
    ),
  };
}

/** Converts the authenticated persistence response into the same UI shape. */
export function normalizePersistedTurnFailure(
  value: PersistedTurnErrorDto,
): TurnFailure {
  return {
    turnId: value.turnId,
    message: value.message,
    errorCategory: value.errorCategory,
    additionalDetails: value.additionalDetails,
    misalignmentErrorType: value.misalignmentErrorType,
    misalignmentExplanation: value.misalignmentExplanation,
  };
}

/** Keeps richer earlier detail when a later terminal summary is sparse. */
export function mergeTurnFailure(
  existing: TurnFailure | undefined,
  incoming: TurnFailure,
): TurnFailure {
  if (!existing) return incoming;
  return {
    turnId: incoming.turnId,
    message: incoming.message || existing.message,
    errorCategory: incoming.errorCategory ?? existing.errorCategory,
    additionalDetails:
      incoming.additionalDetails ?? existing.additionalDetails,
    misalignmentErrorType:
      incoming.misalignmentErrorType ?? existing.misalignmentErrorType,
    misalignmentExplanation:
      incoming.misalignmentExplanation ?? existing.misalignmentExplanation,
  };
}
