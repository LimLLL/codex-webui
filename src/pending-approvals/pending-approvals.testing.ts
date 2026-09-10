/** Protocol fixtures for permission-bearing command approvals across both transports. */
import type { ServerRequest, v2 } from '../codex/codex-schema';

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
