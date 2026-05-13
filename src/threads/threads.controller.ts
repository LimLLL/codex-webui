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
import {
  ApiErrorResponseDto,
  OkResponseDto,
} from '../common/dto/api-responses.dto';
import type { v2 } from '../codex/codex-schema';
import { ThreadsService } from './threads.service';
import {
  CODEX_V2_EXTRA_MODELS,
  CreateThreadDto,
  StartTurnDto,
  ThreadForkResponseDto,
  ThreadListResponseDto,
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

@ApiTags('threads')
@ApiBearerAuth()
@ApiExtraModels(...CODEX_V2_EXTRA_MODELS, ApiErrorResponseDto, OkResponseDto)
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@Controller('threads')
export class ThreadsController {
  constructor(private readonly threadsService: ThreadsService) {}

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
    if (!Array.isArray(body.input) || body.input.length === 0) {
      throw new BadRequestException('input must be a non-empty array');
    }
    return this.threadsService.startTurn({
      threadId,
      input: body.input as never,
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
    if (!Array.isArray(body.input) || body.input.length === 0) {
      throw new BadRequestException('input must be a non-empty array');
    }
    return this.threadsService.steerTurn({
      threadId,
      expectedTurnId: turnId,
      input: body.input as never,
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
}
