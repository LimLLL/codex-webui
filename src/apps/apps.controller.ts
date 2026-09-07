/** REST controller for experimental Codex apps/connectors. */
import { Controller, Get, Query } from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
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
import { AppsListResponseDto, AppsReadResponseDto } from './dto/apps.dto';
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

  /** Reads metadata for one or more apps/connectors by id. */
  @Get('detail')
  @ApiOperation({ summary: 'Read Codex app metadata' })
  @ApiQuery({ name: 'appIds', required: true, isArray: true, type: String })
  @ApiQuery({ name: 'threadId', required: false })
  @ApiQuery({ name: 'includeTools', required: false, type: Boolean })
  @ApiOkResponse({ type: AppsReadResponseDto })
  readApps(
    @Query('appIds') appIds?: string | string[],
    @Query('threadId') threadId?: string,
    @Query('includeTools') includeTools?: string,
  ): Promise<v2.AppsReadResponse> {
    const ids = this.parseAppIdList(appIds);
    if (ids.length === 0) {
      throw BusinessException.badRequest(
        ErrorCode.validation.fieldRequired,
        'appIds is required',
        { field: 'appIds' },
      );
    }
    if (ids.length > 100) {
      throw BusinessException.badRequest(
        ErrorCode.validation.fieldInvalid,
        'appIds must contain at most 100 ids',
        { field: 'appIds' },
      );
    }
    return this.appsService.readApps({
      appIds: ids,
      threadId: threadId?.trim() || undefined,
      includeTools: this.parseOptionalBoolean(includeTools, 'includeTools'),
    });
  }

  private parseLimit(value?: string): number | undefined {
    if (!value) return undefined;
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw BusinessException.badRequest(
        ErrorCode.validation.fieldInvalid,
        'limit must be an integer between 1 and 100',
        { field: 'limit' },
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
    throw BusinessException.badRequest(
      ErrorCode.validation.typeMismatch,
      `${field} must be a boolean`,
      { field, type: 'boolean' },
    );
  }

  private parseAppIdList(value?: string | string[]): string[] {
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : value.split(',');
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const raw of values) {
      const trimmed = raw.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      ids.push(trimmed);
    }
    return ids;
  }
}
