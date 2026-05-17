/** REST controller for experimental Codex apps/connectors. */
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { v2 } from '../codex/codex-schema';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { AppsListResponseDto } from './dto/apps.dto';
import { AppsService } from './apps.service';

@ApiTags('apps')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@ApiBadRequestResponse({ type: ApiErrorResponseDto })
@Controller('apps')
export class AppsController {
  constructor(private readonly appsService: AppsService) {}

  /** Lists available apps/connectors with optional pagination. */
  @Get()
  @ApiOperation({ summary: 'List Codex apps/connectors' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'threadId', required: false })
  @ApiQuery({ name: 'forceRefetch', required: false, type: Boolean })
  @ApiOkResponse({ type: AppsListResponseDto })
  listApps(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('threadId') threadId?: string,
    @Query('forceRefetch') forceRefetch?: string,
  ): Promise<v2.AppsListResponse> {
    return this.appsService.listApps({
      cursor: cursor?.trim() || undefined,
      limit: this.parseLimit(limit),
      threadId: threadId?.trim() || undefined,
      forceRefetch: this.parseOptionalBoolean(forceRefetch, 'forceRefetch'),
    });
  }

  private parseLimit(value?: string): number | undefined {
    if (!value) return undefined;
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException(
        'limit must be an integer between 1 and 100',
      );
    }
    return limit;
  }

  private parseOptionalBoolean(
    value: string | undefined,
    field: string,
  ): boolean | undefined {
    if (value === undefined) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new BadRequestException(`${field} must be a boolean`);
  }
}
