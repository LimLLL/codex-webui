import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { jsonValueSchema } from '../../codex/dto/v2/openapi.schema';

/** Query parameters for reading structured application logs. */
export class LogsQueryDto {
  @ApiPropertyOptional({ default: 0 })
  offset?: number;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  limit?: number;

  @ApiPropertyOptional({
    enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
  })
  level?: string;

  @ApiPropertyOptional()
  source?: string;
}

/** A single sanitized structured log entry. */
export class LogEntryDto {
  @ApiProperty()
  timestamp!: string;

  @ApiProperty({
    enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'],
  })
  level!: string;

  @ApiProperty()
  source!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty(jsonValueSchema(true))
  fields!: unknown;
}

/** Paginated log list response. */
export class LogsResponseDto {
  @ApiProperty({ type: [LogEntryDto] })
  data!: LogEntryDto[];

  @ApiProperty()
  offset!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  hasMore!: boolean;
}

/** Basic runtime metadata bundled with exported diagnostics. */
export class LogsSystemInfoDto {
  @ApiProperty()
  nodeVersion!: string;

  @ApiProperty()
  platform!: string;

  @ApiProperty()
  arch!: string;

  @ApiProperty()
  uptimeSeconds!: number;

  @ApiProperty()
  codexVersion!: string;
}

/** Sanitized support bundle for issue reporting. */
export class LogsExportResponseDto {
  @ApiProperty()
  exportedAt!: string;

  @ApiProperty({ type: () => LogsSystemInfoDto })
  system!: LogsSystemInfoDto;

  @ApiProperty(jsonValueSchema(true))
  runtimeStatus!: unknown;

  @ApiProperty({ type: [LogEntryDto] })
  logs!: LogEntryDto[];
}
