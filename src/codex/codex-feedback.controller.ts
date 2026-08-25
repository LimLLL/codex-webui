/** REST controller for Codex feedback uploads. */
import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { BusinessException } from '../common/business.exception';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { ErrorCode } from '../common/error-codes';
import type { v2 } from './codex-schema';
import { CodexService } from './codex.service';
import {
  FeedbackUploadRequestDto,
  FeedbackUploadResponseDto,
} from './dto/codex-feedback.dto';

type FeedbackBodyRecord = Record<string, unknown>;

@ApiTags('codex')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@Controller('codex/feedback')
export class CodexFeedbackController {
  constructor(private readonly codex: CodexService) {}

  /** Uploads a feedback report through Codex app-server. */
  @Post()
  @ApiOperation({ summary: 'Upload a Codex feedback report' })
  @ApiCreatedResponse({ type: FeedbackUploadResponseDto })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  uploadFeedback(
    @Body() body: FeedbackUploadRequestDto,
  ): Promise<v2.FeedbackUploadResponse> {
    return this.codex.request<v2.FeedbackUploadResponse>(
      'feedback/upload',
      this.validateFeedback(body),
    );
  }

  /** Validates and normalizes feedback upload input at the REST boundary. */
  private validateFeedback(
    body: FeedbackUploadRequestDto,
  ): v2.FeedbackUploadParams {
    if (!this.isRecord(body)) {
      throw BusinessException.badRequest(
        ErrorCode.validation.bodyRequired,
        'Request body is required',
      );
    }

    const classification = this.readRequiredString(body, 'classification');
    const reason = this.readOptionalString(body, 'reason');
    const threadId = this.readOptionalString(body, 'threadId');
    const includeLogs = this.readOptionalBoolean(body, 'includeLogs') ?? false;
    const tags = this.readOptionalStringMap(body, 'tags');

    return {
      classification,
      ...(reason !== null && { reason }),
      ...(threadId !== null && { threadId }),
      includeLogs,
      ...(tags !== null && { tags }),
    };
  }

  /** Reads a required trimmed string from the request body. */
  private readRequiredString(body: FeedbackBodyRecord, field: string): string {
    const value = body[field];
    if (typeof value !== 'string') {
      throw BusinessException.badRequest(
        ErrorCode.codex.invalidFeedback,
        `${field} must be a non-empty string`,
      );
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw BusinessException.badRequest(
        ErrorCode.codex.invalidFeedback,
        `${field} must be a non-empty string`,
      );
    }
    return trimmed;
  }

  /** Reads an optional trimmed string, normalizing blank values to null. */
  private readOptionalString(
    body: FeedbackBodyRecord,
    field: string,
  ): string | null {
    const value = body[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      throw BusinessException.badRequest(
        ErrorCode.codex.invalidFeedback,
        `${field} must be a string or null`,
      );
    }
    const trimmed = value.trim();
    return trimmed || null;
  }

  /** Reads an optional boolean from the request body. */
  private readOptionalBoolean(
    body: FeedbackBodyRecord,
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

  /** Reads an optional string map for feedback tags. */
  private readOptionalStringMap(
    body: FeedbackBodyRecord,
    field: string,
  ): Record<string, string> | null {
    const value = body[field];
    if (value === undefined || value === null) return null;
    if (!this.isRecord(value)) {
      throw BusinessException.badRequest(
        ErrorCode.codex.invalidFeedback,
        `${field} must be an object`,
      );
    }

    const result: Record<string, string> = {};
    for (const [key, tagValue] of Object.entries(value)) {
      if (typeof tagValue !== 'string') {
        throw BusinessException.badRequest(
          ErrorCode.codex.invalidFeedback,
          `${field}.${key} must be a string`,
        );
      }
      result[key] = tagValue;
    }
    return result;
  }

  /** Type guard for plain request objects. */
  private isRecord(value: unknown): value is FeedbackBodyRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
