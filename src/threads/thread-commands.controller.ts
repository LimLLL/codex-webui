/** REST controller for thread-scoped command primitives used by composer commands. */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { v2 } from '../codex/codex-schema';
import { CODEX_V2_EXTRA_MODELS } from '../codex/dto/v2';
import { BusinessException } from '../common/business.exception';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { ErrorCode } from '../common/error-codes';
import {
  COLLABORATION_MODE_VALUES,
  CollaborationModesResponseDto,
  REVIEW_TARGET_EXTRA_MODELS,
  REVIEW_TARGET_TYPE_VALUES,
  ReviewStartResponseDto,
  SetThreadCollaborationModeDto,
  SetThreadGoalDto,
  StartReviewDto,
  THREAD_GOAL_STATUS_VALUES,
  ThreadCollaborationModeStateDto,
  ThreadGoalClearResponseDto,
  ThreadGoalResponseDto,
  ThreadGoalSetResponseDto,
} from './dto/threads.dto';
import { ThreadCommandsService } from './thread-commands.service';

type CommandBodyRecord = Record<string, unknown>;

/**
 * Upper bound Codex enforces on goal text. Rejecting at the REST boundary
 * turns an opaque app-server rejection into an actionable field error.
 */
const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

@ApiTags('threads')
@ApiBearerAuth()
@ApiExtraModels(
  ...CODEX_V2_EXTRA_MODELS,
  ...REVIEW_TARGET_EXTRA_MODELS,
  ApiErrorResponseDto,
  CollaborationModesResponseDto,
  ThreadCollaborationModeStateDto,
  ThreadGoalResponseDto,
  ThreadGoalSetResponseDto,
  ThreadGoalClearResponseDto,
  ReviewStartResponseDto,
)
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@Controller('threads')
export class ThreadCommandsController {
  constructor(private readonly threadCommands: ThreadCommandsService) {}

  /** Lists collaboration mode presets provided by app-server. */
  @Get('collaboration-modes')
  @ApiOperation({ summary: 'List app-server collaboration mode presets' })
  @ApiOkResponse({ type: CollaborationModesResponseDto })
  listCollaborationModes() {
    return this.threadCommands.listCollaborationModes();
  }

  /** Reads the backend-observed collaboration mode for a thread. */
  @Get(':threadId/collaboration-mode')
  @ApiOperation({
    summary: 'Read the backend-observed collaboration mode for a thread',
  })
  @ApiOkResponse({ type: ThreadCollaborationModeStateDto })
  readCollaborationMode(@Param('threadId') threadId: string) {
    return this.threadCommands.readCollaborationMode(threadId);
  }

  /** Updates a thread's next-turn collaboration mode without starting a turn. */
  @Patch(':threadId/collaboration-mode')
  @ApiOperation({ summary: "Set a thread's next-turn collaboration mode" })
  @ApiBody({ type: SetThreadCollaborationModeDto })
  @ApiOkResponse({ type: ThreadCollaborationModeStateDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  setCollaborationMode(
    @Param('threadId') threadId: string,
    @Body() body: SetThreadCollaborationModeDto,
  ) {
    const mode = typeof body?.mode === 'string' ? body.mode : null;
    if (
      !mode ||
      !(COLLABORATION_MODE_VALUES as readonly string[]).includes(mode)
    ) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidCollaborationMode,
        'Invalid collaboration mode',
      );
    }
    return this.threadCommands.setCollaborationMode(threadId, mode);
  }

  /** Reads the persisted goal for a thread. */
  @Get(':threadId/goal')
  @ApiOperation({ summary: 'Read the persisted thread goal' })
  @ApiOkResponse({ type: ThreadGoalResponseDto })
  readGoal(@Param('threadId') threadId: string) {
    return this.threadCommands.readGoal(threadId);
  }

  /** Creates or partially updates the persisted goal for a thread. */
  @Patch(':threadId/goal')
  @ApiOperation({ summary: 'Create or update the persisted thread goal' })
  @ApiBody({ type: SetThreadGoalDto })
  @ApiOkResponse({ type: ThreadGoalSetResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  setGoal(@Param('threadId') threadId: string, @Body() body: SetThreadGoalDto) {
    return this.threadCommands.setGoal({
      threadId,
      ...this.validateGoalUpdate(body),
    });
  }

  /** Clears the persisted goal for a thread. */
  @Delete(':threadId/goal')
  @ApiOperation({ summary: 'Clear the persisted thread goal' })
  @ApiOkResponse({ type: ThreadGoalClearResponseDto })
  clearGoal(@Param('threadId') threadId: string) {
    return this.threadCommands.clearGoal(threadId);
  }

  /** Starts an inline Codex review turn for a thread. */
  @Post(':threadId/review')
  @ApiOperation({ summary: 'Start an inline Codex code review turn' })
  @ApiBody({ type: StartReviewDto })
  @ApiCreatedResponse({ type: ReviewStartResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  startReview(
    @Param('threadId') threadId: string,
    @Body() body: StartReviewDto,
  ) {
    return this.threadCommands.startReview(
      threadId,
      this.validateReviewTarget(body),
    );
  }

  /** Validates partial goal updates while preserving explicit null token-budget reset. */
  private validateGoalUpdate(
    body: SetThreadGoalDto,
  ): Omit<v2.ThreadGoalSetParams, 'threadId'> {
    if (!this.isRecord(body)) {
      throw BusinessException.badRequest(
        ErrorCode.validation.bodyRequired,
        'Request body is required',
      );
    }

    const params: Omit<v2.ThreadGoalSetParams, 'threadId'> = {};
    let hasUpdate = false;

    if ('objective' in body) {
      const objective = body.objective;
      if (typeof objective !== 'string') {
        throw BusinessException.badRequest(
          ErrorCode.threads.invalidGoal,
          'objective must be a non-empty string',
        );
      }
      const trimmed = objective.trim();
      if (!trimmed) {
        throw BusinessException.badRequest(
          ErrorCode.threads.invalidGoal,
          'objective must be a non-empty string',
        );
      }
      if (trimmed.length > MAX_GOAL_OBJECTIVE_LENGTH) {
        throw BusinessException.badRequest(
          ErrorCode.threads.invalidGoal,
          `objective must be at most ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
          { max: MAX_GOAL_OBJECTIVE_LENGTH, length: trimmed.length },
        );
      }
      params.objective = trimmed;
      hasUpdate = true;
    }

    if ('status' in body) {
      const status = body.status;
      if (
        typeof status !== 'string' ||
        !(THREAD_GOAL_STATUS_VALUES as readonly string[]).includes(status)
      ) {
        throw BusinessException.badRequest(
          ErrorCode.threads.invalidGoalStatus,
          'Invalid goal status',
        );
      }
      params.status = status as v2.ThreadGoalStatus;
      hasUpdate = true;
    }

    if ('tokenBudget' in body) {
      const tokenBudget = body.tokenBudget;
      if (tokenBudget === null) {
        params.tokenBudget = null;
      } else if (
        typeof tokenBudget === 'number' &&
        Number.isInteger(tokenBudget) &&
        tokenBudget > 0
      ) {
        params.tokenBudget = tokenBudget;
      } else {
        throw BusinessException.badRequest(
          ErrorCode.threads.invalidGoal,
          'tokenBudget must be a positive integer or null',
        );
      }
      hasUpdate = true;
    }

    if (!hasUpdate) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidGoal,
        'At least one goal field must be provided',
      );
    }

    return params;
  }

  /** Validates inline-only review targets and rejects detached review requests. */
  private validateReviewTarget(body: StartReviewDto): v2.ReviewTarget {
    if (!this.isRecord(body) || !this.isRecord(body.target)) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidReviewTarget,
        'review target is required',
      );
    }

    const delivery = (body as StartReviewDto & { delivery?: unknown }).delivery;
    if (delivery !== undefined && delivery !== null && delivery !== 'inline') {
      throw BusinessException.badRequest(
        ErrorCode.threads.reviewDetachedUnsupported,
        'Detached review is not supported for paginated threads',
      );
    }

    const target = body.target;
    switch (target.type) {
      case 'uncommittedChanges':
        return { type: 'uncommittedChanges' };
      case 'baseBranch':
        return {
          type: 'baseBranch',
          branch: this.readRequiredPlainString(target, 'branch'),
        };
      case 'commit':
        return {
          type: 'commit',
          sha: this.readRequiredPlainString(target, 'sha'),
          title: this.readOptionalPlainString(target, 'title'),
        };
      case 'custom':
        return {
          type: 'custom',
          instructions: this.readRequiredPlainString(target, 'instructions'),
        };
      default:
        throw BusinessException.badRequest(
          ErrorCode.threads.invalidReviewTarget,
          `review target type must be one of ${REVIEW_TARGET_TYPE_VALUES.join(', ')}`,
        );
    }
  }

  /** Reads and trims a required plain string field. */
  private readRequiredPlainString(
    body: CommandBodyRecord,
    field: string,
  ): string {
    const value = body[field];
    if (typeof value !== 'string') {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidReviewTarget,
        `${field} must be a non-empty string`,
      );
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidReviewTarget,
        `${field} must be a non-empty string`,
      );
    }
    return trimmed;
  }

  /** Reads and trims an optional plain string field, normalizing blanks to null. */
  private readOptionalPlainString(
    body: CommandBodyRecord,
    field: string,
  ): string | null {
    const value = body[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidReviewTarget,
        `${field} must be a string or null`,
      );
    }
    const trimmed = value.trim();
    return trimmed || null;
  }

  /** Type guard for plain request bodies. */
  private isRecord(value: unknown): value is CommandBodyRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
