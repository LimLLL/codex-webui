/** DTOs for updating Codex config values via config/batchWrite. */
import { ApiProperty } from '@nestjs/swagger';
import { APPROVAL_POLICY_VALUES } from './v2/openapi.schema';

export const SANDBOX_MODE_VALUES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;

/** Request body for updating the approval policy. */
export class UpdateApprovalPolicyDto {
  @ApiProperty({ enum: APPROVAL_POLICY_VALUES })
  approvalPolicy!: (typeof APPROVAL_POLICY_VALUES)[number];
}

/** Request body for updating the sandbox mode. */
export class UpdateSandboxModeDto {
  @ApiProperty({ enum: SANDBOX_MODE_VALUES })
  sandboxMode!: (typeof SANDBOX_MODE_VALUES)[number];
}
