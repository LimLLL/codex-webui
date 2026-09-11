import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FileUpdateChangeDto } from '../../codex/dto/v2/support.dto';
import {
  InteractionPresentationDto,
  ServerRequestFailureDto,
} from './interaction.dto';

/** Complete proposed change set, distinct from a turn diff or an execution result. */
export class FileChangeApprovalSubjectDto {
  @ApiProperty({ enum: ['fileChange'] })
  type!: 'fileChange';

  @ApiProperty({ type: () => [FileUpdateChangeDto] })
  changes!: FileUpdateChangeDto[];
}

export type PendingServerRequestStatus =
  | 'pending'
  | 'submitted'
  | 'resolved'
  | 'expired'
  | 'failed'
  | 'cancelled';

/** Persisted app-server request that is waiting for a user response. */
export class PendingServerRequestDto {
  @ApiProperty() instanceId!: string;
  @ApiProperty()
  generation!: number;

  @ApiProperty()
  requestId!: string;

  @ApiProperty()
  threadId!: string;

  @ApiProperty({ nullable: true, type: String })
  turnId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  itemId!: string | null;

  @ApiProperty()
  method!: string;

  @ApiProperty({ type: Object })
  params!: Record<string, unknown>;

  /** Null for self-contained requests or an unavailable file subject; unavailable file changes cannot be approved. */
  @ApiProperty({ type: () => FileChangeApprovalSubjectDto, nullable: true })
  reviewSubject!: FileChangeApprovalSubjectDto | null;
  @ApiProperty({ type: () => InteractionPresentationDto, nullable: true })
  presentation!: InteractionPresentationDto | null;
  @ApiProperty({ type: String, nullable: true }) negativeOnlyReason!:
    | string
    | null;

  @ApiProperty({
    enum: [
      'pending',
      'submitted',
      'resolved',
      'expired',
      'failed',
      'cancelled',
    ],
  })
  status!: PendingServerRequestStatus;

  @ApiProperty()
  createdAt!: number;

  @ApiProperty()
  updatedAt!: number;
}

/** Query response for hydrating pending server requests. */
export class PendingServerRequestsResponseDto {
  /** Process generation at read time, including for an empty successful set. */
  @ApiProperty()
  generation!: number;

  @ApiProperty({ type: () => [PendingServerRequestDto] })
  requests!: PendingServerRequestDto[];
  @ApiProperty({ type: () => [ServerRequestFailureDto] })
  failures!: ServerRequestFailureDto[];
}

/** Committed retirement of a human request; never implies that the action was accepted. */
export class PendingRequestResolvedDto {
  @ApiProperty() instanceId!: string;
  @ApiProperty()
  generation!: number;

  @ApiProperty()
  requestId!: string;

  @ApiProperty()
  threadId!: string;

  @ApiProperty({
    enum: ['submitted', 'resolved', 'cancelled', 'expired', 'failed'],
  })
  status!: 'submitted' | 'resolved' | 'cancelled' | 'expired' | 'failed';
}

/** Additive live envelope: original wire identity/params plus backend-owned review context. */
export interface PendingServerRequestEvent {
  instanceId: string;
  id: number | string;
  method: string;
  params: Record<string, unknown>;
  generation: number;
  reviewSubject: FileChangeApprovalSubjectDto | null;
  presentation: InteractionPresentationDto | null;
  negativeOnlyReason: string | null;
}

/** Request body for responding to a persisted server request. */
export class RespondPendingServerRequestDto {
  @ApiProperty({
    description:
      'Opaque identity of the exact proposal shown to the browser. Required; old clients must refresh.',
  })
  instanceId!: string;
  @ApiProperty()
  result!: unknown;

  @ApiPropertyOptional()
  clientId?: string;
}
