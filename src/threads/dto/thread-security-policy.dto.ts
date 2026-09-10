/** REST contracts for observed security settings and queued thread policy changes. */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { v2 } from '../../codex/codex-schema';
import { approvalPolicySchema } from '../../codex/dto/v2/approval.dto';
import { sandboxPolicySchema } from '../../codex/dto/v2/sandbox.dto';
import { APPROVALS_REVIEWER_VALUES } from '../../codex/dto/v2/openapi.schema';

/** Explicit policy leaves supported by the pinned thread/settings/update RPC. */
export class PatchThreadSecurityPolicyDto {
  @ApiPropertyOptional(approvalPolicySchema())
  approvalPolicy?: v2.AskForApproval;

  @ApiPropertyOptional(sandboxPolicySchema())
  sandboxPolicy?: v2.SandboxPolicy;
}

/** Last observed next-turn policy, never inferred from global configuration. */
export class ThreadSecurityPolicyDto {
  @ApiProperty()
  observed!: boolean;

  @ApiProperty({ enum: ['unknown', 'response', 'notification'] })
  source!: 'unknown' | 'response' | 'notification';

  @ApiProperty(approvalPolicySchema(true))
  approvalPolicy!: v2.AskForApproval | null;

  @ApiProperty(sandboxPolicySchema(true))
  sandboxPolicy!: v2.SandboxPolicy | null;

  // `null` is listed in the enum rather than relying on `nullable: true` alone.
  // With an enum schema the generated client drops the sibling nullable flag,
  // so the contract claimed a value that is null whenever nothing was observed.
  @ApiProperty({ enum: [...APPROVALS_REVIEWER_VALUES, null], nullable: true })
  approvalsReviewer!: v2.ApprovalsReviewer | null;
}

/** Acceptance queues the patch; only an observation confirms effective values. */
export class ThreadPolicyAcceptedDto {
  @ApiProperty({
    enum: ['accepted'],
    description:
      'Queued acknowledgement only. Observe matching effective settings before starting the next turn.',
  })
  status!: 'accepted';
}
