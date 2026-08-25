/** REST endpoints for branch adoption diagnostics and destructive deletion. */
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  BranchAdoptionDiagnosticDto,
  BranchAdoptionStatusDto,
} from '../conversation-branches/dto/conversation-branches.dto';
import { ConversationBranchAdoptionService } from '../conversation-branches/conversation-branch-adoption.service';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import {
  ThreadDeleteBlockerDto,
  ThreadDeleteFailureDto,
  ThreadDeletePlanThreadDto,
  ThreadDeletePreviewDto,
  ThreadDeleteRequestDto,
  ThreadDeleteResultDto,
} from './dto/thread-deletion.dto';
import { ThreadsDeletionService } from './threads-deletion.service';

@ApiTags('threads')
@ApiBearerAuth()
@ApiExtraModels(
  ApiErrorResponseDto,
  BranchAdoptionDiagnosticDto,
  BranchAdoptionStatusDto,
  ThreadDeleteBlockerDto,
  ThreadDeleteFailureDto,
  ThreadDeletePlanThreadDto,
  ThreadDeletePreviewDto,
  ThreadDeleteRequestDto,
  ThreadDeleteResultDto,
)
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@Controller('threads')
export class ThreadsDeletionController {
  constructor(
    private readonly adoption: ConversationBranchAdoptionService,
    private readonly deletion: ThreadsDeletionService,
  ) {}

  @Get('branch-adoption/status')
  @ApiOperation({ summary: 'Read startup branch adoption scanner status' })
  @ApiOkResponse({ type: BranchAdoptionStatusDto })
  readBranchAdoptionStatus() {
    return this.adoption.getStatus();
  }

  @Get(':threadId/delete-preview')
  @ApiOperation({
    summary: 'Preview deleting a thread and all fork descendants',
  })
  @ApiOkResponse({ type: ThreadDeletePreviewDto })
  previewDelete(@Param('threadId') threadId: string) {
    return this.deletion.previewDelete(threadId);
  }

  @Post(':threadId/delete')
  @ApiOperation({
    summary: 'Delete a thread and all fork descendants after confirmation',
  })
  @ApiBody({ type: ThreadDeleteRequestDto })
  @ApiOkResponse({ type: ThreadDeleteResultDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  deleteThread(
    @Param('threadId') threadId: string,
    @Body() body: ThreadDeleteRequestDto,
  ) {
    return this.deletion.deleteThread(threadId, body);
  }
}
