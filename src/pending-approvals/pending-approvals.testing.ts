/** Protocol fixtures for permission-bearing command approvals across both transports. */
import type {
  ServerNotification,
  ServerRequest,
  v2,
} from '../codex/codex-schema';

/** Includes structured path semantics and an intentionally omitted network grant. */
export function permissionApprovalFixture() {
  const params = {
    threadId: 't1',
    turnId: 'turn1',
    itemId: 'cmd1',
    kind: 'command' as const,
    environmentId: null,
    startedAtMs: 1,
    networkApprovalContext: { host: 'example.com', protocol: 'https' as const },
    additionalPermissions: {
      fileSystem: {
        read: null,
        write: null,
        entries: [
          { path: { type: 'path', path: '/workspace/data' }, access: 'write' },
          {
            path: { type: 'glob_pattern', pattern: '/workspace/**/*.secret' },
            access: 'deny',
          },
        ],
      } satisfies v2.AdditionalFileSystemPermissions,
    },
  };
  return {
    id: 17,
    method: 'item/commandExecution/requestApproval',
    params,
  } satisfies ServerRequest;
}

/** A complete two-file subject, including a rename destination inside the kind union. */
export function fileApprovalFixture(id: string | number = 31) {
  const changes = [
    {
      path: '/workspace/alpha.txt',
      kind: { type: 'update', move_path: '/workspace/renamed.txt' },
      diff: '@@\n-ALPHA\n+ALPHA_EDITED\n',
    },
    { path: '/workspace/beta.txt', kind: { type: 'delete' }, diff: '-BETA\n' },
  ] satisfies v2.FileUpdateChange[];
  return {
    changes,
    started: {
      method: 'item/started',
      params: {
        threadId: 't1',
        turnId: 'turn1',
        startedAtMs: 1,
        item: {
          id: 'patch1',
          type: 'fileChange',
          changes,
          status: 'inProgress',
        },
      },
    } satisfies ServerNotification,
    /** Same item reaching completion; the subject must survive this. */
    completed: {
      method: 'item/completed',
      params: {
        threadId: 't1',
        turnId: 'turn1',
        completedAtMs: 2,
        item: {
          id: 'patch1',
          type: 'fileChange',
          changes,
          status: 'completed',
        },
      },
    } satisfies ServerNotification,
    request: {
      id,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'patch1',
        startedAtMs: 1,
        reason: 'Review both files',
        grantRoot: null,
      },
    } satisfies ServerRequest,
  };
}
