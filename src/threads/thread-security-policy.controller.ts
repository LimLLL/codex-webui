/** Thread-scoped policy API: observations are separate from queued mutations. */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Patch,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { v2 } from '../codex/codex-schema';
import { CodexService } from '../codex/codex.service';
import { CODEX_V2_EXTRA_MODELS } from '../codex/dto/v2';
import { BusinessException } from '../common/business.exception';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { ErrorCode } from '../common/error-codes';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import {
  PatchThreadSecurityPolicyDto,
  ThreadPolicyAcceptedDto,
  ThreadSecurityPolicyDto,
} from './dto/thread-security-policy.dto';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';
import { validateThreadSecurityPolicy } from './thread-security-policy.validation';

@ApiTags('threads')
@ApiBearerAuth()
@ApiExtraModels(...CODEX_V2_EXTRA_MODELS, ApiErrorResponseDto)
@Controller('threads')
export class ThreadSecurityPolicyController {
  private readonly logger = new Logger(ThreadSecurityPolicyController.name);

  constructor(
    private readonly codex: CodexService,
    private readonly settingsObserver: ThreadSettingsObserverService,
    private readonly deletionRegistry: ThreadDeletionRegistryService,
  ) {}

  /** Reads observations only; never resumes a thread or substitutes global defaults. */
  @Get(':threadId/security-policy')
  @ApiOperation({ summary: 'Read observed next-turn security policy' })
  @ApiOkResponse({ type: ThreadSecurityPolicyDto })
  readSecurityPolicy(
    @Param('threadId') threadId: string,
  ): ThreadSecurityPolicyDto {
    return this.settingsObserver.readSecurityPolicy(threadId);
  }

  /**
   * Queues a validated next-turn policy change on an already loaded thread.
   * Metadata reads do not acquire writer ownership. Upstream remains authoritative
   * for parent-owned children, managed restrictions, and unload races.
   * @returns Queued acknowledgement, never a fabricated effective-settings value
   * @throws If validation, writability, deletion, or upstream policy checks fail
   */
  @Patch(':threadId/security-policy')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Queue next-turn security policy; current turn is unchanged',
  })
  @ApiBody({ type: PatchThreadSecurityPolicyDto })
  @ApiAcceptedResponse({ type: ThreadPolicyAcceptedDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiConflictResponse({ type: ApiErrorResponseDto })
  async patchSecurityPolicy(
    @Param('threadId') threadId: string,
    @Body() body: PatchThreadSecurityPolicyDto,
  ): Promise<ThreadPolicyAcceptedDto> {
    const patch = validateThreadSecurityPolicy(body);
    this.deletionRegistry.assertMutable(threadId);
    this.logger.debug(
      { threadId, fields: Object.keys(patch) },
      'Queueing thread security policy',
    );
    const { thread } = await this.codex.request<v2.ThreadReadResponse>(
      'thread/read',
      {
        threadId,
        includeTurns: false,
      },
    );
    if (thread.status.type === 'notLoaded') {
      this.logger.debug(
        { threadId },
        'Refused policy change for an unloaded thread',
      );
      throw BusinessException.conflict(
        ErrorCode.threads.threadNotLoaded,
        'Open this conversation for writing before changing its security policy',
      );
    }
    this.deletionRegistry.assertMutable(threadId);
    await this.codex.request<Record<string, never>>('thread/settings/update', {
      threadId,
      ...patch,
    });
    return { status: 'accepted' };
  }
}
