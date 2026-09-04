import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import type { ModeKind, ReasoningEffort, v2 } from '../../codex/codex-schema';
import {
  approvalPolicySchema,
  threadItemSchema,
  userInputSchema,
} from '../../codex/dto/v2';
import {
  NULLABLE_STRING_SCHEMA,
  REASONING_EFFORT_VALUES,
  oneOfSchema,
  nullableStringEnumSchema,
} from '../../codex/dto/v2/openapi.schema';
import { ThreadDto } from '../../codex/dto/v2/thread.dto';
import { TurnDto } from '../../codex/dto/v2/turn.dto';

export const COLLABORATION_MODE_VALUES = ['plan', 'default'] as const;

export const COLLABORATION_MODE_SOURCE_VALUES = [
  'unknown',
  'notification',
  'accepted',
] as const;

export const THREAD_GOAL_STATUS_VALUES = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
] as const;

export const REVIEW_TARGET_TYPE_VALUES = [
  'uncommittedChanges',
  'baseBranch',
  'commit',
  'custom',
] as const;

/** One app-server collaboration mode preset suitable for a slash command row. */
export class CollaborationModePresetDto {
  @ApiProperty()
  name!: string;

  @ApiProperty(nullableStringEnumSchema(COLLABORATION_MODE_VALUES))
  mode!: ModeKind | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  model!: string | null;

  @ApiProperty(nullableStringEnumSchema(REASONING_EFFORT_VALUES))
  reasoningEffort!: ReasoningEffort | null;
}

/** Runtime list of collaboration mode presets advertised by app-server. */
export class CollaborationModesResponseDto {
  @ApiProperty({ type: () => [CollaborationModePresetDto] })
  data!: CollaborationModePresetDto[];
}

/** Observed collaboration mode state for a thread, or an honest unknown. */
export class ThreadCollaborationModeStateDto {
  @ApiProperty()
  observed!: boolean;

  @ApiProperty({
    enum: COLLABORATION_MODE_SOURCE_VALUES,
    description:
      'How the backend learned this value. unknown means app-server has not emitted observable settings in this process.',
  })
  source!: (typeof COLLABORATION_MODE_SOURCE_VALUES)[number];

  @ApiProperty(nullableStringEnumSchema(COLLABORATION_MODE_VALUES))
  mode!: ModeKind | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  model!: string | null;

  @ApiProperty(nullableStringEnumSchema(REASONING_EFFORT_VALUES))
  reasoningEffort!: ReasoningEffort | null;
}

/** Request body for updating a thread's next-turn collaboration mode. */
export class SetThreadCollaborationModeDto {
  @ApiProperty({ enum: COLLABORATION_MODE_VALUES })
  mode!: ModeKind;
}

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
    enum: REASONING_EFFORT_VALUES,
    description:
      'Override reasoning effort for this turn and subsequent turns.',
  })
  effort?: ReasoningEffort;
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

/** Current persisted background goal for a thread. */
export class ThreadGoalDto {
  @ApiProperty()
  threadId!: string;

  @ApiProperty()
  objective!: string;

  @ApiProperty({ enum: THREAD_GOAL_STATUS_VALUES })
  status!: v2.ThreadGoalStatus;

  @ApiProperty({ nullable: true, type: Number })
  tokenBudget!: number | null;

  @ApiProperty()
  tokensUsed!: number;

  @ApiProperty()
  timeUsedSeconds!: number;

  @ApiProperty()
  createdAt!: number;

  @ApiProperty()
  updatedAt!: number;
}

/** Response body for reading a thread goal. */
export class ThreadGoalResponseDto {
  @ApiProperty({ type: () => ThreadGoalDto, nullable: true })
  goal!: ThreadGoalDto | null;
}

/** Response body for setting or pausing/resuming a thread goal. */
export class ThreadGoalSetResponseDto {
  @ApiProperty({ type: () => ThreadGoalDto })
  goal!: ThreadGoalDto;
}

/**
 * Request body for creating or partially updating a thread goal.
 *
 * Every field is optional, but at least one must be present. Only `tokenBudget`
 * accepts an explicit null, which resets the budget to the configured limit
 * rather than removing it.
 */
export class SetThreadGoalDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 4000 })
  objective?: string;

  @ApiPropertyOptional({ enum: THREAD_GOAL_STATUS_VALUES })
  status?: v2.ThreadGoalStatus;

  @ApiPropertyOptional({ nullable: true, type: Number })
  tokenBudget?: number | null;
}

/** Response body for clearing a thread goal. */
export class ThreadGoalClearResponseDto {
  @ApiProperty()
  cleared!: boolean;
}

/** Review target for staged, unstaged, and untracked repository changes. */
export class ReviewUncommittedChangesTargetDto {
  @ApiProperty({ enum: ['uncommittedChanges'] })
  type!: 'uncommittedChanges';
}

/** Review target for a diff against a named base branch. */
export class ReviewBaseBranchTargetDto {
  @ApiProperty({ enum: ['baseBranch'] })
  type!: 'baseBranch';

  @ApiProperty({ minLength: 1 })
  branch!: string;
}

/** Review target for a specific commit. */
export class ReviewCommitTargetDto {
  @ApiProperty({ enum: ['commit'] })
  type!: 'commit';

  @ApiProperty({ minLength: 1 })
  sha!: string;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  title!: string | null;
}

/** Review target for free-form reviewer instructions. */
export class ReviewCustomTargetDto {
  @ApiProperty({ enum: ['custom'] })
  type!: 'custom';

  @ApiProperty({ minLength: 1 })
  instructions!: string;
}

export const REVIEW_TARGET_EXTRA_MODELS = [
  ReviewUncommittedChangesTargetDto,
  ReviewBaseBranchTargetDto,
  ReviewCommitTargetDto,
  ReviewCustomTargetDto,
] as const;

export const reviewTargetSchema = oneOfSchema([
  { $ref: getSchemaPath(ReviewUncommittedChangesTargetDto) },
  { $ref: getSchemaPath(ReviewBaseBranchTargetDto) },
  { $ref: getSchemaPath(ReviewCommitTargetDto) },
  { $ref: getSchemaPath(ReviewCustomTargetDto) },
]);

/** Request body for starting an inline code review turn. */
export class StartReviewDto {
  @ApiProperty(reviewTargetSchema)
  target!: v2.ReviewTarget;
}

/** Response body for starting a code review. */
export class ReviewStartResponseDto {
  @ApiProperty({ type: () => TurnDto })
  turn!: TurnDto;

  @ApiProperty()
  reviewThreadId!: string;
}

/** Request body for forking a thread through the WebUI. */
export class ForkThreadDto {
  @ApiPropertyOptional({
    description:
      'Opt in to native deferred goal continuation on the fork. Defaults to false.',
  })
  carryGoal?: boolean;
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

/**
 * Full persisted items for a single turn.
 *
 * Used to top a turn up to full detail after it was fetched in the cheaper
 * `summary` view, which app-server returns without `reasoning` or `plan`.
 */
export class ThreadTurnItemsResponseDto {
  @ApiProperty({
    type: 'array',
    items: threadItemSchema(false) as Record<string, unknown>,
    description: 'Items belonging to the turn, oldest first.',
  })
  items!: unknown[];
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
