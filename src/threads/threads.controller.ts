/**
 * REST controller for thread and turn operations.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
import { REASONING_EFFORT_VALUES } from '../codex/dto/v2/openapi.schema';
import { FilesService } from '../files/files.service';
import { ThreadsService } from './threads.service';
import {
  CODEX_V2_EXTRA_MODELS,
  CreateThreadDto,
  StartTurnDto,
  ThreadForkResponseDto,
  ThreadListResponseDto,
  ThreadLoadedListResponseDto,
  ThreadReadResponseDto,
  ThreadResumeResponseDto,
  SteerTurnDto,
  ThreadRollbackRequestDto,
  ThreadRollbackResponseDto,
  ThreadSetNameRequestDto,
  ThreadStartResponseDto,
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

@ApiTags('threads')
@ApiBearerAuth()
@ApiExtraModels(...CODEX_V2_EXTRA_MODELS, ApiErrorResponseDto, OkResponseDto)
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
      experimentalRawEvents: false,
      persistExtendedHistory: true,
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
      throw new BadRequestException('limit must be a positive number');
    }
    if (
      sortKey !== undefined &&
      sortKey !== 'created_at' &&
      sortKey !== 'updated_at'
    ) {
      throw new BadRequestException('sortKey must be created_at or updated_at');
    }

    return this.threadsService.listThreads({
      cursor,
      limit: parsedLimit,
      archived: archived === 'true' ? true : undefined,
      searchTerm,
      cwd,
      sortKey: sortKey,
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
      throw new BadRequestException('limit must be a positive number');
    }

    return this.threadsService.listLoadedThreads({
      cursor,
      limit: parsedLimit,
    });
  }

  @Get(':threadId')
  @ApiOperation({ summary: 'Read a thread by ID' })
  @ApiQuery({ name: 'includeTurns', required: false, type: Boolean })
  @ApiOkResponse({ type: ThreadReadResponseDto })
  async readThread(
    @Param('threadId') threadId: string,
    @Query('includeTurns') includeTurns?: string,
  ) {
    return this.threadsService.readThread(threadId, includeTurns === 'true');
  }

  @Post(':threadId/resume')
  @ApiOperation({ summary: 'Resume a thread and subscribe to events' })
  @ApiCreatedResponse({ type: ThreadResumeResponseDto })
  async resumeThread(@Param('threadId') threadId: string) {
    return this.threadsService.resumeThread(threadId);
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
      throw new BadRequestException('model must be a non-empty string');
    }
    const effort = typeof body.effort === 'string' ? body.effort : null;
    if (body.effort !== undefined && !effort) {
      throw new BadRequestException('Invalid reasoning effort');
    }
    if (
      effort &&
      !(REASONING_EFFORT_VALUES as readonly string[]).includes(effort)
    ) {
      throw new BadRequestException('Invalid reasoning effort');
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

  @Post(':threadId/fork')
  @ApiOperation({ summary: 'Fork a thread' })
  @ApiCreatedResponse({ type: ThreadForkResponseDto })
  async forkThread(@Param('threadId') threadId: string) {
    return this.threadsService.forkThread(threadId);
  }

  @Post(':threadId/rollback')
  @ApiOperation({ summary: 'Rollback turns from a thread' })
  @ApiBody({ type: ThreadRollbackRequestDto })
  @ApiCreatedResponse({ type: ThreadRollbackResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  async rollbackThread(
    @Param('threadId') threadId: string,
    @Body() body: ThreadRollbackRequestDto,
  ) {
    if (
      typeof body?.numTurns !== 'number' ||
      !Number.isInteger(body.numTurns) ||
      body.numTurns < 1
    ) {
      throw new BadRequestException('numTurns must be a positive integer');
    }
    return this.threadsService.rollbackThread(threadId, body.numTurns);
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
      throw new BadRequestException('name must be a non-empty string');
    }
    const name = body.name.trim();
    if (name.length === 0) {
      throw new BadRequestException('name must be a non-empty string');
    }
    await this.threadsService.setThreadName(threadId, name);
  }

  /** Validates and normalizes the discriminated UserInput union accepted by Codex. */
  private async validateTurnInput(input: unknown): Promise<v2.UserInput[]> {
    if (!Array.isArray(input) || input.length === 0) {
      throw new BadRequestException('input must be a non-empty array');
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
      throw new BadRequestException(`input[${index}] must be an object`);
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
        throw new BadRequestException(
          `input[${index}].type must be one of ${USER_INPUT_TYPES.join(', ')}`,
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
      throw new BadRequestException(`input[${index}].url must be a valid URL`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new BadRequestException(
        `input[${index}].url must use http or https`,
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
      throw new BadRequestException(
        `input[${inputIndex}].text_elements must be an array`,
      );
    }

    const textByteLength = Buffer.byteLength(text, 'utf8');
    return value.map((element: unknown, elementIndex: number) => {
      if (!this.isRecord(element) || !this.isRecord(element.byteRange)) {
        throw new BadRequestException(
          `input[${inputIndex}].text_elements[${elementIndex}] must include byteRange`,
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
        throw new BadRequestException(
          `input[${inputIndex}].text_elements[${elementIndex}].byteRange is invalid`,
        );
      }

      const placeholder = element.placeholder;
      if (
        placeholder !== undefined &&
        placeholder !== null &&
        typeof placeholder !== 'string'
      ) {
        throw new BadRequestException(
          `input[${inputIndex}].text_elements[${elementIndex}].placeholder must be a string or null`,
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
      throw new BadRequestException(
        `input[${index}].${field} must be a string`,
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
      throw new BadRequestException(
        `input[${index}].${field} must be a non-empty string`,
      );
    }
    return value;
  }

  /** Type guard for objects that can be inspected safely. */
  private isRecord(value: unknown): value is TurnInputRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
