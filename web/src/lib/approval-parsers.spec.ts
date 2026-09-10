/** Tests pinned command-approval discrimination and recovered-request parsing. */
import { describe, expect, it } from 'vitest';
import { parseApprovalRequest } from './approval-parsers';

describe('parseApprovalRequest', () => {
  it('preserves writeStdin identity and the callback turn', () => {
    expect(
      parseApprovalRequest({
        requestId: 42,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'current-turn',
          itemId: 'older-command-item',
          approvalId: 'approval-1',
          kind: 'writeStdin',
          reason: 'Send input?',
        },
      }),
    ).toMatchObject({
      requestId: 42,
      approvalId: 'approval-1',
      kind: 'writeStdin',
      threadId: 'thread-1',
      turnId: 'current-turn',
      itemId: 'older-command-item',
    });
  });

  it('uses persisted top-level identities when params omit them', () => {
    expect(
      parseApprovalRequest({
        requestId: 'request-1',
        method: 'item/fileChange/requestApproval',
        params: { reason: 'Apply changes?' },
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
      }),
    ).toMatchObject({
      kind: 'fileChange',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
    });
  });

  it('falls back to the command kind when the discriminator is absent', () => {
    // The protocol documents `command` as the default for servers that omit
    // `kind`. Dropping the request would block the turn on an approval the
    // user can never see or answer, so the safe degrade is the narrower card.
    expect(
      parseApprovalRequest({
        requestId: 1,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
        },
      }),
    ).toMatchObject({ requestId: 1, kind: 'command' });
  });

  it('ignores approval methods it does not model', () => {
    expect(
      parseApprovalRequest({
        requestId: 1,
        method: 'item/somethingElse/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
      }),
    ).toBeNull();
  });

  it('rejects a request that cannot be routed to a thread turn and item', () => {
    expect(
      parseApprovalRequest({
        requestId: 1,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1', kind: 'command' },
      }),
    ).toBeNull();
  });
});

describe('requested permission scopes', () => {
  /** Builds a command approval carrying one filesystem entry. */
  const withEntry = (path: unknown) =>
    parseApprovalRequest({
      requestId: 1,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        additionalPermissions: { fileSystem: { entries: [{ path, access: 'write' }] } },
      },
    })?.requestedPermissions;

  // The pinned protocol models a special path as an OBJECT union. An earlier
  // parser tested it for a string, which no variant can ever satisfy, so every
  // structured scope was discarded — and an overlay whose only entry was one
  // became null and disappeared from the card entirely.
  it('keeps a bare special scope', () => {
    expect(withEntry({ type: 'special', value: { kind: 'root' } })).toEqual({
      networkEnabled: null,
      fileSystem: [{ kind: 'special', scope: 'root', value: '', access: 'write' }],
    });
  });

  it('keeps the sub-path of a scoped special path', () => {
    expect(
      withEntry({
        type: 'special',
        value: { kind: 'project_roots', subpath: 'src/secrets' },
      })?.fileSystem,
    ).toEqual([
      { kind: 'special', scope: 'project_roots', value: 'src/secrets', access: 'write' },
    ]);
  });

  it('keeps the path of an unknown special scope rather than dropping it', () => {
    expect(
      withEntry({
        type: 'special',
        value: { kind: 'unknown', path: '/opt/thing', subpath: 'inner' },
      })?.fileSystem,
    ).toEqual([
      { kind: 'special', scope: 'unknown', value: '/opt/thing/inner', access: 'write' },
    ]);
  });

  it('still reads literal paths and glob patterns', () => {
    expect(withEntry({ type: 'path', path: '/etc/hosts' })?.fileSystem).toEqual([
      { kind: 'path', value: '/etc/hosts', access: 'write' },
    ]);
    expect(withEntry({ type: 'glob_pattern', pattern: '**/*.env' })?.fileSystem).toEqual([
      { kind: 'glob', value: '**/*.env', access: 'write' },
    ]);
  });
});
