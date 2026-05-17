import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { jsonValueSchema } from '../../codex/dto/v2/openapi.schema';

export const MCP_SERVER_STATUS_DETAIL_VALUES = [
  'full',
  'toolsAndAuthOnly',
] as const;

export const MCP_SERVER_STARTUP_STATE_VALUES = [
  'starting',
  'ready',
  'failed',
  'cancelled',
] as const;

/** Query params for mcpServerStatus/list. */
export class ListMcpServersQueryDto {
  @ApiPropertyOptional()
  cursor?: string;

  @ApiPropertyOptional({ type: Number })
  limit?: number;

  @ApiPropertyOptional({ enum: MCP_SERVER_STATUS_DETAIL_VALUES })
  detail?: (typeof MCP_SERVER_STATUS_DETAIL_VALUES)[number];
}

/** Raw MCP server status list. Tool/resource schemas are dynamic MCP payloads. */
export class McpServersListResponseDto {
  @ApiProperty({
    type: 'array',
    items: jsonValueSchema(false) as Record<string, unknown>,
  })
  data!: unknown[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

/** Response for config/mcpServer/reload. */
export class McpServersReloadResponseDto {
  @ApiProperty()
  ok!: boolean;
}

/** Request body for mcpServer/oauth/login. */
export class McpServerOauthLoginRequestDto {
  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ type: [String] })
  scopes?: string[];

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 600 })
  timeoutSecs?: number;
}

/** Response for mcpServer/oauth/login. */
export class McpServerOauthLoginResponseDto {
  @ApiProperty()
  authorizationUrl!: string;
}
