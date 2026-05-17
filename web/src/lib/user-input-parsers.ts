/**
 * Parsers for Codex item/tool/requestUserInput server requests.
 * Defensively handles untrusted payloads to prevent UI crashes.
 */
import type { PendingServerRequestDto } from '@/generated/api';
import type {
  UserInputOption,
  UserInputQuestion,
  UserInputRequest,
} from '@/types/approval';

/** Parses one option, returning null for malformed data. */
function parseOption(value: unknown): UserInputOption | null {
  if (!value || typeof value !== 'object') return null;
  const opt = value as Record<string, unknown>;
  if (typeof opt.label !== 'string') return null;
  return {
    label: opt.label,
    description: typeof opt.description === 'string' ? opt.description : '',
  };
}

/** Parses the questions array from a requestUserInput payload. */
export function parseUserInputQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item): UserInputQuestion | null => {
      if (!item || typeof item !== 'object') return null;
      const q = item as Record<string, unknown>;
      if (
        typeof q.id !== 'string' ||
        typeof q.header !== 'string' ||
        typeof q.question !== 'string'
      ) {
        return null;
      }

      const parsedOptions = Array.isArray(q.options)
        ? q.options
            .map(parseOption)
            .filter((o): o is UserInputOption => o !== null)
        : null;

      return {
        id: q.id,
        header: q.header,
        question: q.question,
        isOther: Boolean(q.isOther),
        isSecret: Boolean(q.isSecret),
        options: parsedOptions?.length ? parsedOptions : null,
      };
    })
    .filter((q): q is UserInputQuestion => q !== null);
}

/** Builds a UserInputRequest from a persisted PendingServerRequestDto (hydration). */
export function userInputFromPending(
  request: PendingServerRequestDto,
): UserInputRequest | null {
  if (request.method !== 'item/tool/requestUserInput') return null;
  const params = request.params;
  const turnId = typeof params.turnId === 'string' ? params.turnId : request.turnId;
  const itemId = typeof params.itemId === 'string' ? params.itemId : request.itemId;
  if (!turnId || !itemId) return null;

  const questions = parseUserInputQuestions(params.questions);
  if (questions.length === 0) return null;

  return {
    requestId: request.requestId,
    kind: 'userInput',
    threadId: request.threadId,
    turnId,
    itemId,
    status: request.status === 'resolved' ? 'resolved' : 'pending',
    questions,
  };
}

/** Builds a UserInputRequest from a live socket serverRequest event. */
export function userInputFromSocket(request: {
  id: number | string;
  params: Record<string, unknown>;
}): UserInputRequest | null {
  const { params } = request;
  if (
    typeof params.threadId !== 'string' ||
    typeof params.turnId !== 'string' ||
    typeof params.itemId !== 'string'
  ) {
    return null;
  }

  const questions = parseUserInputQuestions(params.questions);
  if (questions.length === 0) return null;

  return {
    requestId: request.id,
    kind: 'userInput',
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    status: 'pending',
    questions,
  };
}
