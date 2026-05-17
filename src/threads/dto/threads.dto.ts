import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { v2 } from '../../codex/codex-schema';
import { approvalPolicySchema, userInputSchema } from '../../codex/dto/v2';

/** Request body for creating a Codex thread. */
export class CreateThreadDto {
  @ApiPropertyOptional()
  model?: string;

  @ApiPropertyOptional()
  cwd?: string;

  @ApiPropertyOptional(approvalPolicySchema(true))
  approvalPolicy?: unknown;
}

/** Request body for starting a new turn. */
export class StartTurnDto {
  @ApiProperty({
    type: 'array',
    items: userInputSchema(false) as Record<string, unknown>,
    minItems: 1,
  })
  input!: v2.UserInput[];

  @ApiPropertyOptional({
    description: 'Override model for this turn and subsequent turns.',
  })
  model?: string;

  @ApiPropertyOptional({
    enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    description:
      'Override reasoning effort for this turn and subsequent turns.',
  })
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

/** Request body for steering the current active turn. */
export class SteerTurnDto {
  @ApiProperty({
    type: 'array',
    items: userInputSchema(false) as Record<string, unknown>,
    minItems: 1,
  })
  input!: v2.UserInput[];
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
  ThreadLoadedListResponseDto,
  ThreadReadResponseDto,
  ThreadResumeResponseDto,
  ThreadRollbackResponseDto,
  ThreadStartResponseDto,
  ThreadUnarchiveResponseDto,
  TurnStartResponseDto,
} from '../../codex/dto/v2';
