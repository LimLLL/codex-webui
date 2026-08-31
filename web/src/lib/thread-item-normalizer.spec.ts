/** Behaviour tests for the single live/history ThreadItem normalization boundary. */
import { describe, expect, it } from 'vitest';
import { normalizeThreadItem } from './thread-item-normalizer';

const knownItems: Array<[string, Record<string, unknown>]> = [
  [
    'hookPrompt',
    {
      type: 'hookPrompt',
      id: 'hook-1',
      fragments: [{ text: 'follow repository rules', hookRunId: 'run-1' }],
    },
  ],
  [
    'functionCallOutput',
    {
      type: 'functionCallOutput',
      id: 'output-1',
      name: 'lookup',
      namespace: 'tickets',
      output: [{ type: 'input_text', text: 'found' }],
    },
  ],
  [
    'dynamicToolCall',
    {
      type: 'dynamicToolCall',
      id: 'dynamic-1',
      namespace: 'tickets',
      tool: 'lookup',
      arguments: { id: 7 },
      status: 'completed',
      contentItems: [{ type: 'inputText', text: 'open' }],
      success: true,
      durationMs: 12,
    },
  ],
  [
    'collabAgentToolCall',
    {
      type: 'collabAgentToolCall',
      id: 'collab-1',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: 'parent',
      receiverThreadIds: ['child'],
      prompt: 'inspect this',
      model: 'gpt-5',
      reasoningEffort: 'high',
      agentsStates: { child: { status: 'completed', message: 'done' } },
    },
  ],
  [
    'subAgentActivity',
    {
      type: 'subAgentActivity',
      id: 'activity-1',
      kind: 'completed',
      agentThreadId: 'child',
      agentPath: '/root/child',
    },
  ],
  [
    'webSearch',
    {
      type: 'webSearch',
      id: 'search-1',
      query: 'protocol docs',
      action: { type: 'search', query: 'protocol docs', queries: null },
      results: [{ title: 'Docs', url: 'https://example.test', snippet: 'Result' }],
    },
  ],
  ['imageView', { type: 'imageView', id: 'view-1', path: '/tmp/image.png' }],
  ['sleep', { type: 'sleep', id: 'sleep-1', durationMs: 500 }],
  [
    'imageGeneration',
    {
      type: 'imageGeneration',
      id: 'image-1',
      status: 'completed',
      revisedPrompt: 'a diagram',
      result: 'data:image/png;base64,AAAA',
      transparentBackground: false,
      failure: null,
      savedPath: '/tmp/generated.png',
    },
  ],
];

describe('normalizeThreadItem', () => {
  it.each(knownItems)('normalizes %s identically for live and history paths', (type, raw) => {
    const started = normalizeThreadItem(raw, false);
    const persisted = normalizeThreadItem(raw, true);

    expect(started.kind).toBe('render');
    expect(persisted.kind).toBe('render');
    if (started.kind !== 'render' || persisted.kind !== 'render') return;
    expect(started.item.type).toBe(type);
    expect(persisted.item).toEqual({ ...started.item, completed: true });
  });

  it('turns a future item into a visible fallback without retaining its payload', () => {
    const normalized = normalizeThreadItem(
      {
        type: 'futureActivity',
        id: 'future-1',
        secretPayload: 'must never reach the page',
      },
      false,
    );

    expect(normalized).toEqual({
      kind: 'unknown',
      item: {
        type: 'unknownActivity',
        protocolType: 'futureActivity',
        itemId: 'future-1',
        completed: false,
      },
    });
    expect(JSON.stringify(normalized)).not.toContain('must never reach the page');
  });

  it('marks encrypted function output without retaining ciphertext', () => {
    const normalized = normalizeThreadItem(
      {
        type: 'functionCallOutput',
        id: 'output-1',
        name: 'secret',
        namespace: null,
        output: [
          {
            type: 'encrypted_content',
            encrypted_content: 'ciphertext must stay opaque',
          },
        ],
      },
      true,
    );

    expect(normalized.kind).toBe('render');
    if (normalized.kind !== 'render') return;
    expect(normalized.item).toMatchObject({
      type: 'functionCallOutput',
      outputParts: [{ type: 'encrypted' }],
    });
    expect(JSON.stringify(normalized)).not.toContain('ciphertext must stay opaque');
  });

  it('returns dedicated outcomes for user messages and plans', () => {
    expect(
      normalizeThreadItem(
        {
          type: 'userMessage',
          id: 'user-1',
          content: [{ type: 'text', text: 'hello' }],
        },
        true,
      ),
    ).toMatchObject({ kind: 'userMessage', message: { text: 'hello' } });
    expect(
      normalizeThreadItem(
        { type: 'plan', id: 'plan-1', text: 'step one' },
        true,
      ),
    ).toEqual({ kind: 'plan', itemId: 'plan-1', text: 'step one' });
  });
});
