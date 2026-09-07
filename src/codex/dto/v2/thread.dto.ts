import { ApiProperty } from '@nestjs/swagger';
import {
  NULLABLE_STRING_SCHEMA,
  REASONING_EFFORT_VALUES,
  nullableStringEnumSchema,
} from './openapi.schema';
import { sessionSourceSchema } from './session.dto';
import { threadStatusSchema } from './thread-status.dto';
import { TurnDto } from './turn.dto';

/** Optional Git metadata captured when a thread was created. */
export class GitInfoDto {
  @ApiProperty(NULLABLE_STRING_SCHEMA)
  sha!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  branch!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  originUrl!: string | null;
}

/** v2 Thread mirror used for OpenAPI schema generation. */
export class ThreadDto {
  @ApiProperty()
  id!: string;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  forkedFromId!: string | null;

  @ApiProperty()
  preview!: string;

  @ApiProperty()
  ephemeral!: boolean;

  @ApiProperty()
  modelProvider!: string;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  model!: string | null;

  @ApiProperty(nullableStringEnumSchema(REASONING_EFFORT_VALUES))
  reasoningEffort!: string | null;

  @ApiProperty()
  createdAt!: number;

  @ApiProperty()
  updatedAt!: number;

  @ApiProperty(threadStatusSchema())
  status!: unknown;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  path!: string | null;

  @ApiProperty()
  cwd!: string;

  @ApiProperty()
  cliVersion!: string;

  @ApiProperty(sessionSourceSchema())
  source!: unknown;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  agentNickname!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  agentRole!: string | null;

  @ApiProperty({ nullable: true, type: () => GitInfoDto })
  gitInfo!: GitInfoDto | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  name!: string | null;

  @ApiProperty({ type: () => [TurnDto] })
  turns!: TurnDto[];
}
