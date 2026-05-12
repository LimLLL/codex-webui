/**
 * Swagger schema object passed to @ApiProperty().
 * NestJS Swagger accepts Record<string, unknown> at runtime for raw schemas.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SwaggerSchema extends Record<string, unknown> {}

/** String enum values mirrored from generated Codex v2 schema aliases. */
export const REASONING_EFFORT_VALUES = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export const SERVICE_TIER_VALUES = ['fast', 'flex'] as const;
export const INPUT_MODALITY_VALUES = ['text', 'image'] as const;
export const MESSAGE_PHASE_VALUES = ['commentary', 'final_answer'] as const;
export const APPROVAL_POLICY_VALUES = [
  'untrusted',
  'on-failure',
  'on-request',
  'never',
] as const;
export const APPROVALS_REVIEWER_VALUES = ['user', 'guardian_subagent'] as const;
export const NETWORK_ACCESS_VALUES = ['restricted', 'enabled'] as const;
export const THREAD_ACTIVE_FLAG_VALUES = [
  'waitingOnApproval',
  'waitingOnUserInput',
] as const;
export const THREAD_STATUS_TYPE_VALUES = [
  'notLoaded',
  'idle',
  'systemError',
  'active',
] as const;
export const SESSION_SOURCE_STRING_VALUES = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'unknown',
] as const;
export const SUB_AGENT_SOURCE_STRING_VALUES = [
  'review',
  'compact',
  'memory_consolidation',
] as const;
export const TURN_STATUS_VALUES = [
  'completed',
  'interrupted',
  'failed',
  'inProgress',
] as const;
export const COMMAND_EXECUTION_SOURCE_VALUES = [
  'agent',
  'userShell',
  'unifiedExecStartup',
  'unifiedExecInteraction',
] as const;
export const COMMAND_EXECUTION_STATUS_VALUES = [
  'inProgress',
  'completed',
  'failed',
  'declined',
] as const;
export const PATCH_APPLY_STATUS_VALUES = [
  'inProgress',
  'completed',
  'failed',
  'declined',
] as const;
export const MCP_TOOL_CALL_STATUS_VALUES = [
  'inProgress',
  'completed',
  'failed',
] as const;
export const DYNAMIC_TOOL_CALL_STATUS_VALUES = [
  'inProgress',
  'completed',
  'failed',
] as const;
export const COLLAB_AGENT_TOOL_VALUES = [
  'spawnAgent',
  'sendInput',
  'resumeAgent',
  'wait',
  'closeAgent',
] as const;
export const COLLAB_AGENT_TOOL_CALL_STATUS_VALUES = [
  'inProgress',
  'completed',
  'failed',
] as const;
export const COLLAB_AGENT_STATUS_VALUES = [
  'pendingInit',
  'running',
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
] as const;
export const NON_STEERABLE_TURN_KIND_VALUES = ['review', 'compact'] as const;
export const CODEX_ERROR_INFO_STRING_VALUES = [
  'contextWindowExceeded',
  'usageLimitExceeded',
  'serverOverloaded',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'other',
] as const;

/** OpenAPI schema for the recursive serde_json::Value alias. */
export function jsonValueSchema(nullable = true): SwaggerSchema {
  return {
    nullable,
    oneOf: [
      { type: 'number' },
      { type: 'string' },
      { type: 'boolean' },
      { type: 'array', items: {} },
      { type: 'object', additionalProperties: true },
    ],
  };
}

/** Builds a nullable oneOf schema while preserving plain string enum arms. */
export function oneOfSchema(
  schemas: Array<Record<string, unknown>>,
  nullable = false,
): SwaggerSchema {
  return { nullable, oneOf: schemas };
}

/** OpenAPI schema for an object map whose values use another schema. */
export function recordOfSchema(
  valueSchema: Record<string, unknown>,
): SwaggerSchema {
  return {
    type: 'object',
    additionalProperties: valueSchema,
  };
}

/** Schema for a string enum union branch. */
export function stringEnumSchema(values: readonly string[]): SwaggerSchema {
  return { type: 'string', enum: [...values] };
}

/** Schema for a nullable string enum field with Codex-style nullability. */
export function nullableStringEnumSchema(
  values: readonly string[],
): SwaggerSchema {
  return oneOfSchema([stringEnumSchema(values)], true);
}

/** Schema for a nullable string field with Codex-style nullability. */
export const NULLABLE_STRING_SCHEMA = {
  type: 'string',
  nullable: true,
} as const;

/** Schema for a nullable number field with Codex-style nullability. */
export const NULLABLE_NUMBER_SCHEMA = {
  type: 'number',
  nullable: true,
} as const;

/** Schema for a nullable boolean field with Codex-style nullability. */
export const NULLABLE_BOOLEAN_SCHEMA = {
  type: 'boolean',
  nullable: true,
} as const;

/** Schema for a path alias that is represented as a string at runtime. */
export const ABSOLUTE_PATH_BUF_SCHEMA = {
  type: 'string',
  description: 'Absolute normalized path as emitted by Codex.',
} as const;
