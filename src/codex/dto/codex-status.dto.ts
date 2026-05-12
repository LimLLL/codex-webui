import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { jsonValueSchema } from './v2/openapi.schema';

export const CODEX_RUNTIME_STATUS_VALUES = [
  'ready',
  'degraded',
  'unavailable',
] as const;

/** Error metadata for a single Codex status probe. */
export class CodexStatusErrorDto {
  @ApiProperty()
  message!: string;

  @ApiPropertyOptional()
  code?: string;
}

/** Codex app-server process and initialization state. */
export class CodexAppServerStatusDto {
  @ApiProperty()
  ok!: boolean;

  @ApiProperty()
  connected!: boolean;

  @ApiProperty()
  initialized!: boolean;

  @ApiPropertyOptional({ type: () => CodexStatusErrorDto })
  error?: CodexStatusErrorDto;
}

/** Initialize response section returned by Codex app-server. */
export class CodexInitializeStatusDto {
  @ApiProperty()
  ok!: boolean;

  @ApiProperty(jsonValueSchema(true))
  data!: unknown;

  @ApiPropertyOptional({ type: () => CodexStatusErrorDto })
  error?: CodexStatusErrorDto;
}

/** Raw account/read probe result. */
export class CodexAccountStatusDto {
  @ApiProperty()
  ok!: boolean;

  @ApiPropertyOptional(jsonValueSchema(true))
  data?: unknown;

  @ApiPropertyOptional({ type: () => CodexStatusErrorDto })
  error?: CodexStatusErrorDto;
}

/** Sanitized config/read summary safe for browser display. */
export class CodexConfigSummaryDto {
  @ApiProperty({ type: String, nullable: true })
  sandboxMode!: string | null;

  @ApiProperty({ type: Boolean, nullable: true })
  sandboxNetworkAccess!: boolean | null;

  @ApiProperty(jsonValueSchema(true))
  approvalPolicy!: unknown;

  @ApiProperty({ type: String, nullable: true })
  model!: string | null;

  @ApiProperty({ type: String, nullable: true })
  modelProvider!: string | null;
}

/** Sanitized config/read probe result. */
export class CodexConfigStatusDto {
  @ApiProperty()
  ok!: boolean;

  @ApiPropertyOptional({ type: () => CodexConfigSummaryDto })
  data?: CodexConfigSummaryDto;

  @ApiPropertyOptional({ type: () => CodexStatusErrorDto })
  error?: CodexStatusErrorDto;
}

/** Provider credential visibility derived from config/read. */
export class CodexProviderStatusDto {
  @ApiProperty()
  ok!: boolean;

  @ApiProperty({ type: String, nullable: true })
  id!: string | null;

  @ApiProperty({ type: String, nullable: true })
  envKey!: string | null;

  @ApiProperty({ type: Boolean, nullable: true })
  envPresent!: boolean | null;

  @ApiPropertyOptional({ type: () => CodexStatusErrorDto })
  error?: CodexStatusErrorDto;
}

/** model/list probe result and summarized default model information. */
export class CodexModelsStatusDto {
  @ApiProperty()
  ok!: boolean;

  @ApiProperty()
  listable!: boolean;

  @ApiProperty({ type: String, nullable: true })
  defaultModel!: string | null;

  @ApiProperty()
  count!: number;

  @ApiPropertyOptional(jsonValueSchema(true))
  data?: unknown;

  @ApiPropertyOptional({ type: () => CodexStatusErrorDto })
  error?: CodexStatusErrorDto;
}

/** Overall runtime status derived from all status probe sections. */
export class CodexRuntimeStatusDto {
  @ApiProperty({ enum: CODEX_RUNTIME_STATUS_VALUES })
  status!: (typeof CODEX_RUNTIME_STATUS_VALUES)[number];

  @ApiProperty({ type: [String] })
  reasons!: string[];

  @ApiProperty()
  checkedAt!: string;

  @ApiProperty()
  cacheTtlMs!: number;
}

/** Aggregated Codex app-server status response. */
export class CodexStatusResponseDto {
  @ApiProperty({ type: () => CodexAppServerStatusDto })
  appServer!: CodexAppServerStatusDto;

  @ApiProperty({ type: () => CodexInitializeStatusDto })
  initialize!: CodexInitializeStatusDto;

  @ApiProperty({ type: () => CodexAccountStatusDto })
  account!: CodexAccountStatusDto;

  @ApiProperty({ type: () => CodexConfigStatusDto })
  config!: CodexConfigStatusDto;

  @ApiProperty({ type: () => CodexProviderStatusDto })
  provider!: CodexProviderStatusDto;

  @ApiProperty({ type: () => CodexModelsStatusDto })
  models!: CodexModelsStatusDto;

  @ApiProperty({ type: () => CodexRuntimeStatusDto })
  runtime!: CodexRuntimeStatusDto;
}
