import { ApiProperty } from '@nestjs/swagger';
import {
  NULLABLE_STRING_SCHEMA,
  REASONING_EFFORT_VALUES,
  SERVICE_TIER_VALUES,
  nullableStringEnumSchema,
} from './openapi.schema';
import { approvalPolicySchema, approvalsReviewerSchema } from './approval.dto';
import { sandboxPolicySchema } from './sandbox.dto';
import { ModelDto } from './model.dto';
import { ThreadDto } from './thread.dto';
import { TurnDto } from './turn.dto';

/** v2 ThreadStartResponse mirror. */
export class ThreadStartResponseDto {
  @ApiProperty({ type: () => ThreadDto })
  thread!: ThreadDto;

  @ApiProperty()
  model!: string;

  @ApiProperty()
  modelProvider!: string;

  @ApiProperty(nullableStringEnumSchema(SERVICE_TIER_VALUES))
  serviceTier!: (typeof SERVICE_TIER_VALUES)[number] | null;

  @ApiProperty()
  cwd!: string;

  @ApiProperty(approvalPolicySchema())
  approvalPolicy!: unknown;

  @ApiProperty(approvalsReviewerSchema())
  approvalsReviewer!: string;

  @ApiProperty(sandboxPolicySchema())
  sandbox!: unknown;

  @ApiProperty(nullableStringEnumSchema(REASONING_EFFORT_VALUES))
  reasoningEffort!: (typeof REASONING_EFFORT_VALUES)[number] | null;
}

/** v2 ThreadResumeResponse mirror. */
export class ThreadResumeResponseDto extends ThreadStartResponseDto {}

/** v2 ThreadForkResponse mirror. */
export class ThreadForkResponseDto extends ThreadStartResponseDto {}

/** v2 ThreadReadResponse mirror. */
export class ThreadReadResponseDto {
  @ApiProperty({ type: () => ThreadDto })
  thread!: ThreadDto;
}

/** v2 ThreadListResponse mirror. */
export class ThreadListResponseDto {
  @ApiProperty({ type: () => [ThreadDto] })
  data!: ThreadDto[];

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  nextCursor!: string | null;
}

/** v2 ThreadLoadedListResponse mirror. */
export class ThreadLoadedListResponseDto {
  @ApiProperty({ type: () => [String] })
  data!: string[];

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  nextCursor!: string | null;
}

/** v2 ThreadUnarchiveResponse mirror. */
export class ThreadUnarchiveResponseDto {
  @ApiProperty({ type: () => ThreadDto })
  thread!: ThreadDto;
}

/** v2 ThreadRollbackResponse mirror. */
export class ThreadRollbackResponseDto {
  @ApiProperty({ type: () => ThreadDto })
  thread!: ThreadDto;
}

/** v2 TurnStartResponse mirror. */
export class TurnStartResponseDto {
  @ApiProperty({ type: () => TurnDto })
  turn!: TurnDto;
}

/** v2 ModelListResponse mirror. */
export class ModelListResponseDto {
  @ApiProperty({ type: () => [ModelDto] })
  data!: ModelDto[];

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  nextCursor!: string | null;
}
