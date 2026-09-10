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

  it('preserves structured async questions while discarding malformed entries', () => {
    const normalized = normalizeThreadItem(
      {
        type: 'agentMessage',
        id: 'agent-questions',
        text: 'Please choose.',
        questions: [
          { title: 'Deployment target', options: ['staging', 'production'] },
          { title: 'Additional details', options: null },
          { title: 42, options: ['discard me'] },
        ],
      },
      true,
    );

    expect(normalized).toMatchObject({
      kind: 'render',
      item: {
        type: 'agentMessage',
        questions: [
          { title: 'Deployment target', options: ['staging', 'production'] },
          { title: 'Additional details', options: null },
        ],
      },
    });
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

  // Measured on 0.153.2 (`codex_probe/probes/file-approval-context.ts`): one
  // `fileChange` item — and therefore one approval — carried two files. Keeping
  // only the first meant approving writes the user could not see.
  it('keeps every file in a multi-file change set', () => {
    const result = normalizeThreadItem(
      {
        type: 'fileChange',
        id: 'exec-1',
        status: 'inProgress',
        changes: [
          { path: '/w/alpha.txt', kind: { type: 'update', move_path: null }, diff: '--- a\n+++ b\n+ALPHA' },
          { path: '/w/beta.txt', kind: { type: 'add' }, diff: '+BETA' },
        ],
      },
      false,
    );

    expect(result.kind).toBe('render');
    if (result.kind !== 'render' || result.item.type !== 'fileChange') return;
    expect(result.item.fileChanges).toHaveLength(2);
    expect(result.item.fileChanges?.map((change) => change.path)).toEqual([
      '/w/alpha.txt',
      '/w/beta.txt',
    ]);
    expect(result.item.fileChanges?.[1].changeKind).toBe('add');
    // The legacy single-file fields still describe the first change so an older
    // consumer keeps working rather than rendering nothing.
    expect(result.item.filePath).toBe('/w/alpha.txt');
  });

  it('carries a rename destination, which lives only in the change kind', () => {
    const result = normalizeThreadItem(
      {
        type: 'fileChange',
        id: 'exec-2',
        status: 'inProgress',
        changes: [
          {
            path: '/w/old.txt',
            kind: { type: 'update', move_path: '/w/new.txt' },
            diff: '',
          },
        ],
      },
      false,
    );

    if (result.kind !== 'render' || result.item.type !== 'fileChange') {
      throw new Error('expected a rendered fileChange');
    }
    expect(result.item.fileChanges?.[0]).toMatchObject({
      path: '/w/old.txt',
      changeKind: 'update',
      movePath: '/w/new.txt',
    });
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
