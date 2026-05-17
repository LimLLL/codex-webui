import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { jsonValueSchema } from '../../codex/dto/v2/openapi.schema';

/** Raw skills/list response passthrough from Codex app-server. */
export class SkillsListResponseDto {
  @ApiProperty({
    type: 'array',
    items: jsonValueSchema(false) as Record<string, unknown>,
  })
  data!: unknown[];
}

/** Request body for skills/config/write. */
export class SkillsConfigWriteRequestDto {
  @ApiPropertyOptional({ description: 'Path-based skill selector.' })
  path?: string;

  @ApiPropertyOptional({ description: 'Name-based skill selector fallback.' })
  name?: string;

  @ApiProperty()
  enabled!: boolean;
}

/** Response for skills/config/write. */
export class SkillsConfigWriteResponseDto {
  @ApiProperty()
  effectiveEnabled!: boolean;
}
