/** Pure normalization from app-server ThreadItem payloads to the UI timeline union. */
import type {
  DynamicToolOutputPart,
  FunctionCallOutputPart,
  TurnItem,
  WebSearchAction,
  WebSearchResultPreview,
} from '@/types/timeline';

export interface NormalizedUserMessage {
  itemId: string;
  text: string;
  images: string[];
}

/** Explicit result keeps dedicated and future protocol items out of silent null paths. */
export type ThreadItemNormalization =
  | { kind: 'render'; item: TurnItem }
  | { kind: 'unknown'; item: Extract<TurnItem, { type: 'unknownActivity' }> }
  | { kind: 'userMessage'; message: NormalizedUserMessage }
  | { kind: 'plan'; itemId: string; text: string }
  | { kind: 'invalid' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** JSON display helper; protocol values are JSON, but malformed input must not throw. */
function displayJson(value: unknown, limit?: number): string {
  if (value === undefined || value === null) return '';
  try {
    const text = JSON.stringify(value, null, 2) ?? '';
    return limit === undefined ? text : text.slice(0, limit);
  } catch {
    return '';
  }
}

function safeMediaUrl(value: unknown, media: 'image' | 'audio'): string {
  if (typeof value !== 'string') return '';
  if (/^https?:\/\//i.test(value)) return value;
  const prefix = media === 'image' ? /^data:image\//i : /^data:audio\//i;
  return prefix.test(value) ? value : '';
}

function normalizeUserMessage(
  item: Record<string, unknown>,
  itemId: string,
): NormalizedUserMessage {
  const text: string[] = [];
  const images: string[] = [];
  if (Array.isArray(item.content)) {
    for (const value of item.content) {
      const block = asRecord(value);
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        text.push(block.text);
      } else if (
        block.type === 'localImage' &&
        typeof block.path === 'string'
      ) {
        images.push(block.path);
      } else if (block.type === 'image' && typeof block.url === 'string') {
        images.push(block.url);
      }
    }
  }
  return {
    itemId,
    text: text.join('\n') || stringValue(item.text),
    images,
  };
}

function normalizeFunctionOutput(output: unknown): {
  textOutput: string | null;
  outputParts: FunctionCallOutputPart[];
} {
  if (typeof output === 'string') {
    return { textOutput: output, outputParts: [] };
  }
  if (!Array.isArray(output)) return { textOutput: null, outputParts: [] };

  const outputParts: FunctionCallOutputPart[] = [];
  for (const value of output) {
    const part = asRecord(value);
    if (!part) continue;
    switch (part.type) {
      case 'input_text':
        outputParts.push({ type: 'text', text: stringValue(part.text) });
        break;
      case 'input_image':
        outputParts.push({
          type: 'image',
          imageUrl: safeMediaUrl(part.image_url, 'image'),
          detail: nullableString(part.detail),
        });
        break;
      case 'input_audio':
        outputParts.push({
          type: 'audio',
          audioUrl: safeMediaUrl(part.audio_url, 'audio'),
        });
        break;
      case 'encrypted_content':
        // The ciphertext is intentionally not copied into the internal model.
        outputParts.push({ type: 'encrypted' });
        break;
    }
  }
  return { textOutput: null, outputParts };
}

function normalizeDynamicOutput(value: unknown): DynamicToolOutputPart[] {
  if (!Array.isArray(value)) return [];
  const parts: DynamicToolOutputPart[] = [];
  for (const raw of value) {
    const part = asRecord(raw);
    if (!part) continue;
    if (part.type === 'inputText') {
      parts.push({ type: 'text', text: stringValue(part.text) });
    } else if (part.type === 'inputImage') {
      parts.push({
        type: 'image',
        imageUrl: safeMediaUrl(part.imageUrl, 'image'),
      });
    } else if (part.type === 'inputAudio') {
      parts.push({
        type: 'audio',
        audioUrl: safeMediaUrl(part.audioUrl, 'audio'),
      });
    }
  }
  return parts;
}

function normalizeWebAction(value: unknown): WebSearchAction | null {
  const action = asRecord(value);
  if (!action || typeof action.type !== 'string') return null;
  switch (action.type) {
    case 'search':
      return {
        type: 'search',
        query: nullableString(action.query),
        queries: Array.isArray(action.queries)
          ? action.queries.filter((entry): entry is string => typeof entry === 'string')
          : [],
      };
    case 'openPage':
      return { type: 'openPage', url: nullableString(action.url) };
    case 'findInPage':
      return {
        type: 'findInPage',
        url: nullableString(action.url),
        pattern: nullableString(action.pattern),
      };
    case 'other':
      return { type: 'other' };
    default:
      return null;
  }
}

function normalizeWebResults(value: unknown): WebSearchResultPreview[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).flatMap((entry) => {
    const result = asRecord(entry);
    if (!result) return [];
    const preview = {
      title: nullableString(result.title),
      url: nullableString(result.url),
      snippet:
        nullableString(result.snippet) ?? nullableString(result.text),
    };
    return preview.title || preview.url || preview.snippet ? [preview] : [];
  });
}

/**
 * Normalizes one live or persisted ThreadItem without retaining unknown payloads.
 *
 * @param value - Raw item from history or an item lifecycle notification
 * @param completed - Lifecycle state supplied by the caller
 * @param fallbackItemId - Notification or page-local identity when `id` is absent
 */
export function normalizeThreadItem(
  value: unknown,
  completed: boolean,
  fallbackItemId = '',
): ThreadItemNormalization {
  const item = asRecord(value);
  if (!item || typeof item.type !== 'string') return { kind: 'invalid' };
  const itemId = stringValue(item.id, fallbackItemId);

  if (item.type === 'userMessage') {
    return {
      kind: 'userMessage',
      message: normalizeUserMessage(item, itemId),
    };
  }
  if (item.type === 'plan') {
    return {
      kind: 'plan',
      itemId,
      text: stringValue(item.text),
    };
  }
  if (!itemId) return { kind: 'invalid' };

  const base = { itemId, completed };
  switch (item.type) {
    case 'reasoning': {
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const content = Array.isArray(item.content)
        ? item.content.filter((entry): entry is string => typeof entry === 'string')
        : [];
      return {
        kind: 'render',
        item: { ...base, type: 'reasoning', content: [...summary, ...content].join('\n') },
      };
    }
    case 'agentMessage':
      return {
        kind: 'render',
        item: { ...base, type: 'agentMessage', content: stringValue(item.text) },
      };
    case 'mcpToolCall': {
      const result = asRecord(item.result);
      const error = asRecord(item.error);
      return {
        kind: 'render',
        item: {
          ...base,
          type: 'mcpToolCall',
          content: result?.content
            ? displayJson(result.content, 500)
            : stringValue(error?.message),
          toolServer: stringValue(item.server),
          toolName: stringValue(item.tool),
          toolArgs: displayJson(item.arguments),
        },
      };
    }
    case 'commandExecution':
      return {
        kind: 'render',
        item: {
          ...base,
          type: 'commandExecution',
          content: stringValue(item.aggregatedOutput, stringValue(item.text)),
          command: nullableString(item.command) ?? undefined,
          exitCode: nullableNumber(item.exitCode) ?? undefined,
        },
      };
    case 'fileChange': {
      const first = Array.isArray(item.changes) ? asRecord(item.changes[0]) : null;
      return {
        kind: 'render',
        item: {
          ...base,
          type: 'fileChange',
          content: stringValue(item.text),
          filePath: nullableString(first?.path) ?? undefined,
          fileDiff: nullableString(first?.diff) ?? '',
        },
      };
    }
    case 'contextCompaction':
      return { kind: 'render', item: { ...base, type: 'contextCompaction', content: '' } };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return {
        kind: 'render',
        item: { ...base, type: item.type, content: stringValue(item.review) },
      };
    case 'hookPrompt':
      return {
        kind: 'render',
        item: {
          ...base,
          type: 'hookPrompt',
          fragments: Array.isArray(item.fragments)
            ? item.fragments.flatMap((value) => {
                const fragment = asRecord(value);
                return fragment
                  ? [{ text: stringValue(fragment.text), hookRunId: stringValue(fragment.hookRunId) }]
                  : [];
              })
            : [],
        },
      };
    case 'functionCallOutput': {
      const output = normalizeFunctionOutput(item.output);
      return {
        kind: 'render',
        item: {
          ...base,
          type: 'functionCallOutput',
          name: stringValue(item.name),
          namespace: nullableString(item.namespace),
          ...output,
        },
      };
    }
    case 'dynamicToolCall':
      return {
        kind: 'render',
        item: {
          ...base,
          type: 'dynamicToolCall',
          namespace: nullableString(item.namespace),
          tool: stringValue(item.tool),
          toolArgs: displayJson(item.arguments),
          status: stringValue(item.status),
          contentItems: normalizeDynamicOutput(item.contentItems),
          success: nullableBoolean(item.success),
          durationMs: nullableNumber(item.durationMs),
        },
      };
    case 'collabAgentToolCall': {
      const states = asRecord(item.agentsStates);
      return {
        kind: 'render',
        item: {
          ...base,
          type: 'collabAgentToolCall',
          tool: stringValue(item.tool),
          status: stringValue(item.status),
          senderThreadId: stringValue(item.senderThreadId),
          receiverThreadIds: Array.isArray(item.receiverThreadIds)
            ? item.receiverThreadIds.filter((entry): entry is string => typeof entry === 'string')
            : [],
          prompt: nullableString(item.prompt),
          model: nullableString(item.model),
          reasoningEffort: nullableString(item.reasoningEffort),
          agentStates: states
            ? Object.entries(states).flatMap(([threadId, value]) => {
                const state = asRecord(value);
                return state
                  ? [{ threadId, status: stringValue(state.status), message: nullableString(state.message) }]
                  : [];
              })
            : [],
        },
      };
    }
    case 'subAgentActivity': {
      const kind = item.kind;
      if (
        kind !== 'started' &&
        kind !== 'interacted' &&
        kind !== 'interrupted' &&
        kind !== 'completed'
      ) {
        return { kind: 'invalid' };
      }
      return {
        kind: 'render',
        item: {
          ...base,
          type: 'subAgentActivity',
          activityKind: kind,
          agentThreadId: stringValue(item.agentThreadId),
          agentPath: stringValue(item.agentPath),
        },
      };
    }
    case 'webSearch':
      return {
        kind: 'render',
        item: {
          ...base,
          type: 'webSearch',
          query: stringValue(item.query),
          action: normalizeWebAction(item.action),
          resultCount: Array.isArray(item.results) ? item.results.length : null,
          resultPreviews: normalizeWebResults(item.results),
        },
      };
    case 'imageView':
      return { kind: 'render', item: { ...base, type: 'imageView', path: stringValue(item.path) } };
    case 'sleep':
      return {
        kind: 'render',
        item: { ...base, type: 'sleep', durationMs: Math.max(0, nullableNumber(item.durationMs) ?? 0) },
      };
    case 'imageGeneration': {
      const result = stringValue(item.result);
      const previewUrl = safeMediaUrl(result, 'image') || null;
      const failure = asRecord(item.failure);
      return {
        kind: 'render',
        item: {
          ...base,
          type: 'imageGeneration',
          status: stringValue(item.status),
          revisedPrompt: nullableString(item.revisedPrompt),
          previewUrl,
          hasUnpreviewableResult: Boolean(result) && !previewUrl,
          transparentBackground: nullableBoolean(item.transparentBackground),
          savedPath: nullableString(item.savedPath),
          failure: failure
            ? {
                type: stringValue(failure.type, 'unknown'),
                limitId: nullableString(failure.limitId),
                resetsAt: nullableNumber(failure.resetsAt),
              }
            : null,
        },
      };
    }
    default:
      return {
        kind: 'unknown',
        item: {
          ...base,
          type: 'unknownActivity',
          protocolType: item.type,
        },
      };
  }
}

/** Preserves streamed fields when a final lifecycle payload omits them. */
export function mergeTurnItem(
  existing: TurnItem | undefined,
  incoming: TurnItem,
): TurnItem {
  if (!existing || existing.type !== incoming.type) return incoming;
  switch (incoming.type) {
    case 'reasoning':
      return existing.type === 'reasoning' && !incoming.content
        ? { ...incoming, content: existing.content }
        : incoming;
    case 'agentMessage':
      return existing.type === 'agentMessage' && !incoming.content
        ? { ...incoming, content: existing.content }
        : incoming;
    case 'commandExecution':
      return existing.type === 'commandExecution'
        ? {
            ...incoming,
            content: incoming.content || existing.content,
            command: incoming.command ?? existing.command,
            exitCode: incoming.exitCode ?? existing.exitCode,
          }
        : incoming;
    case 'mcpToolCall':
      return existing.type === 'mcpToolCall'
        ? {
            ...incoming,
            content: incoming.content || existing.content,
            toolProgress: incoming.toolProgress ?? existing.toolProgress,
          }
        : incoming;
    case 'fileChange':
      return existing.type === 'fileChange'
        ? {
            ...incoming,
            content: incoming.content || existing.content,
            filePath: incoming.filePath ?? existing.filePath,
            fileDiff: incoming.fileDiff || existing.fileDiff,
          }
        : incoming;
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return existing.type === incoming.type && !incoming.content
        ? { ...incoming, content: existing.content }
        : incoming;
    default:
      return incoming;
  }
}
