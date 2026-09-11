/** User decisions must match the complete displayed permission/form contract. */
import {
  encodePermissions,
  presentPermissions,
} from './permission-interaction';
import {
  encodeElicitation,
  presentElicitation,
} from './elicitation-interaction';
import {
  encodeHumanResponse,
  negativeOnlyReason,
} from './human-request-contract';

describe('permission selections', () => {
  const params = {
    cwd: '/workspace',
    environmentId: 'local',
    permissions: {
      network: { enabled: true },
      fileSystem: {
        read: ['/data'],
        write: null,
        globScanMaxDepth: 2,
        entries: [
          {
            path: { type: 'path', path: '/workspace/output' },
            access: 'write',
          },
          {
            path: { type: 'glob_pattern', pattern: '/workspace/**/*.secret' },
            access: 'deny',
          },
          {
            path: {
              type: 'special',
              value: { kind: 'project_roots', subpath: 'src' },
            },
            access: 'read',
          },
        ],
      },
    },
  };
  it('preserves special paths and deny globs while granting only explicitly selected scopes', () => {
    const prompt = presentPermissions(params);
    expect(prompt.supported).toBe(true);
    expect(prompt.permissions).toContainEqual(
      expect.objectContaining({ label: 'scope: project_roots / src' }),
    );
    expect(
      encodePermissions(params, { selected: ['entry:0'], scope: 'session' }),
    ).toEqual({
      scope: 'session',
      permissions: {
        fileSystem: {
          read: [],
          write: null,
          entries: params.permissions.fileSystem.entries.slice(0, 2),
          globScanMaxDepth: 2,
        },
      },
    });
    expect(
      encodePermissions(params, { selected: ['network'], scope: 'turn' }),
    ).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
  });
  it('cannot remove deny constraints or supply an unrequested grant', () => {
    expect(() =>
      encodePermissions(params, { selected: ['entry:1'], scope: 'turn' }),
    ).toThrow('unrequested');
    expect(() =>
      encodePermissions(params, { selected: ['write:99'], scope: 'turn' }),
    ).toThrow('unrequested');
    expect(() =>
      encodePermissions(params, {
        selected: ['entry:0'],
        scope: 'turn',
        permissions: { fileSystem: { write: ['/'] } },
      }),
    ).toThrow('Invalid');
  });
  it('unknown authorization semantics disable all granting but preserve denial', () => {
    const unknown = {
      ...params,
      permissions: { ...params.permissions, futureGrant: true },
    };
    expect(presentPermissions(unknown)).toMatchObject({
      supported: false,
      permissions: [],
    });
    expect(() =>
      encodePermissions(unknown, { selected: ['network'], scope: 'turn' }),
    ).toThrow('unknown');
    expect(
      encodePermissions(unknown, { selected: [], scope: 'session' }),
    ).toEqual({ permissions: {}, scope: 'turn' });
  });
  it('also prevents granting an unknown inline command permission overlay', () => {
    const command = {
      additionalPermissions: { network: { futurePolicy: 'allow' } },
    };
    expect(
      negativeOnlyReason('item/commandExecution/requestApproval', command),
    ).toBeTruthy();
    expect(() =>
      encodeHumanResponse('item/commandExecution/requestApproval', command, {
        decision: 'accept',
      }),
    ).toThrow('only be declined');
  });
});

describe('MCP elicitation semantics', () => {
  const params = {
    serverName: 'test',
    message: 'Input',
    mode: 'form',
    requestedSchema: {
      type: 'object',
      required: ['name', 'enabled', 'count', 'choice', 'tags'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 4 },
        enabled: { type: 'boolean' },
        count: { type: 'integer', minimum: 0, maximum: 3 },
        choice: {
          type: 'string',
          oneOf: [
            { const: 'a', title: 'A' },
            { const: 'b', title: 'B' },
          ],
        },
        tags: {
          type: 'array',
          minItems: 1,
          items: { anyOf: [{ const: 'x', title: 'X' }] },
        },
        note: { type: 'string' },
      },
    },
  };
  const content = {
    name: '名',
    enabled: false,
    count: 0,
    choice: 'b',
    tags: ['x'],
  };
  it('renders and validates the complete primitive grammar, retaining false and zero answers', () => {
    expect(presentElicitation(params)).toMatchObject({
      supported: true,
      fields: [
        expect.objectContaining({ type: 'string' }),
        expect.objectContaining({ type: 'boolean' }),
        expect.objectContaining({ type: 'integer' }),
        expect.objectContaining({ type: 'enum' }),
        expect.objectContaining({ type: 'array' }),
        expect.objectContaining({ required: false }),
      ],
    });
    expect(encodeElicitation(params, { action: 'accept', content })).toEqual({
      action: 'accept',
      content,
      _meta: null,
    });
  });
  it.each([
    { count: 0.5 },
    { name: 'too long' },
    { enabled: 'false' },
    { choice: 'unoffered' },
    { tags: [] },
    { tags: ['x', 'x'] },
    { extra: true },
  ])('rejects invalid or unrequested form contents %j', (change) => {
    expect(() =>
      encodeElicitation(params, {
        action: 'accept',
        content: { ...content, ...change },
      }),
    ).toThrow();
  });
  it.each(['openaiForm', 'openai/form'])(
    'does not partially render unknown %s semantics',
    (mode) => {
      const unknown = {
        ...params,
        mode,
        requestedSchema: { ...params.requestedSchema, 'x-openai-unknown': {} },
      };
      expect(presentElicitation(unknown)).toMatchObject({
        supported: false,
        fields: [],
      });
      expect(() =>
        encodeElicitation(unknown, { action: 'accept', content }),
      ).toThrow('unsupported');
      expect(
        encodeElicitation(unknown, { action: 'decline', content: null }),
      ).toEqual({ action: 'decline', content: null, _meta: null });
    },
  );
  it('validates URL mode without fetching or treating navigation as completion', () => {
    const url = {
      mode: 'url',
      elicitationId: 'auth',
      url: 'https://example.test/sign-in',
    };
    expect(presentElicitation(url)).toMatchObject({
      supported: true,
      url: url.url,
      fields: [],
    });
    expect(encodeElicitation(url, { action: 'accept', content: null })).toEqual(
      { action: 'accept', content: null, _meta: null },
    );
    expect(
      presentElicitation({ ...url, url: 'javascript:alert(1)' }).supported,
    ).toBe(false);
    expect(
      presentElicitation({ ...url, url: 'https://user:secret@example.test' })
        .supported,
    ).toBe(false);
  });
});
