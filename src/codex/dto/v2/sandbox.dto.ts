import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import {
  type SwaggerSchema,
  ABSOLUTE_PATH_BUF_SCHEMA,
  NETWORK_ACCESS_VALUES,
  oneOfSchema,
} from './openapi.schema';

/** Restricted read-only access branch mirrored from v2 ReadOnlyAccess. */
export class ReadOnlyAccessRestrictedDto {
  @ApiProperty({ enum: ['restricted'] })
  type!: 'restricted';

  @ApiProperty()
  includePlatformDefaults!: boolean;

  @ApiProperty({ type: 'array', items: ABSOLUTE_PATH_BUF_SCHEMA })
  readableRoots!: string[];
}

/** Full read-only access branch mirrored from v2 ReadOnlyAccess. */
export class ReadOnlyAccessFullAccessDto {
  @ApiProperty({ enum: ['fullAccess'] })
  type!: 'fullAccess';
}

/** Danger-full-access sandbox policy branch. */
export class SandboxDangerFullAccessDto {
  @ApiProperty({ enum: ['dangerFullAccess'] })
  type!: 'dangerFullAccess';
}

/** Read-only sandbox policy branch. */
export class SandboxReadOnlyDto {
  @ApiProperty({ enum: ['readOnly'] })
  type!: 'readOnly';

  @ApiProperty()
  networkAccess!: boolean;
}

/** External sandbox policy branch. */
export class SandboxExternalSandboxDto {
  @ApiProperty({ enum: ['externalSandbox'] })
  type!: 'externalSandbox';

  @ApiProperty({ enum: NETWORK_ACCESS_VALUES })
  networkAccess!: (typeof NETWORK_ACCESS_VALUES)[number];
}

/** Workspace-write sandbox policy branch. */
export class SandboxWorkspaceWriteDto {
  @ApiProperty({ enum: ['workspaceWrite'] })
  type!: 'workspaceWrite';

  @ApiProperty({ type: 'array', items: ABSOLUTE_PATH_BUF_SCHEMA })
  writableRoots!: string[];

  @ApiProperty()
  networkAccess!: boolean;

  @ApiProperty()
  excludeTmpdirEnvVar!: boolean;

  @ApiProperty()
  excludeSlashTmp!: boolean;
}

/** OpenAPI schema for v2 ReadOnlyAccess. */
export function readOnlyAccessSchema(nullable = false): SwaggerSchema {
  return oneOfSchema(
    [
      { $ref: getSchemaPath(ReadOnlyAccessRestrictedDto) },
      { $ref: getSchemaPath(ReadOnlyAccessFullAccessDto) },
    ],
    nullable,
  );
}

/** OpenAPI schema for v2 SandboxPolicy. */
export function sandboxPolicySchema(nullable = false): SwaggerSchema {
  return oneOfSchema(
    [
      { $ref: getSchemaPath(SandboxDangerFullAccessDto) },
      { $ref: getSchemaPath(SandboxReadOnlyDto) },
      { $ref: getSchemaPath(SandboxExternalSandboxDto) },
      { $ref: getSchemaPath(SandboxWorkspaceWriteDto) },
    ],
    nullable,
  );
}
