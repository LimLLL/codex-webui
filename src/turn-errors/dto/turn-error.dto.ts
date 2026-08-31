/** Swagger DTOs for persisted turn error hydration. */
import { ApiProperty } from '@nestjs/swagger';

/** A single persisted turn error (named to avoid collision with Codex TurnErrorDto). */
export class PersistedTurnErrorDto {
  @ApiProperty()
  turnId!: string;

  @ApiProperty()
  message!: string;

  /** Stable app-server error classification, when one accompanied the failure. */
  @ApiProperty({ type: String, nullable: true })
  errorCategory!: string | null;

  /** Additional user-facing diagnostic detail supplied by the app-server. */
  @ApiProperty({ type: String, nullable: true })
  additionalDetails!: string | null;

  /** Misalignment-policy classification retained for refresh recovery. */
  @ApiProperty({ type: String, nullable: true })
  misalignmentErrorType!: string | null;

  /** Misalignment-policy explanation retained for refresh recovery. */
  @ApiProperty({ type: String, nullable: true })
  misalignmentExplanation!: string | null;

  @ApiProperty()
  createdAt!: number;
}

/** Turn error query response for hydrating the frontend store. */
export class ThreadTurnErrorsResponseDto {
  @ApiProperty()
  threadId!: string;

  @ApiProperty({ type: () => [PersistedTurnErrorDto] })
  errors!: PersistedTurnErrorDto[];
}
