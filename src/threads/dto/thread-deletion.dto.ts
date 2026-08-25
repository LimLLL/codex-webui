/** Backend DTOs for destructive conversation deletion planning and execution. */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BranchAdoptionDiagnosticDto,
  BranchAdoptionStatusDto,
} from '../../conversation-branches/dto/conversation-branches.dto';
import { PendingServerRequestDto } from '../../pending-approvals/dto/pending-approvals.dto';

export type DeletePlanThreadSource = 'target' | 'local' | 'adopted' | 'server';
export type DeletePlanThreadStatus =
  | 'missing'
  | 'notLoaded'
  | 'idle'
  | 'active'
  | 'systemError';
export type DeleteResultStatus =
  | 'completed'
  | 'partial'
  | 'conflict'
  | 'failed';
export type DeleteFailureStage =
  | 'planning'
  | 'interrupt'
  | 'drift'
  | 'delete'
  | 'local_cleanup';

/** One conversation that a delete operation plans to remove. */
export class ThreadDeletePlanThreadDto {
  @ApiProperty()
  threadId!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  parentThreadId!: string | null;

  @ApiProperty({ type: () => [String] })
  childThreadIds!: string[];

  @ApiProperty()
  depth!: number;

  @ApiProperty()
  deleteOrderIndex!: number;

  @ApiProperty({ enum: ['target', 'local', 'adopted', 'server'] })
  source!: DeletePlanThreadSource;

  @ApiProperty({
    enum: ['missing', 'notLoaded', 'idle', 'active', 'systemError'],
  })
  status!: DeletePlanThreadStatus;

  @ApiProperty()
  active!: boolean;

  @ApiProperty()
  pendingApprovalCount!: number;

  @ApiPropertyOptional({ nullable: true, type: String })
  name!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  preview!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  cwd!: string | null;

  @ApiProperty()
  archived!: boolean;

  /** Unix seconds, as reported by app-server; null when the thread is gone. */
  @ApiPropertyOptional({ nullable: true, type: Number })
  createdAt!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  updatedAt!: number | null;
}

/** A reason deletion cannot safely proceed with the current topology. */
export class ThreadDeleteBlockerDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional()
  threadId?: string;

  @ApiPropertyOptional()
  parentThreadId?: string;
}

/** Preview returned before the user confirms destructive deletion. */
export class ThreadDeletePreviewDto {
  @ApiProperty()
  targetThreadId!: string;

  @ApiProperty()
  treeRootThreadId!: string;

  @ApiProperty({ type: () => [String] })
  threadIds!: string[];

  @ApiProperty({ type: () => [String] })
  deleteOrder!: string[];

  @ApiProperty({ type: () => [ThreadDeletePlanThreadDto] })
  threads!: ThreadDeletePlanThreadDto[];

  @ApiProperty({ type: () => [String] })
  runningThreadIds!: string[];

  @ApiProperty({ type: () => [String] })
  pendingApprovalThreadIds!: string[];

  @ApiProperty({ type: () => [PendingServerRequestDto] })
  pendingApprovals!: PendingServerRequestDto[];

  @ApiProperty()
  canDelete!: boolean;

  @ApiProperty({ type: () => [ThreadDeleteBlockerDto] })
  blockers!: ThreadDeleteBlockerDto[];

  @ApiProperty({ type: () => BranchAdoptionStatusDto })
  adoption!: BranchAdoptionStatusDto;
}

/** Confirmation payload: the id set the user previewed and accepted. */
export class ThreadDeleteRequestDto {
  @ApiProperty({ type: () => [String] })
  expectedThreadIds!: string[];
}

/** Details for a delete operation that could not complete fully. */
export class ThreadDeleteFailureDto {
  @ApiProperty({
    enum: ['planning', 'interrupt', 'drift', 'delete', 'local_cleanup'],
  })
  stage!: DeleteFailureStage;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional()
  threadId?: string;
}

/** Structured result for retry-safe destructive deletion. */
export class ThreadDeleteResultDto {
  @ApiProperty()
  targetThreadId!: string;

  @ApiProperty({ enum: ['completed', 'partial', 'conflict', 'failed'] })
  status!: DeleteResultStatus;

  @ApiProperty()
  destructiveStarted!: boolean;

  @ApiProperty({ type: () => [String] })
  expectedThreadIds!: string[];

  @ApiProperty({ type: () => [String] })
  plannedThreadIds!: string[];

  @ApiProperty({ type: () => [String] })
  deleteOrder!: string[];

  @ApiProperty({ type: () => [String] })
  interruptedThreadIds!: string[];

  @ApiProperty({ type: () => [String] })
  cancelledApprovalRequestIds!: string[];

  @ApiProperty({ type: () => [String] })
  deletedThreadIds!: string[];

  @ApiProperty({ type: () => [String] })
  reapedThreadIds!: string[];

  @ApiProperty({ type: () => [String] })
  remainingThreadIds!: string[];

  @ApiPropertyOptional({ type: () => ThreadDeleteFailureDto })
  failure?: ThreadDeleteFailureDto;

  @ApiPropertyOptional({ type: () => ThreadDeletePreviewDto })
  latestPreview?: ThreadDeletePreviewDto;

  @ApiProperty({ type: () => [BranchAdoptionDiagnosticDto] })
  diagnostics!: BranchAdoptionDiagnosticDto[];
}
