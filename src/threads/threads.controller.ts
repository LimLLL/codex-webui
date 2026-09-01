/**
 * REST controller for thread and turn operations.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ChatUploadService } from '../chat/chat-upload.service';
import {
  ApiErrorResponseDto,
  OkResponseDto,
} from '../common/dto/api-responses.dto';
import type { v2 } from '../codex/codex-schema';
import {
  BranchStateDto,
  BranchTreeDto,
  CreateMessageBranchDto,
  CreateMessageBranchResponseDto,
} from '../conversation-branches/dto/conversation-branches.dto';
import { REASONING_EFFORT_VALUES } from '../codex/dto/v2/openapi.schema';
import { FilesService } from '../files/files.service';
import { ThreadsService } from './threads.service';
import {
  CODEX_V2_EXTRA_MODELS,
  CreateThreadDto,
  ForkThreadDto,
  StartTurnDto,
  ThreadForkResponseDto,
  ThreadListResponseDto,
  ThreadLoadedListResponseDto,
  ThreadOpenResponseDto,
  ThreadOverviewResponseDto,
  ThreadReadResponseDto,
  SteerTurnDto,
  ThreadSetNameRequestDto,
  ThreadStartResponseDto,
  ThreadTurnCountsRequestDto,
  ThreadTurnCountsResponseDto,
  ThreadTurnItemsResponseDto,
  ThreadTurnsPageDto,
  ThreadUnarchiveResponseDto,
  TurnStartResponseDto,
  TurnSteerResponseDto,
} from './dto/threads.dto';

type TurnInputRecord = Record<string, unknown>;

const USER_INPUT_TYPES = [
  'text',
  'image',
  'localImage',
  'skill',
  'mention',
] as const;

/** Largest batch the decorative branch-graph turn-count endpoint accepts. */
const MAX_TURN_COUNT_THREAD_IDS = 200;

@ApiTags('threads')
@ApiBearerAuth()
@ApiExtraModels(
  ...CODEX_V2_EXTRA_MODELS,
  ApiErrorResponseDto,
  OkResponseDto,
  BranchStateDto,
  BranchTreeDto,
  CreateMessageBranchResponseDto,
)
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@Controller('threads')
export class ThreadsController {
  constructor(
    private readonly threadsService: ThreadsService,
    private readonly filesService: FilesService,
    private readonly chatUploadService: ChatUploadService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new thread' })
  @ApiBody({ type: CreateThreadDto })
  @ApiCreatedResponse({ type: ThreadStartResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async startThread(@Body() body: CreateThreadDto) {
    return this.threadsService.startThread({
      model: body.model,
      cwd: body.cwd,
      approvalPolicy:
        body.approvalPolicy as v2.ThreadStartParams['approvalPolicy'],
    });
  }

  @Get()
  @ApiOperation({ summary: 'List threads' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'archived', required: false, type: Boolean })
  @ApiQuery({ name: 'searchTerm', required: false })
  @ApiQuery({ name: 'cwd', required: false })
  @ApiQuery({
    name: 'sortKey',
    required: false,
    enum: ['created_at', 'updated_at'],
  })
  @ApiOkResponse({ type: ThreadListResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async listThreads(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('archived') archived?: string,
    @Query('searchTerm') searchTerm?: string,
    @Query('cwd') cwd?: string,
    @Query('sortKey') sortKey?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;
    if (parsedLimit !== undefined && (isNaN(parsedLimit) || parsedLimit < 1)) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidLimit,
        'limit must be a positive number',
      );
    }
    if (
      sortKey !== undefined &&
      sortKey !== 'created_at' &&
      sortKey !== 'updated_at'
    ) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidSortKey,
        'sortKey must be created_at or updated_at',
      );
    }

    return this.threadsService.listThreads({
      cursor,
      limit: parsedLimit,
      archived: archived === 'true' ? true : undefined,
      searchTerm,
      cwd,
      sortKey: sortKey,
      // Empty array = all providers. Without this, app-server defaults to
      // the currently configured provider, hiding threads created under
      // other providers (e.g. "donehub" threads invisible when default is "openai").
      modelProviders: [],
    });
  }

  @Get('overview')
  @ApiOperation({ summary: 'List branch-collapsed thread overview rows' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'archived', required: false, type: Boolean })
  @ApiQuery({ name: 'searchTerm', required: false })
  @ApiQuery({ name: 'cwd', required: false })
  @ApiQuery({
    name: 'sortKey',
    required: false,
    enum: ['created_at', 'updated_at'],
  })
  @ApiOkResponse({ type: ThreadOverviewResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async listOverview(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('archived') archived?: string,
    @Query('searchTerm') searchTerm?: string,
    @Query('cwd') cwd?: string,
    @Query('sortKey') sortKey?: string,
  ) {
    const parsedLimit = this.parsePositiveLimit(limit);
    const parsedSortKey = this.parseSortKey(sortKey);
    return this.threadsService.listOverview({
      cursor,
      limit: parsedLimit,
      archived: archived === 'true',
      searchTerm,
      cwd,
      sortKey: parsedSortKey,
    });
  }

  @Get('loaded')
  @ApiOperation({ summary: 'List loaded thread IDs' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: ThreadLoadedListResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async listLoadedThreads(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;
    if (parsedLimit !== undefined && (isNaN(parsedLimit) || parsedLimit < 1)) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidLimit,
        'limit must be a positive number',
      );
    }

    return this.threadsService.listLoadedThreads({
      cursor,
      limit: parsedLimit,
    });
  }

  @Get('branch-trees')
  @ApiOperation({ summary: 'List locally tracked conversation branch trees' })
  @ApiOkResponse({ type: [BranchTreeDto] })
  listBranchTrees() {
    return this.threadsService.listBranchTrees();
  }

  @Get(':threadId')
  @ApiOperation({ summary: 'Read thread metadata by ID' })
  @ApiOkResponse({ type: ThreadReadResponseDto })
  async readThread(@Param('threadId') threadId: string) {
    return this.threadsService.readThread(threadId);
  }

  @Get(':threadId/branch-state')
  @ApiOperation({ summary: 'Read branch operation state for a thread' })
  @ApiOkResponse({ type: BranchStateDto })
  readBranchState(@Param('threadId') threadId: string) {
    return this.threadsService.readBranchState(threadId);
  }

  @Get(':threadId/branch-tree')
  @ApiOperation({
    summary: 'Read the locally tracked branch tree for a thread',
  })
  @ApiOkResponse({ type: BranchTreeDto })
  readBranchTree(@Param('threadId') threadId: string) {
    return this.threadsService.readBranchTree(threadId);
  }

  @Post(':threadId/resume')
  @ApiOperation({
    summary:
      'Open a thread with metadata-first history and explicit ownership state',
  })
  @ApiCreatedResponse({ type: ThreadOpenResponseDto })
  @ApiQuery({
    name: 'recordActive',
    required: false,
    type: Boolean,
    description:
      "Pass false for background reopens (refresh or reconnect recovery) so the tree's active-branch pointer keeps naming what the user last opened.",
  })
  async resumeThread(
    @Param('threadId') threadId: string,
    @Query('recordActive') recordActive?: string,
  ) {
    // Only an explicit `false` opts out; anything else keeps the default so a
    // caller that forgets the parameter still behaves like a user-initiated open.
    return this.threadsService.resumeThread(threadId, {
      recordActive: recordActive !== 'false',
    });
  }

  @Get(':threadId/turns/:turnId/items')
  @ApiOperation({
    summary: "Read one turn's full persisted items without resuming",
  })
  @ApiOkResponse({ type: ThreadTurnItemsResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  listTurnItems(
    @Param('threadId') threadId: string,
    @Param('turnId') turnId: string,
  ) {
    return this.threadsService.listTurnItems(threadId, turnId);
  }

  @Get(':threadId/turns')
  @ApiOperation({ summary: 'List turn history without resuming a thread' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'sortDirection', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'itemsView',
    required: false,
    enum: ['notLoaded', 'summary', 'full'],
  })
  @ApiOkResponse({ type: ThreadTurnsPageDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  listTurns(
    @Param('threadId') threadId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('sortDirection') sortDirection?: string,
    @Query('itemsView') itemsView?: string,
  ) {
    return this.threadsService.listTurns({
      threadId,
      cursor,
      limit: this.parsePositiveLimit(limit),
      sortDirection: this.parseSortDirection(sortDirection),
      itemsView: this.parseItemsView(itemsView),
    });
  }

  @Post('turn-counts')
  @ApiOperation({ summary: 'Count thread turns without resuming threads' })
  @ApiBody({ type: ThreadTurnCountsRequestDto })
  @ApiCreatedResponse({ type: ThreadTurnCountsResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  countTurns(@Body() body: ThreadTurnCountsRequestDto) {
    if (!Array.isArray(body?.threadIds)) {
      throw BusinessException.badRequest(
        ErrorCode.threads.threadIdsRequired,
        'threadIds is required',
      );
    }
    // Each id costs at least one app-server round trip, and a branch graph is
    // the only caller — it has tens of nodes, not thousands. Bounding the
    // request keeps a malformed or hostile caller from turning a decorative
    // count into a self-inflicted load generator.
    if (body.threadIds.length > MAX_TURN_COUNT_THREAD_IDS) {
      throw BusinessException.badRequest(
        ErrorCode.threads.threadIdsRequired,
        `threadIds must contain at most ${MAX_TURN_COUNT_THREAD_IDS} ids`,
      );
    }
    return this.threadsService.countTurns(body.threadIds);
  }

  @Post(':threadId/turns')
  @ApiOperation({ summary: 'Start a new turn (send message)' })
  @ApiBody({ type: StartTurnDto })
  @ApiCreatedResponse({ type: TurnStartResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async startTurn(
    @Param('threadId') threadId: string,
    @Body() body: StartTurnDto,
  ) {
    const input = await this.validateTurnInput(body.input);
    const model = typeof body.model === 'string' ? body.model.trim() : null;
    if (body.model !== undefined && !model) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidModel,
        'model must be a non-empty string',
      );
    }
    const effort = typeof body.effort === 'string' ? body.effort : null;
    if (body.effort !== undefined && !effort) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidEffort,
        'Invalid reasoning effort',
      );
    }
    if (
      effort &&
      !(REASONING_EFFORT_VALUES as readonly string[]).includes(effort)
    ) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidEffort,
        'Invalid reasoning effort',
      );
    }
    return this.threadsService.startTurn({
      threadId,
      input,
      ...(model && { model }),
      ...(effort && { effort }),
    });
  }

  @Post(':threadId/turns/:turnId/steer')
  @ApiOperation({ summary: 'Send mid-turn user input to an active turn' })
  @ApiBody({ type: SteerTurnDto })
  @ApiCreatedResponse({ type: TurnSteerResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async steerTurn(
    @Param('threadId') threadId: string,
    @Param('turnId') turnId: string,
    @Body() body: SteerTurnDto,
  ) {
    return this.threadsService.steerTurn({
      threadId,
      expectedTurnId: turnId,
      input: await this.validateTurnInput(body.input),
    });
  }

  @Post(':threadId/turns/:turnId/interrupt')
  @ApiOperation({ summary: 'Interrupt an in-progress turn' })
  @ApiCreatedResponse({ type: OkResponseDto })
  async interruptTurn(
    @Param('threadId') threadId: string,
    @Param('turnId') turnId: string,
  ) {
    await this.threadsService.interruptTurn(threadId, turnId);
    return { ok: true };
  }

  @Post(':threadId/archive')
  @ApiOperation({ summary: 'Archive a thread' })
  @ApiNoContentResponse()
  @HttpCode(204)
  async archiveThread(@Param('threadId') threadId: string) {
    await this.threadsService.archiveThread(threadId);
  }

  @Post(':threadId/unarchive')
  @ApiOperation({ summary: 'Unarchive a thread' })
  @ApiCreatedResponse({ type: ThreadUnarchiveResponseDto })
  async unarchiveThread(@Param('threadId') threadId: string) {
    return this.threadsService.unarchiveThread(threadId);
  }

  @Post(':threadId/compact')
  @ApiOperation({ summary: 'Compact thread context' })
  @ApiNoContentResponse()
  @HttpCode(204)
  async compactThread(@Param('threadId') threadId: string) {
    await this.threadsService.compactThread(threadId);
  }

  @Post(':threadId/branches')
  @ApiOperation({ summary: 'Create a message-level conversation branch' })
  @ApiBody({ type: CreateMessageBranchDto })
  @ApiCreatedResponse({ type: CreateMessageBranchResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async createMessageBranch(
    @Param('threadId') threadId: string,
    @Body() body: CreateMessageBranchDto,
  ) {
    return this.threadsService.createMessageBranch(threadId, body);
  }

  @Post(':threadId/fork')
  @ApiOperation({ summary: 'Fork a thread' })
  @ApiBody({ type: ForkThreadDto, required: false })
  @ApiCreatedResponse({ type: ThreadForkResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async forkThread(
    @Param('threadId') threadId: string,
    @Body() body?: ForkThreadDto,
  ) {
    return this.threadsService.forkThread(
      threadId,
      this.validateForkBody(body),
    );
  }

  @Patch(':threadId/name')
  @ApiOperation({ summary: 'Set thread name' })
  @ApiBody({ type: ThreadSetNameRequestDto })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @HttpCode(204)
  async setThreadName(
    @Param('threadId') threadId: string,
    @Body() body: ThreadSetNameRequestDto,
  ) {
    if (typeof body?.name !== 'string') {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidName,
        'name must be a non-empty string',
      );
    }
    const name = body.name.trim();
    if (name.length === 0) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidName,
        'name must be a non-empty string',
      );
    }
    await this.threadsService.setThreadName(threadId, name);
  }

  /** Validates and normalizes the discriminated UserInput union accepted by Codex. */
  private parsePositiveLimit(limit: string | undefined): number | undefined {
    const parsedLimit = limit ? Number(limit) : undefined;
    if (parsedLimit !== undefined && (isNaN(parsedLimit) || parsedLimit < 1)) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidLimit,
        'limit must be a positive number',
      );
    }
    return parsedLimit;
  }

  private parseSortKey(
    sortKey: string | undefined,
  ): 'created_at' | 'updated_at' | undefined {
    if (sortKey === undefined) return undefined;
    if (sortKey === 'created_at' || sortKey === 'updated_at') return sortKey;
    throw BusinessException.badRequest(
      ErrorCode.threads.invalidSortKey,
      'sortKey must be created_at or updated_at',
    );
  }

  private parseSortDirection(
    value: string | undefined,
  ): 'asc' | 'desc' | undefined {
    if (value === undefined) return undefined;
    if (value === 'asc' || value === 'desc') return value;
    throw BusinessException.badRequest(
      ErrorCode.threads.invalidSortKey,
      'sortDirection must be asc or desc',
    );
  }

  private parseItemsView(
    value: string | undefined,
  ): 'notLoaded' | 'summary' | 'full' | undefined {
    if (value === undefined) return undefined;
    if (value === 'notLoaded' || value === 'summary' || value === 'full') {
      return value;
    }
    throw BusinessException.badRequest(
      ErrorCode.threads.invalidInputField,
      'itemsView must be notLoaded, summary, or full',
    );
  }

  /** Parses fork options and rejects unsupported ephemeral fork requests. */
  private validateForkBody(body: ForkThreadDto | undefined): {
    carryGoal?: boolean;
    ephemeral?: boolean;
  } {
    if (body === undefined || body === null) return {};
    if (!this.isRecord(body)) {
      throw BusinessException.badRequest(
        ErrorCode.validation.bodyRequired,
        'Fork options must be an object',
      );
    }

    const carryGoal = this.readOptionalBoolean(body, 'carryGoal');
    const ephemeral = this.readOptionalBoolean(body, 'ephemeral');
    if (ephemeral === true) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidForkOptions,
        'Ephemeral forks are not supported by this endpoint',
      );
    }

    return {
      ...(carryGoal !== undefined && { carryGoal }),
      ...(ephemeral !== undefined && { ephemeral }),
    };
  }

  /** Reads an optional boolean from a plain request object. */
  private readOptionalBoolean(
    body: TurnInputRecord,
    field: string,
  ): boolean | undefined {
    const value = body[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
      throw BusinessException.badRequest(
        ErrorCode.validation.typeMismatch,
        `${field} must be a boolean`,
        { field, type: 'boolean' },
      );
    }
    return value;
  }

  private async validateTurnInput(input: unknown): Promise<v2.UserInput[]> {
    if (!Array.isArray(input) || input.length === 0) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidInput,
        'input must be a non-empty array',
      );
    }

    const validatedInput: v2.UserInput[] = [];
    for (const [index, item] of input.entries()) {
      validatedInput.push(await this.validateTurnInputItem(item, index));
    }
    return validatedInput;
  }

  /** Validates a single UserInput branch and resolves paths that need WebUI policy checks. */
  private async validateTurnInputItem(
    item: unknown,
    index: number,
  ): Promise<v2.UserInput> {
    if (!this.isRecord(item)) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidInputItem,
        `input[${index}] must be an object`,
        { index },
      );
    }

    switch (item.type) {
      case 'text':
        return this.validateTextInput(item, index);
      case 'image':
        return this.validateImageInput(item, index);
      case 'localImage':
        return this.validateLocalImageInput(item, index);
      case 'skill':
        return this.validateSkillInput(item, index);
      case 'mention':
        return this.validateMentionInput(item, index);
      default:
        throw BusinessException.badRequest(
          ErrorCode.threads.invalidInputType,
          `input[${index}].type must be one of ${USER_INPUT_TYPES.join(', ')}`,
          { index },
        );
    }
  }

  /** Normalizes text inputs and validates any inline absolute @mentions. */
  private async validateTextInput(
    item: TurnInputRecord,
    index: number,
  ): Promise<v2.UserInput> {
    const text = this.readString(item, 'text', index);
    await this.validateInlineTextMentions(text);
    return {
      type: 'text',
      text,
      text_elements: this.validateTextElements(item.text_elements, text, index),
    };
  }

  /** Validates a remote image URL, restricted to http/https schemes. */
  private validateImageInput(
    item: TurnInputRecord,
    index: number,
  ): v2.UserInput {
    const url = this.readRequiredString(item, 'url', index);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidInputUrl,
        `input[${index}].url must be a valid URL`,
        { index },
      );
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidInputUrl,
        `input[${index}].url must use http or https`,
        { index },
      );
    }
    return { type: 'image', url };
  }

  /** Ensures local images come only from the WebUI chat upload staging directory. */
  private async validateLocalImageInput(
    item: TurnInputRecord,
    index: number,
  ): Promise<v2.UserInput> {
    const localImagePath = this.readRequiredString(item, 'path', index);
    return {
      type: 'localImage',
      path: await this.chatUploadService.resolveStoredUploadPath(
        localImagePath,
      ),
    };
  }

  /** Validates skill mentions by shape; the skill source is resolved by skills/list. */
  private validateSkillInput(
    item: TurnInputRecord,
    index: number,
  ): v2.UserInput {
    return {
      type: 'skill',
      name: this.readRequiredString(item, 'name', index),
      path: this.readRequiredString(item, 'path', index),
    };
  }

  /** Resolves file mentions through FilesService so workspace-root policy is enforced. */
  private async validateMentionInput(
    item: TurnInputRecord,
    index: number,
  ): Promise<v2.UserInput> {
    const mentionPath = this.readRequiredString(item, 'path', index);
    return {
      type: 'mention',
      name: this.readRequiredString(item, 'name', index),
      path: await this.filesService.resolveSafePath(mentionPath),
    };
  }

  /**
   * Resolves absolute inline @mentions embedded in text through workspace policy.
   * Frontend sends file mentions inline as @/absolute/path, so the backend
   * remains the security boundary for path access.
   * Escaped spaces (`\ `) in paths are unescaped before validation.
   */
  private async validateInlineTextMentions(text: string): Promise<void> {
    // Match @/path where path can contain escaped spaces (\ ).
    // The escaped-space branch must come first because "\" is also non-whitespace.
    const inlineMentionPattern = /(^|\s)@(\/(?:\\ |[^\s])+)/g;
    const mentionPaths = new Set<string>();

    for (const match of text.matchAll(inlineMentionPattern)) {
      const rawPath = match[2];
      if (!rawPath) continue;
      // Unescape `\ ` back to real spaces
      const mentionPath = rawPath.replace(/\\ /g, ' ');
      if (mentionPath) {
        mentionPaths.add(mentionPath);
      }
    }

    for (const mentionPath of mentionPaths) {
      await this.filesService.resolveSafePath(mentionPath);
    }
  }

  /** Validates UI text spans while tolerating omitted text_elements for legacy clients. */
  private validateTextElements(
    value: unknown,
    text: string,
    inputIndex: number,
  ): v2.TextElement[] {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidInputField,
        `input[${inputIndex}].text_elements must be an array`,
        { index: inputIndex, field: 'text_elements' },
      );
    }

    const textByteLength = Buffer.byteLength(text, 'utf8');
    return value.map((element: unknown, elementIndex: number) => {
      if (!this.isRecord(element) || !this.isRecord(element.byteRange)) {
        throw BusinessException.badRequest(
          ErrorCode.threads.invalidInputField,
          `input[${inputIndex}].text_elements[${elementIndex}] must include byteRange`,
          {
            index: inputIndex,
            field: `text_elements[${elementIndex}].byteRange`,
          },
        );
      }

      const start = element.byteRange.start;
      const end = element.byteRange.end;
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        end > textByteLength
      ) {
        throw BusinessException.badRequest(
          ErrorCode.threads.invalidInputField,
          `input[${inputIndex}].text_elements[${elementIndex}].byteRange is invalid`,
          {
            index: inputIndex,
            field: `text_elements[${elementIndex}].byteRange`,
          },
        );
      }

      const placeholder = element.placeholder;
      if (
        placeholder !== undefined &&
        placeholder !== null &&
        typeof placeholder !== 'string'
      ) {
        throw BusinessException.badRequest(
          ErrorCode.threads.invalidInputField,
          `input[${inputIndex}].text_elements[${elementIndex}].placeholder must be a string or null`,
          {
            index: inputIndex,
            field: `text_elements[${elementIndex}].placeholder`,
          },
        );
      }

      const normalizedPlaceholder =
        typeof placeholder === 'string' ? placeholder : null;
      return {
        byteRange: { start, end },
        placeholder: normalizedPlaceholder,
      };
    });
  }

  /** Reads a required string field without trimming text content. */
  private readString(
    item: TurnInputRecord,
    field: string,
    index: number,
  ): string {
    const value = item[field];
    if (typeof value !== 'string') {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidInputField,
        `input[${index}].${field} must be a string`,
        { index, field },
      );
    }
    return value;
  }

  /** Reads a required string field and rejects empty values after trimming. */
  private readRequiredString(
    item: TurnInputRecord,
    field: string,
    index: number,
  ): string {
    const value = this.readString(item, field, index).trim();
    if (value.length === 0) {
      throw BusinessException.badRequest(
        ErrorCode.threads.invalidInputField,
        `input[${index}].${field} must be a non-empty string`,
        { index, field },
      );
    }
    return value;
  }

  /** Type guard for objects that can be inspected safely. */
  private isRecord(value: unknown): value is TurnInputRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
