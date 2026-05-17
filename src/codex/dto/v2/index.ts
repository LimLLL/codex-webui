export * from './approval.dto';
export * from './model.dto';
export * from './openapi.schema';
export * from './responses.dto';
export * from './sandbox.dto';
export * from './session.dto';
export * from './support.dto';
export * from './thread.dto';
export * from './thread-item.dto';
export * from './thread-status.dto';
export * from './turn.dto';

import {
  GranularApprovalOptionsDto,
  GranularApprovalPolicyDto,
} from './approval.dto';
import {
  ModelAvailabilityNuxDto,
  ModelDto,
  ModelUpgradeInfoDto,
  ReasoningEffortOptionDto,
} from './model.dto';
import {
  ReadOnlyAccessFullAccessDto,
  ReadOnlyAccessRestrictedDto,
  SandboxDangerFullAccessDto,
  SandboxExternalSandboxDto,
  SandboxReadOnlyDto,
  SandboxWorkspaceWriteDto,
} from './sandbox.dto';
import {
  SessionSourceCustomDto,
  SessionSourceSubAgentDto,
  SubAgentOtherSourceDto,
  SubAgentThreadSpawnPayloadDto,
  SubAgentThreadSpawnSourceDto,
} from './session.dto';
import { SUPPORT_EXTRA_MODELS } from './support.dto';
import { GitInfoDto, ThreadDto } from './thread.dto';
import { THREAD_ITEM_DTOS } from './thread-item.dto';
import {
  ThreadStatusActiveDto,
  ThreadStatusIdleDto,
  ThreadStatusNotLoadedDto,
  ThreadStatusSystemErrorDto,
} from './thread-status.dto';
import { TurnDto, TurnErrorDto } from './turn.dto';
import {
  ModelListResponseDto,
  ThreadForkResponseDto,
  ThreadListResponseDto,
  ThreadLoadedListResponseDto,
  ThreadReadResponseDto,
  ThreadResumeResponseDto,
  ThreadRollbackResponseDto,
  ThreadStartResponseDto,
  ThreadUnarchiveResponseDto,
  TurnStartResponseDto,
} from './responses.dto';

/** All extra models referenced through oneOf schemas in Codex v2 DTO mirrors. */
export const CODEX_V2_EXTRA_MODELS = [
  GranularApprovalOptionsDto,
  GranularApprovalPolicyDto,
  ReadOnlyAccessRestrictedDto,
  ReadOnlyAccessFullAccessDto,
  SandboxDangerFullAccessDto,
  SandboxReadOnlyDto,
  SandboxExternalSandboxDto,
  SandboxWorkspaceWriteDto,
  SubAgentThreadSpawnPayloadDto,
  SubAgentThreadSpawnSourceDto,
  SubAgentOtherSourceDto,
  SessionSourceCustomDto,
  SessionSourceSubAgentDto,
  ThreadStatusNotLoadedDto,
  ThreadStatusIdleDto,
  ThreadStatusSystemErrorDto,
  ThreadStatusActiveDto,
  ...SUPPORT_EXTRA_MODELS,
  ...THREAD_ITEM_DTOS,
  TurnErrorDto,
  TurnDto,
  GitInfoDto,
  ThreadDto,
  ModelAvailabilityNuxDto,
  ModelUpgradeInfoDto,
  ReasoningEffortOptionDto,
  ModelDto,
  ThreadStartResponseDto,
  ThreadResumeResponseDto,
  ThreadForkResponseDto,
  ThreadReadResponseDto,
  ThreadListResponseDto,
  ThreadLoadedListResponseDto,
  ThreadUnarchiveResponseDto,
  ThreadRollbackResponseDto,
  TurnStartResponseDto,
  ModelListResponseDto,
] as const;
