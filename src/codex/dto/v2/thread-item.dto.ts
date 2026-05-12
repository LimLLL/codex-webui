import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  type SwaggerSchema,
  COLLAB_AGENT_TOOL_CALL_STATUS_VALUES,
  COLLAB_AGENT_TOOL_VALUES,
  COMMAND_EXECUTION_SOURCE_VALUES,
  COMMAND_EXECUTION_STATUS_VALUES,
  DYNAMIC_TOOL_CALL_STATUS_VALUES,
  MCP_TOOL_CALL_STATUS_VALUES,
  MESSAGE_PHASE_VALUES,
  NULLABLE_BOOLEAN_SCHEMA,
  NULLABLE_NUMBER_SCHEMA,
  NULLABLE_STRING_SCHEMA,
  PATCH_APPLY_STATUS_VALUES,
  REASONING_EFFORT_VALUES,
  jsonValueSchema,
  nullableStringEnumSchema,
  oneOfSchema,
  recordOfSchema,
} from './openapi.schema';
import {
  CollabAgentStateDto,
  FileUpdateChangeDto,
  HookPromptFragmentDto,
  McpToolCallErrorDto,
  McpToolCallResultDto,
  MemoryCitationDto,
  commandActionSchema,
  dynamicToolCallOutputContentItemSchema,
  userInputSchema,
  webSearchActionSchema,
} from './support.dto';

/** v2 ThreadItem branch for persisted user messages. */
export class UserMessageThreadItemDto {
  @ApiProperty({ enum: ['userMessage'] })
  type!: 'userMessage';

  @ApiProperty()
  id!: string;

  @ApiProperty({
    type: 'array',
    items: userInputSchema(false) as Record<string, unknown>,
  })
  content!: unknown[];
}

/** v2 ThreadItem branch for hook prompts. */
export class HookPromptThreadItemDto {
  @ApiProperty({ enum: ['hookPrompt'] })
  type!: 'hookPrompt';

  @ApiProperty()
  id!: string;

  @ApiProperty({ type: () => [HookPromptFragmentDto] })
  fragments!: HookPromptFragmentDto[];
}

/** v2 ThreadItem branch for assistant messages. */
export class AgentMessageThreadItemDto {
  @ApiProperty({ enum: ['agentMessage'] })
  type!: 'agentMessage';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  text!: string;

  @ApiProperty(nullableStringEnumSchema(MESSAGE_PHASE_VALUES))
  phase!: (typeof MESSAGE_PHASE_VALUES)[number] | null;

  @ApiProperty({
    nullable: true,
    oneOf: [{ $ref: getSchemaPath(MemoryCitationDto) }],
  })
  memoryCitation!: MemoryCitationDto | null;
}

/** v2 ThreadItem branch for plan text. */
export class PlanThreadItemDto {
  @ApiProperty({ enum: ['plan'] })
  type!: 'plan';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  text!: string;
}

/** v2 ThreadItem branch for reasoning summaries. */
export class ReasoningThreadItemDto {
  @ApiProperty({ enum: ['reasoning'] })
  type!: 'reasoning';

  @ApiProperty()
  id!: string;

  @ApiProperty({ type: [String] })
  summary!: string[];

  @ApiProperty({ type: [String] })
  content!: string[];
}

/** v2 ThreadItem branch for command executions. */
export class CommandExecutionThreadItemDto {
  @ApiProperty({ enum: ['commandExecution'] })
  type!: 'commandExecution';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  command!: string;

  @ApiProperty()
  cwd!: string;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  processId!: string | null;

  @ApiProperty({ enum: COMMAND_EXECUTION_SOURCE_VALUES })
  source!: (typeof COMMAND_EXECUTION_SOURCE_VALUES)[number];

  @ApiProperty({ enum: COMMAND_EXECUTION_STATUS_VALUES })
  status!: (typeof COMMAND_EXECUTION_STATUS_VALUES)[number];

  @ApiProperty({
    type: 'array',
    items: commandActionSchema(false) as Record<string, unknown>,
  })
  commandActions!: unknown[];

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  aggregatedOutput!: string | null;

  @ApiProperty(NULLABLE_NUMBER_SCHEMA)
  exitCode!: number | null;

  @ApiProperty(NULLABLE_NUMBER_SCHEMA)
  durationMs!: number | null;
}

/** v2 ThreadItem branch for file changes. */
export class FileChangeThreadItemDto {
  @ApiProperty({ enum: ['fileChange'] })
  type!: 'fileChange';

  @ApiProperty()
  id!: string;

  @ApiProperty({ type: () => [FileUpdateChangeDto] })
  changes!: FileUpdateChangeDto[];

  @ApiProperty({ enum: PATCH_APPLY_STATUS_VALUES })
  status!: (typeof PATCH_APPLY_STATUS_VALUES)[number];
}

/** v2 ThreadItem branch for MCP tool calls. */
export class McpToolCallThreadItemDto {
  @ApiProperty({ enum: ['mcpToolCall'] })
  type!: 'mcpToolCall';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  server!: string;

  @ApiProperty()
  tool!: string;

  @ApiProperty({ enum: MCP_TOOL_CALL_STATUS_VALUES })
  status!: (typeof MCP_TOOL_CALL_STATUS_VALUES)[number];

  @ApiProperty(jsonValueSchema(false))
  arguments!: unknown;

  @ApiProperty({
    nullable: true,
    oneOf: [{ $ref: getSchemaPath(McpToolCallResultDto) }],
  })
  result!: McpToolCallResultDto | null;

  @ApiProperty({
    nullable: true,
    oneOf: [{ $ref: getSchemaPath(McpToolCallErrorDto) }],
  })
  error!: McpToolCallErrorDto | null;

  @ApiProperty(NULLABLE_NUMBER_SCHEMA)
  durationMs!: number | null;
}

/** v2 ThreadItem branch for dynamic tool calls. */
export class DynamicToolCallThreadItemDto {
  @ApiProperty({ enum: ['dynamicToolCall'] })
  type!: 'dynamicToolCall';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  tool!: string;

  @ApiProperty(jsonValueSchema(false))
  arguments!: unknown;

  @ApiProperty({ enum: DYNAMIC_TOOL_CALL_STATUS_VALUES })
  status!: (typeof DYNAMIC_TOOL_CALL_STATUS_VALUES)[number];

  @ApiProperty({
    nullable: true,
    type: 'array',
    items: dynamicToolCallOutputContentItemSchema(false) as Record<
      string,
      unknown
    >,
  })
  contentItems!: unknown[] | null;

  @ApiProperty(NULLABLE_BOOLEAN_SCHEMA)
  success!: boolean | null;

  @ApiProperty(NULLABLE_NUMBER_SCHEMA)
  durationMs!: number | null;
}

/** v2 ThreadItem branch for collaborative agent tool calls. */
export class CollabAgentToolCallThreadItemDto {
  @ApiProperty({ enum: ['collabAgentToolCall'] })
  type!: 'collabAgentToolCall';

  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: COLLAB_AGENT_TOOL_VALUES })
  tool!: (typeof COLLAB_AGENT_TOOL_VALUES)[number];

  @ApiProperty({ enum: COLLAB_AGENT_TOOL_CALL_STATUS_VALUES })
  status!: (typeof COLLAB_AGENT_TOOL_CALL_STATUS_VALUES)[number];

  @ApiProperty()
  senderThreadId!: string;

  @ApiProperty({ type: [String] })
  receiverThreadIds!: string[];

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  prompt!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  model!: string | null;

  @ApiProperty(nullableStringEnumSchema(REASONING_EFFORT_VALUES))
  reasoningEffort!: (typeof REASONING_EFFORT_VALUES)[number] | null;

  @ApiProperty(recordOfSchema({ $ref: getSchemaPath(CollabAgentStateDto) }))
  agentsStates!: Record<string, CollabAgentStateDto>;
}

/** v2 ThreadItem branch for web searches. */
export class WebSearchThreadItemDto {
  @ApiProperty({ enum: ['webSearch'] })
  type!: 'webSearch';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  query!: string;

  @ApiProperty(webSearchActionSchema(true))
  action!: unknown;
}

/** v2 ThreadItem branch for image views. */
export class ImageViewThreadItemDto {
  @ApiProperty({ enum: ['imageView'] })
  type!: 'imageView';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  path!: string;
}

/** v2 ThreadItem branch for image generation. */
export class ImageGenerationThreadItemDto {
  @ApiProperty({ enum: ['imageGeneration'] })
  type!: 'imageGeneration';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  revisedPrompt!: string | null;

  @ApiProperty()
  result!: string;

  @ApiPropertyOptional()
  savedPath?: string;
}

/** v2 ThreadItem branch for entering review mode. */
export class EnteredReviewModeThreadItemDto {
  @ApiProperty({ enum: ['enteredReviewMode'] })
  type!: 'enteredReviewMode';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  review!: string;
}

/** v2 ThreadItem branch for exiting review mode. */
export class ExitedReviewModeThreadItemDto {
  @ApiProperty({ enum: ['exitedReviewMode'] })
  type!: 'exitedReviewMode';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  review!: string;
}

/** v2 ThreadItem branch for context compaction events. */
export class ContextCompactionThreadItemDto {
  @ApiProperty({ enum: ['contextCompaction'] })
  type!: 'contextCompaction';

  @ApiProperty()
  id!: string;
}

export const THREAD_ITEM_DTOS = [
  UserMessageThreadItemDto,
  HookPromptThreadItemDto,
  AgentMessageThreadItemDto,
  PlanThreadItemDto,
  ReasoningThreadItemDto,
  CommandExecutionThreadItemDto,
  FileChangeThreadItemDto,
  McpToolCallThreadItemDto,
  DynamicToolCallThreadItemDto,
  CollabAgentToolCallThreadItemDto,
  WebSearchThreadItemDto,
  ImageViewThreadItemDto,
  ImageGenerationThreadItemDto,
  EnteredReviewModeThreadItemDto,
  ExitedReviewModeThreadItemDto,
  ContextCompactionThreadItemDto,
] as const;

/** OpenAPI schema for v2 ThreadItem. */
export function threadItemSchema(nullable = false): SwaggerSchema {
  return oneOfSchema(
    THREAD_ITEM_DTOS.map((dto) => ({ $ref: getSchemaPath(dto) })),
    nullable,
  );
}
