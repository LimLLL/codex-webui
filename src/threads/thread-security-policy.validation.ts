/** Strict validation for the small policy patch accepted by this REST boundary. */
import { isAbsolute } from 'node:path';
import type { v2 } from '../codex/codex-schema';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import type { PatchThreadSecurityPolicyDto } from './dto/thread-security-policy.dto';

/** Throws a field-specific error rather than letting upstream silently ignore it. */
function invalid(field: string): never {
  throw BusinessException.badRequest(
    ErrorCode.validation.fieldInvalid,
    `Invalid security policy field: ${field}`,
    { field },
  );
}

/** Requires an object with exactly the supported keys; nested typos also fail. */
function record(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(field);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!keys.includes(key)) invalid(`${field}.${key}`);
  }
  return result;
}

/** Validates the currently supported approval policies, including granular leaves. */
function approval(value: unknown): v2.AskForApproval {
  if (value === 'never' || value === 'on-request') return value;
  const outer = record(value, ['granular'], 'approvalPolicy');
  const keys = [
    'sandbox_approval',
    'rules',
    'skill_approval',
    'request_permissions',
    'mcp_elicitations',
  ] as const;
  const granular = record(outer.granular, keys, 'approvalPolicy.granular');
  for (const key of keys) {
    if (typeof granular[key] !== 'boolean')
      invalid(`approvalPolicy.granular.${key}`);
  }
  return {
    granular: granular as Extract<v2.AskForApproval, object>['granular'],
  };
}

/** Validates complete sandbox variants without synthesizing roots or network access. */
function sandbox(value: unknown): v2.SandboxPolicy {
  const object = record(
    value,
    [
      'type',
      'networkAccess',
      'writableRoots',
      'excludeTmpdirEnvVar',
      'excludeSlashTmp',
    ],
    'sandboxPolicy',
  );
  switch (object.type) {
    case 'dangerFullAccess':
      record(object, ['type'], 'sandboxPolicy');
      return { type: 'dangerFullAccess' };
    case 'readOnly':
      record(object, ['type', 'networkAccess'], 'sandboxPolicy');
      if (typeof object.networkAccess !== 'boolean')
        invalid('sandboxPolicy.networkAccess');
      return { type: 'readOnly', networkAccess: object.networkAccess };
    case 'externalSandbox':
      record(object, ['type', 'networkAccess'], 'sandboxPolicy');
      if (
        object.networkAccess !== 'enabled' &&
        object.networkAccess !== 'restricted'
      )
        invalid('sandboxPolicy.networkAccess');
      return { type: 'externalSandbox', networkAccess: object.networkAccess };
    case 'workspaceWrite': {
      const roots = object.writableRoots;
      if (
        !Array.isArray(roots) ||
        !roots.every(
          (root): root is string =>
            typeof root === 'string' && isAbsolute(root),
        )
      ) {
        invalid('sandboxPolicy.writableRoots');
      }
      for (const key of [
        'networkAccess',
        'excludeTmpdirEnvVar',
        'excludeSlashTmp',
      ]) {
        if (typeof object[key] !== 'boolean') invalid(`sandboxPolicy.${key}`);
      }
      return {
        type: 'workspaceWrite',
        writableRoots: roots,
        networkAccess: object.networkAccess as boolean,
        excludeTmpdirEnvVar: object.excludeTmpdirEnvVar as boolean,
        excludeSlashTmp: object.excludeSlashTmp as boolean,
      };
    }
    default:
      return invalid('sandboxPolicy.type');
  }
}

/**
 * Validates and reconstructs a nonempty, partial thread policy patch.
 * Omission preserves a setting; null is not a reset supported by this endpoint.
 * Unknown top-level or nested fields fail before any app-server request.
 */
export function validateThreadSecurityPolicy(
  value: unknown,
): PatchThreadSecurityPolicyDto {
  const body = record(value, ['approvalPolicy', 'sandboxPolicy'], 'body');
  if (Object.keys(body).length === 0) invalid('body');
  return {
    ...('approvalPolicy' in body && {
      approvalPolicy: approval(body.approvalPolicy),
    }),
    ...('sandboxPolicy' in body && {
      sandboxPolicy: sandbox(body.sandboxPolicy),
    }),
  };
}
