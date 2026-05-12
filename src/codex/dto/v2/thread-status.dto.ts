import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import {
  type SwaggerSchema,
  THREAD_ACTIVE_FLAG_VALUES,
  oneOfSchema,
} from './openapi.schema';

/** v2 ThreadStatus branch for unloaded threads. */
export class ThreadStatusNotLoadedDto {
  @ApiProperty({ enum: ['notLoaded'] })
  type!: 'notLoaded';
}

/** v2 ThreadStatus branch for idle threads. */
export class ThreadStatusIdleDto {
  @ApiProperty({ enum: ['idle'] })
  type!: 'idle';
}

/** v2 ThreadStatus branch for system-error threads. */
export class ThreadStatusSystemErrorDto {
  @ApiProperty({ enum: ['systemError'] })
  type!: 'systemError';
}

/** v2 ThreadStatus branch for active threads. */
export class ThreadStatusActiveDto {
  @ApiProperty({ enum: ['active'] })
  type!: 'active';

  @ApiProperty({ enum: THREAD_ACTIVE_FLAG_VALUES, isArray: true })
  activeFlags!: Array<(typeof THREAD_ACTIVE_FLAG_VALUES)[number]>;
}

/** OpenAPI schema for v2 ThreadStatus. */
export function threadStatusSchema(nullable = false): SwaggerSchema {
  return oneOfSchema(
    [
      { $ref: getSchemaPath(ThreadStatusNotLoadedDto) },
      { $ref: getSchemaPath(ThreadStatusIdleDto) },
      { $ref: getSchemaPath(ThreadStatusSystemErrorDto) },
      { $ref: getSchemaPath(ThreadStatusActiveDto) },
    ],
    nullable,
  );
}
