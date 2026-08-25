import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { v2 } from '../../codex/codex-schema';
import { approvalPolicySchema, userInputSchema } from '../../codex/dto/v2';
import {
  NULLABLE_STRING_SCHEMA,
  nullableStringEnumSchema,
} from '../../codex/dto/v2/openapi.schema';
import { ThreadDto } from '../../codex/dto/v2/thread.dto';
import { TurnDto } from '../../codex/dto/v2/turn.dto';

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

/** Request body for setting a user-facing thread name. */
export class ThreadSetNameRequestDto {
  @ApiProperty({ minLength: 1 })
  name!: string;
}

/** Query controls for non-resuming paged history reads. */
export class ThreadTurnsListQueryDto {
  @ApiPropertyOptional()
  cursor?: string;

  @ApiPropertyOptional()
  limit?: number;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  sortDirection?: 'asc' | 'desc';

  @ApiPropertyOptional({ enum: ['notLoaded', 'summary', 'full'] })
  itemsView?: 'notLoaded' | 'summary' | 'full';
}

/** One page of turn history returned without materializing a whole thread. */
export class ThreadTurnsPageDto {
  @ApiProperty({ type: () => [TurnDto] })
  data!: TurnDto[];

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  nextCursor!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  backwardsCursor!: string | null;
}

/**
 * Metadata-first thread open response.
 *
 * `mode=readOnly` means app-server refused writer ownership; the frontend should
 * render the thread plus an explicit banner rather than treating this as a
 * generic failure.
 */
export class ThreadOpenResponseDto {
  @ApiProperty({ enum: ['writable', 'readOnly'] })
  mode!: 'writable' | 'readOnly';

  @ApiProperty({ enum: ['acquired', 'refused'] })
  ownership!: 'acquired' | 'refused';

  @ApiPropertyOptional({ nullable: true, type: String })
  ownershipRefusalMessage!: string | null;

  @ApiProperty({ type: () => ThreadDto })
  thread!: ThreadDto;

  @ApiProperty()
  cwd!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  model!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  modelProvider!: string | null;

  @ApiProperty(nullableStringEnumSchema(['fast', 'flex']))
  serviceTier!: 'fast' | 'flex' | null;

  @ApiPropertyOptional({ type: () => [String] })
  instructionSources!: string[];

  @ApiPropertyOptional()
  approvalPolicy!: unknown;

  @ApiPropertyOptional({ nullable: true, type: String })
  approvalsReviewer!: string | null;

  @ApiPropertyOptional()
  sandbox!: unknown;

  @ApiPropertyOptional({ nullable: true, type: String })
  reasoningEffort!: string | null;

  @ApiProperty({ type: () => ThreadTurnsPageDto })
  initialTurnsPage!: ThreadTurnsPageDto;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  turnsBackwardsCursor!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  itemsBackwardsCursor!: string | null;
}

/** One branch-collapsed row for the conversation sidebar. */
export class ThreadOverviewRowDto {
  @ApiProperty({ type: () => ThreadDto })
  thread!: ThreadDto;

  @ApiProperty()
  treeRootThreadId!: string;

  @ApiProperty()
  openThreadId!: string;

  @ApiProperty({ type: () => [String] })
  memberThreadIds!: string[];

  @ApiProperty({ type: () => [String] })
  hiddenThreadIds!: string[];

  @ApiProperty()
  hasBranchDescendants!: boolean;

  @ApiProperty()
  latestActivityAt!: number;

  @ApiProperty()
  running!: boolean;

  @ApiProperty()
  waitingOnApproval!: boolean;

  @ApiProperty()
  waitingOnUserInput!: boolean;

  @ApiProperty()
  pendingApprovalCount!: number;
}

/** Server-side projection of the sidebar's branch-collapsed conversation list. */
export class ThreadOverviewResponseDto {
  @ApiProperty({ type: () => [ThreadOverviewRowDto] })
  data!: ThreadOverviewRowDto[];

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  nextCursor!: string | null;
}

/** Request body for batched decorative branch-graph turn counts. */
export class ThreadTurnCountsRequestDto {
  @ApiProperty({ type: () => [String] })
  threadIds!: string[];
}

/** Turn count for one thread. `count=null` means unknown. */
export class ThreadTurnCountDto {
  @ApiProperty()
  threadId!: string;

  @ApiPropertyOptional({ nullable: true, type: Number })
  count!: number | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  errorMessage!: string | null;
}

/** Batched turn-count response for branch graph nodes. */
export class ThreadTurnCountsResponseDto {
  @ApiProperty({ type: () => [ThreadTurnCountDto] })
  counts!: ThreadTurnCountDto[];
}

export {
  CODEX_V2_EXTRA_MODELS,
  ThreadForkResponseDto,
  ThreadListResponseDto,
  ThreadLoadedListResponseDto,
  ThreadReadResponseDto,
  ThreadResumeResponseDto,
  ThreadStartResponseDto,
  ThreadUnarchiveResponseDto,
  TurnStartResponseDto,
} from '../../codex/dto/v2';
