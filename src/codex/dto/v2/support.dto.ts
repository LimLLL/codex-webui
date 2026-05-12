import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import {
  type SwaggerSchema,
  CODEX_ERROR_INFO_STRING_VALUES,
  COLLAB_AGENT_STATUS_VALUES,
  NON_STEERABLE_TURN_KIND_VALUES,
  NULLABLE_NUMBER_SCHEMA,
  NULLABLE_STRING_SCHEMA,
  jsonValueSchema,
  oneOfSchema,
  stringEnumSchema,
} from './openapi.schema';

/** Byte range in a parent text buffer. */
export class ByteRangeDto {
  @ApiProperty()
  start!: number;

  @ApiProperty()
  end!: number;
}

/** UI-defined span inside a text user input. */
export class TextElementDto {
  @ApiProperty({ type: () => ByteRangeDto })
  byteRange!: ByteRangeDto;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  placeholder!: string | null;
}

/** Text user input branch mirrored from v2 UserInput. */
export class UserInputTextDto {
  @ApiProperty({ enum: ['text'] })
  type!: 'text';

  @ApiProperty()
  text!: string;

  @ApiProperty({ type: () => [TextElementDto] })
  text_elements!: TextElementDto[];
}

/** Remote image user input branch mirrored from v2 UserInput. */
export class UserInputImageDto {
  @ApiProperty({ enum: ['image'] })
  type!: 'image';

  @ApiProperty()
  url!: string;
}

/** Local image user input branch mirrored from v2 UserInput. */
export class UserInputLocalImageDto {
  @ApiProperty({ enum: ['localImage'] })
  type!: 'localImage';

  @ApiProperty()
  path!: string;
}

/** Skill user input branch mirrored from v2 UserInput. */
export class UserInputSkillDto {
  @ApiProperty({ enum: ['skill'] })
  type!: 'skill';

  @ApiProperty()
  name!: string;

  @ApiProperty()
  path!: string;
}

/** Mention user input branch mirrored from v2 UserInput. */
export class UserInputMentionDto {
  @ApiProperty({ enum: ['mention'] })
  type!: 'mention';

  @ApiProperty()
  name!: string;

  @ApiProperty()
  path!: string;
}

/** Hook prompt fragment persisted by Codex. */
export class HookPromptFragmentDto {
  @ApiProperty()
  text!: string;

  @ApiProperty()
  hookRunId!: string;
}

/** Single memory citation entry. */
export class MemoryCitationEntryDto {
  @ApiProperty()
  path!: string;

  @ApiProperty()
  lineStart!: number;

  @ApiProperty()
  lineEnd!: number;

  @ApiProperty()
  note!: string;
}

/** Memory citation metadata attached to an agent message. */
export class MemoryCitationDto {
  @ApiProperty({ type: () => [MemoryCitationEntryDto] })
  entries!: MemoryCitationEntryDto[];

  @ApiProperty({ type: [String] })
  threadIds!: string[];
}

/** Add patch-change kind branch. */
export class PatchChangeKindAddDto {
  @ApiProperty({ enum: ['add'] })
  type!: 'add';
}

/** Delete patch-change kind branch. */
export class PatchChangeKindDeleteDto {
  @ApiProperty({ enum: ['delete'] })
  type!: 'delete';
}

/** Update patch-change kind branch. */
export class PatchChangeKindUpdateDto {
  @ApiProperty({ enum: ['update'] })
  type!: 'update';

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  move_path!: string | null;
}

/** File update entry in a v2 fileChange item. */
export class FileUpdateChangeDto {
  @ApiProperty()
  path!: string;

  @ApiProperty(patchChangeKindSchema())
  kind!:
    | PatchChangeKindAddDto
    | PatchChangeKindDeleteDto
    | PatchChangeKindUpdateDto;

  @ApiProperty()
  diff!: string;
}

/** Successful MCP tool call result. */
export class McpToolCallResultDto {
  @ApiProperty({
    type: 'array',
    items: jsonValueSchema(false) as Record<string, unknown>,
  })
  content!: unknown[];

  @ApiProperty(jsonValueSchema(true))
  structuredContent!: unknown;

  @ApiProperty(jsonValueSchema(true))
  _meta!: unknown;
}

/** MCP tool call error result. */
export class McpToolCallErrorDto {
  @ApiProperty()
  message!: string;
}

/** Command action branch for reads. */
export class CommandActionReadDto {
  @ApiProperty({ enum: ['read'] })
  type!: 'read';

  @ApiProperty()
  command!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  path!: string;
}

/** Command action branch for directory listings. */
export class CommandActionListFilesDto {
  @ApiProperty({ enum: ['listFiles'] })
  type!: 'listFiles';

  @ApiProperty()
  command!: string;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  path!: string | null;
}

/** Command action branch for searches. */
export class CommandActionSearchDto {
  @ApiProperty({ enum: ['search'] })
  type!: 'search';

  @ApiProperty()
  command!: string;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  query!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  path!: string | null;
}

/** Command action branch for unknown commands. */
export class CommandActionUnknownDto {
  @ApiProperty({ enum: ['unknown'] })
  type!: 'unknown';

  @ApiProperty()
  command!: string;
}

/** Dynamic tool output item branch for text. */
export class DynamicToolCallOutputInputTextDto {
  @ApiProperty({ enum: ['inputText'] })
  type!: 'inputText';

  @ApiProperty()
  text!: string;
}

/** Dynamic tool output item branch for images. */
export class DynamicToolCallOutputInputImageDto {
  @ApiProperty({ enum: ['inputImage'] })
  type!: 'inputImage';

  @ApiProperty()
  imageUrl!: string;
}

/** Collab agent state keyed by thread id. */
export class CollabAgentStateDto {
  @ApiProperty({ enum: COLLAB_AGENT_STATUS_VALUES })
  status!: (typeof COLLAB_AGENT_STATUS_VALUES)[number];

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  message!: string | null;
}

/** Web search action branch for search requests. */
export class WebSearchActionSearchDto {
  @ApiProperty({ enum: ['search'] })
  type!: 'search';

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  query!: string | null;

  @ApiProperty({ nullable: true, type: [String] })
  queries!: string[] | null;
}

/** Web search action branch for opening pages. */
export class WebSearchActionOpenPageDto {
  @ApiProperty({ enum: ['openPage'] })
  type!: 'openPage';

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  url!: string | null;
}

/** Web search action branch for finding text in a page. */
export class WebSearchActionFindInPageDto {
  @ApiProperty({ enum: ['findInPage'] })
  type!: 'findInPage';

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  url!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  pattern!: string | null;
}

/** Web search action branch for unclassified browser actions. */
export class WebSearchActionOtherDto {
  @ApiProperty({ enum: ['other'] })
  type!: 'other';
}

/** Shared payload for Codex error variants that carry an HTTP status code. */
export class CodexHttpStatusCodePayloadDto {
  @ApiProperty(NULLABLE_NUMBER_SCHEMA)
  httpStatusCode!: number | null;
}

/** Codex error branch for failed HTTP connections. */
export class CodexHttpConnectionFailedDto {
  @ApiProperty({ type: () => CodexHttpStatusCodePayloadDto })
  httpConnectionFailed!: CodexHttpStatusCodePayloadDto;
}

/** Codex error branch for response-stream connection failures. */
export class CodexResponseStreamConnectionFailedDto {
  @ApiProperty({ type: () => CodexHttpStatusCodePayloadDto })
  responseStreamConnectionFailed!: CodexHttpStatusCodePayloadDto;
}

/** Codex error branch for disconnected response streams. */
export class CodexResponseStreamDisconnectedDto {
  @ApiProperty({ type: () => CodexHttpStatusCodePayloadDto })
  responseStreamDisconnected!: CodexHttpStatusCodePayloadDto;
}

/** Codex error branch for too many failed response attempts. */
export class CodexResponseTooManyFailedAttemptsDto {
  @ApiProperty({ type: () => CodexHttpStatusCodePayloadDto })
  responseTooManyFailedAttempts!: CodexHttpStatusCodePayloadDto;
}

/** Payload for active-turn-not-steerable errors. */
export class CodexActiveTurnNotSteerablePayloadDto {
  @ApiProperty({ enum: NON_STEERABLE_TURN_KIND_VALUES })
  turnKind!: (typeof NON_STEERABLE_TURN_KIND_VALUES)[number];
}

/** Codex error branch for active turns that cannot be steered. */
export class CodexActiveTurnNotSteerableDto {
  @ApiProperty({ type: () => CodexActiveTurnNotSteerablePayloadDto })
  activeTurnNotSteerable!: CodexActiveTurnNotSteerablePayloadDto;
}

/** OpenAPI schema for v2 UserInput. */
export function userInputSchema(nullable = false): SwaggerSchema {
  return oneOfSchema(
    [
      { $ref: getSchemaPath(UserInputTextDto) },
      { $ref: getSchemaPath(UserInputImageDto) },
      { $ref: getSchemaPath(UserInputLocalImageDto) },
      { $ref: getSchemaPath(UserInputSkillDto) },
      { $ref: getSchemaPath(UserInputMentionDto) },
    ],
    nullable,
  );
}

/** OpenAPI schema for v2 PatchChangeKind. */
export function patchChangeKindSchema(nullable = false): SwaggerSchema {
  return oneOfSchema(
    [
      { $ref: getSchemaPath(PatchChangeKindAddDto) },
      { $ref: getSchemaPath(PatchChangeKindDeleteDto) },
      { $ref: getSchemaPath(PatchChangeKindUpdateDto) },
    ],
    nullable,
  );
}

/** OpenAPI schema for v2 CommandAction. */
export function commandActionSchema(nullable = false): SwaggerSchema {
  return oneOfSchema(
    [
      { $ref: getSchemaPath(CommandActionReadDto) },
      { $ref: getSchemaPath(CommandActionListFilesDto) },
      { $ref: getSchemaPath(CommandActionSearchDto) },
      { $ref: getSchemaPath(CommandActionUnknownDto) },
    ],
    nullable,
  );
}

/** OpenAPI schema for dynamic tool output items. */
export function dynamicToolCallOutputContentItemSchema(
  nullable = false,
): SwaggerSchema {
  return oneOfSchema(
    [
      { $ref: getSchemaPath(DynamicToolCallOutputInputTextDto) },
      { $ref: getSchemaPath(DynamicToolCallOutputInputImageDto) },
    ],
    nullable,
  );
}

/** OpenAPI schema for v2 WebSearchAction. */
export function webSearchActionSchema(nullable = false): SwaggerSchema {
  return oneOfSchema(
    [
      { $ref: getSchemaPath(WebSearchActionSearchDto) },
      { $ref: getSchemaPath(WebSearchActionOpenPageDto) },
      { $ref: getSchemaPath(WebSearchActionFindInPageDto) },
      { $ref: getSchemaPath(WebSearchActionOtherDto) },
    ],
    nullable,
  );
}

/** OpenAPI schema for v2 CodexErrorInfo. */
export function codexErrorInfoSchema(nullable = false): SwaggerSchema {
  return oneOfSchema(
    [
      stringEnumSchema(CODEX_ERROR_INFO_STRING_VALUES),
      { $ref: getSchemaPath(CodexHttpConnectionFailedDto) },
      { $ref: getSchemaPath(CodexResponseStreamConnectionFailedDto) },
      { $ref: getSchemaPath(CodexResponseStreamDisconnectedDto) },
      { $ref: getSchemaPath(CodexResponseTooManyFailedAttemptsDto) },
      { $ref: getSchemaPath(CodexActiveTurnNotSteerableDto) },
    ],
    nullable,
  );
}

export const SUPPORT_EXTRA_MODELS = [
  ByteRangeDto,
  TextElementDto,
  UserInputTextDto,
  UserInputImageDto,
  UserInputLocalImageDto,
  UserInputSkillDto,
  UserInputMentionDto,
  HookPromptFragmentDto,
  MemoryCitationEntryDto,
  MemoryCitationDto,
  PatchChangeKindAddDto,
  PatchChangeKindDeleteDto,
  PatchChangeKindUpdateDto,
  FileUpdateChangeDto,
  McpToolCallResultDto,
  McpToolCallErrorDto,
  CommandActionReadDto,
  CommandActionListFilesDto,
  CommandActionSearchDto,
  CommandActionUnknownDto,
  DynamicToolCallOutputInputTextDto,
  DynamicToolCallOutputInputImageDto,
  CollabAgentStateDto,
  WebSearchActionSearchDto,
  WebSearchActionOpenPageDto,
  WebSearchActionFindInPageDto,
  WebSearchActionOtherDto,
  CodexHttpStatusCodePayloadDto,
  CodexHttpConnectionFailedDto,
  CodexResponseStreamConnectionFailedDto,
  CodexResponseStreamDisconnectedDto,
  CodexResponseTooManyFailedAttemptsDto,
  CodexActiveTurnNotSteerablePayloadDto,
  CodexActiveTurnNotSteerableDto,
] as const;
