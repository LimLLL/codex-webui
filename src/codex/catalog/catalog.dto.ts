/** HTTP contracts for catalog editing, activation, blockers and offline repair. */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** A non-blocking semantic or configuration warning for the editor. */
export class CatalogWarningDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional() model?: string;
}
/** Complete raw catalog text, preserving all upstream fields and user formatting. */
export class CatalogDocumentDto {
  @ApiProperty({ type: String, nullable: true }) content!: string | null;
  @ApiProperty({ type: () => [CatalogWarningDto] })
  warnings!: CatalogWarningDto[];
}
/** Candidate catalog input, validated by the pinned executable. */
export class CatalogContentDto {
  @ApiProperty() content!: string;
}
/** Draft replacement with optimistic comparison against the last read content. */
export class SaveCatalogDraftDto extends CatalogContentDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Exact previous draft content; null when no draft exists.',
  })
  expectedDraft!: string | null;
}
/** Explicit source selection and draft overwrite precondition. */
export class SeedCatalogDto {
  @ApiProperty({ enum: ['bundled', 'effective'] }) source!:
    | 'bundled'
    | 'effective';
  @ApiProperty({ type: String, nullable: true }) expectedDraft!: string | null;
}
/** Exact draft and user configuration pointer approved for application. */
export class ApplyCatalogDto {
  @ApiProperty({ description: 'Exact draft approved by the user.' })
  expectedDraft!: string;
  @ApiProperty({ type: String, nullable: true }) expectedPointer!:
    | string
    | null;
}
/** Pointer precondition for default or previous-source restoration. */
export class ChangeCatalogSourceDto {
  @ApiProperty({ type: String, nullable: true }) expectedPointer!:
    | string
    | null;
}
/** The single bounded durable activation record. */
export class CatalogActivationDto {
  @ApiProperty({ enum: ['pending', 'accepted', 'reverted'] }) outcome!:
    | 'pending'
    | 'accepted'
    | 'reverted';
  @ApiProperty({ type: String, nullable: true }) before!: string | null;
  @ApiProperty({ type: String, nullable: true }) after!: string | null;
}
/** Repair-safe control-plane state independent of successful Codex startup. */
export class CatalogStateDto {
  @ApiProperty() ready!: boolean;
  @ApiProperty({ type: String, nullable: true }) startupError!: string | null;
  @ApiProperty({ type: String, nullable: true }) configuredPointer!:
    | string
    | null;
  @ApiProperty({
    description:
      'The configured pointer is a file this backend owns, so it may be cleared back to the default.',
  })
  managed!: boolean;
  @ApiProperty({
    description:
      'False only on a known mismatch: a user-level pointer the running child did not load. True when there is nothing to compare (no child, or no user-level pointer).',
  })
  pointerApplied!: boolean;
  @ApiProperty({ type: [String] }) runningPaths!: string[];
  @ApiProperty({ type: () => CatalogActivationDto, nullable: true })
  activation!: CatalogActivationDto | null;
  @ApiProperty({ type: String, nullable: true }) repairError!: string | null;
}
/** One conversation or local operation that prevents an idle restart. */
export class CatalogBlockerDto {
  @ApiProperty({ type: String, nullable: true }) threadId!: string | null;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty() reason!: string;
  @ApiPropertyOptional({ type: [String] }) processIds?: string[];
  @ApiPropertyOptional({
    description:
      'Present only for work dispatched through this backend connection.',
  })
  requestMethod?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) turnId?: string | null;
}
/** An observation of live restart blockers for one process generation. */
export class CatalogBlockersDto {
  @ApiProperty({
    enum: ['managedAppServer'],
    description: 'A scoped observation, not a global idle guarantee.',
  })
  scope!: 'managedAppServer';
  @ApiProperty({ type: [String] }) limitations!: string[];
  @ApiProperty() canApply!: boolean;
  @ApiProperty() generation!: number;
  @ApiProperty({ type: () => [CatalogBlockerDto] })
  blockers!: CatalogBlockerDto[];
}
/** Accepted activation state with non-blocking catalog warnings. */
export class CatalogApplyResultDto extends CatalogStateDto {
  @ApiProperty({ type: () => [CatalogWarningDto] })
  warnings!: CatalogWarningDto[];
}
