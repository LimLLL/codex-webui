import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { recordOfSchema } from './v2/openapi.schema';

/** Request body for uploading user feedback through Codex app-server. */
export class FeedbackUploadRequestDto {
  @ApiProperty({ minLength: 1 })
  classification!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  reason?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  threadId?: string | null;

  @ApiPropertyOptional({
    default: false,
    description: 'Whether Codex should attach logs to the feedback report.',
  })
  includeLogs?: boolean;

  @ApiPropertyOptional({
    ...recordOfSchema({ type: 'string' }),
    nullable: true,
  })
  tags?: Record<string, string> | null;
}

/** Response body from Codex feedback upload. */
export class FeedbackUploadResponseDto {
  /**
   * Tracking thread id assigned to the feedback report itself. This is NOT the
   * conversation the feedback was filed against, which the request carries.
   */
  @ApiProperty({
    description:
      'Tracking thread id for the submitted report, not the conversation it refers to.',
  })
  threadId!: string;
}
