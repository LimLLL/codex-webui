import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type PendingServerRequestStatus =
  | 'pending'
  | 'resolved'
  | 'expired'
  | 'failed'
  | 'cancelled';

/** Persisted app-server request that is waiting for a user response. */
export class PendingServerRequestDto {
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

  @ApiProperty({
    enum: ['pending', 'resolved', 'expired', 'failed', 'cancelled'],
  })
  status!: PendingServerRequestStatus;

  @ApiProperty()
  createdAt!: number;

  @ApiProperty()
  updatedAt!: number;
}

/** Query response for hydrating pending server requests. */
export class PendingServerRequestsResponseDto {
  @ApiProperty({ type: () => [PendingServerRequestDto] })
  requests!: PendingServerRequestDto[];
}

/** Request body for responding to a persisted server request. */
export class RespondPendingServerRequestDto {
  @ApiProperty()
  result!: unknown;

  @ApiPropertyOptional()
  clientId?: string;
}
