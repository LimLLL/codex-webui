/** REST endpoint for persisted per-turn token usage snapshots. */
import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { ThreadTokenUsageResponseDto } from './dto/token-usage.dto';
import { TokenUsageService } from './token-usage.service';

@ApiTags('threads')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@Controller('threads')
export class TokenUsageController {
  constructor(private readonly tokenUsageService: TokenUsageService) {}

  @Get(':threadId/token-usage')
  @ApiOperation({
    summary: 'Read persisted token usage snapshots for a thread',
  })
  @ApiOkResponse({ type: ThreadTokenUsageResponseDto })
  readThreadTokenUsage(
    @Param('threadId') threadId: string,
  ): ThreadTokenUsageResponseDto {
    return this.tokenUsageService.readThreadUsage(threadId);
  }
}
