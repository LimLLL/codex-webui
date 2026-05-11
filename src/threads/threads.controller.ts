/**
 * REST controller for thread and turn operations.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ThreadsService } from './threads.service';

@ApiTags('threads')
@ApiBearerAuth()
@Controller('threads')
export class ThreadsController {
  constructor(private readonly threadsService: ThreadsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new thread' })
  async startThread(
    @Body()
    body: {
      model?: string;
      cwd?: string;
      approvalPolicy?: string;
    },
  ) {
    return this.threadsService.startThread({
      model: body.model,
      cwd: body.cwd,
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
  async listThreads(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('archived') archived?: string,
    @Query('searchTerm') searchTerm?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;
    if (parsedLimit !== undefined && (isNaN(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException('limit must be a positive number');
    }

    return this.threadsService.listThreads({
      cursor,
      limit: parsedLimit,
      archived: archived === 'true' ? true : undefined,
      searchTerm,
    });
  }

  @Get(':threadId')
  @ApiOperation({ summary: 'Read a thread by ID' })
  @ApiQuery({ name: 'includeTurns', required: false, type: Boolean })
  async readThread(
    @Param('threadId') threadId: string,
    @Query('includeTurns') includeTurns?: string,
  ) {
    return this.threadsService.readThread(threadId, includeTurns === 'true');
  }

  @Post(':threadId/resume')
  @ApiOperation({ summary: 'Resume a thread and subscribe to events' })
  async resumeThread(@Param('threadId') threadId: string) {
    return this.threadsService.resumeThread(threadId);
  }

  @Post(':threadId/turns')
  @ApiOperation({ summary: 'Start a new turn (send message)' })
  async startTurn(
    @Param('threadId') threadId: string,
    @Body() body: { input: Array<{ type: string; text?: string }> },
  ) {
    if (!Array.isArray(body.input) || body.input.length === 0) {
      throw new BadRequestException('input must be a non-empty array');
    }
    return this.threadsService.startTurn({
      threadId,
      input: body.input as never,
    });
  }

  @Post(':threadId/turns/:turnId/interrupt')
  @ApiOperation({ summary: 'Interrupt an in-progress turn' })
  async interruptTurn(
    @Param('threadId') threadId: string,
    @Param('turnId') turnId: string,
  ) {
    await this.threadsService.interruptTurn(threadId, turnId);
    return { ok: true };
  }
}
