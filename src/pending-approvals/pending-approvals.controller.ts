/** REST controller for persisted app-server approval requests. */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  PendingServerRequestDto,
  PendingServerRequestsResponseDto,
  PendingRequestResolvedDto,
  RespondPendingServerRequestDto,
} from './dto/pending-approvals.dto';
import { PendingApprovalsService } from './pending-approvals.service';
import {
  PatchChangeKindAddDto,
  PatchChangeKindDeleteDto,
  PatchChangeKindUpdateDto,
} from '../codex/dto/v2/support.dto';

@ApiTags('pending-approvals')
@ApiBearerAuth()
@ApiExtraModels(
  PatchChangeKindAddDto,
  PatchChangeKindDeleteDto,
  PatchChangeKindUpdateDto,
  PendingRequestResolvedDto,
)
@Controller('pending-approvals')
export class PendingApprovalsController {
  constructor(private readonly approvals: PendingApprovalsService) {}

  @Get()
  @ApiOperation({ summary: 'List pending approval requests' })
  @ApiQuery({ name: 'threadIds', required: false })
  @ApiOkResponse({ type: PendingServerRequestsResponseDto })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description:
      'A deletion intersects this read scope. No snapshot is returned; retry on the pending-change hint after guard release.',
  })
  /** Returns a complete scoped set, never a successful list with temporarily suppressed rows missing. */
  listPending(
    @Query('threadIds') threadIds?: string,
  ): PendingServerRequestsResponseDto {
    const ids = threadIds
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    return this.approvals.readPending(ids);
  }

  @Post(':requestId/respond')
  @ApiOperation({ summary: 'Respond to a pending approval request' })
  @ApiOkResponse({ type: PendingServerRequestDto })
  /** Commits the first response to a still-pending request and forwards it to app-server. */
  respond(
    @Param('requestId') requestId: string,
    @Body() body: RespondPendingServerRequestDto,
  ): PendingServerRequestDto {
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'result')) {
      throw BusinessException.badRequest(
        ErrorCode.approvals.resultRequired,
        'result is required',
      );
    }
    return this.approvals.respondToRequest(
      requestId,
      body.result,
      body.clientId,
    );
  }
}
