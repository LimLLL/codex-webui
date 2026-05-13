import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { approvalPolicySchema } from '../../codex/dto/v2';

/** Request body for creating a Codex thread. */
export class CreateThreadDto {
  @ApiPropertyOptional()
  model?: string;

  @ApiPropertyOptional()
  cwd?: string;

  @ApiPropertyOptional(approvalPolicySchema(true))
  approvalPolicy?: unknown;
}

/** Text-only turn input supported by the current WebUI. */
export class TextTurnInputDto {
  @ApiProperty({ enum: ['text'] })
  type!: 'text';

  @ApiProperty()
  text!: string;
}

/** Request body for starting a new turn. */
export class StartTurnDto {
  @ApiProperty({ type: () => [TextTurnInputDto], minItems: 1 })
  input!: TextTurnInputDto[];
}

/** Request body for steering the current active turn. */
export class SteerTurnDto {
  @ApiProperty({ type: () => [TextTurnInputDto], minItems: 1 })
  input!: TextTurnInputDto[];
}

/** Response body for steering the current active turn. */
export class TurnSteerResponseDto {
  @ApiProperty()
  turnId!: string;
}

/** Request body for rolling back turns from a thread. */
export class ThreadRollbackRequestDto {
  @ApiProperty({ minimum: 1, type: Number })
  numTurns!: number;
}

/** Request body for setting a user-facing thread name. */
export class ThreadSetNameRequestDto {
  @ApiProperty({ minLength: 1 })
  name!: string;
}

export {
  CODEX_V2_EXTRA_MODELS,
  ThreadForkResponseDto,
  ThreadListResponseDto,
  ThreadReadResponseDto,
  ThreadResumeResponseDto,
  ThreadRollbackResponseDto,
  ThreadStartResponseDto,
  ThreadUnarchiveResponseDto,
  TurnStartResponseDto,
} from '../../codex/dto/v2';
