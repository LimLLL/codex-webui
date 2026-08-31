import { ApiProperty } from '@nestjs/swagger';
import {
  NULLABLE_NUMBER_SCHEMA,
  NULLABLE_STRING_SCHEMA,
  TURN_ITEMS_VIEW_VALUES,
  TURN_STATUS_VALUES,
} from './openapi.schema';
import { codexErrorInfoSchema } from './support.dto';
import { threadItemSchema } from './thread-item.dto';

/** Public display details for a misalignment block; steering is excluded. */
export class MisalignmentDetailsDto {
  @ApiProperty(NULLABLE_STRING_SCHEMA)
  errorType!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  detailedExplanation!: string | null;
}

/** Failure details attached to a failed Codex turn. */
export class TurnErrorDto {
  @ApiProperty()
  message!: string;

  @ApiProperty(codexErrorInfoSchema(true))
  codexErrorInfo!: unknown;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  additionalDetails!: string | null;

  @ApiProperty({ nullable: true, type: () => MisalignmentDetailsDto })
  misalignment!: MisalignmentDetailsDto | null;
}

/** v2 Turn mirror used for OpenAPI schema generation. */
export class TurnDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    type: 'array',
    items: threadItemSchema(false) as Record<string, unknown>,
  })
  items!: unknown[];

  @ApiProperty({ enum: TURN_ITEMS_VIEW_VALUES })
  itemsView!: (typeof TURN_ITEMS_VIEW_VALUES)[number];

  @ApiProperty({ enum: TURN_STATUS_VALUES })
  status!: (typeof TURN_STATUS_VALUES)[number];

  @ApiProperty({ nullable: true, type: () => TurnErrorDto })
  error!: TurnErrorDto | null;

  @ApiProperty(NULLABLE_NUMBER_SCHEMA)
  startedAt!: number | null;

  @ApiProperty(NULLABLE_NUMBER_SCHEMA)
  completedAt!: number | null;

  @ApiProperty(NULLABLE_NUMBER_SCHEMA)
  durationMs!: number | null;
}
