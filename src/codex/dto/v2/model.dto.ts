import { ApiProperty } from '@nestjs/swagger';
import {
  INPUT_MODALITY_VALUES,
  NULLABLE_STRING_SCHEMA,
  REASONING_EFFORT_VALUES,
} from './openapi.schema';

/** NUX metadata for model availability. */
export class ModelAvailabilityNuxDto {
  @ApiProperty()
  message!: string;
}

/** Upgrade metadata attached to a model. */
export class ModelUpgradeInfoDto {
  @ApiProperty()
  model!: string;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  upgradeCopy!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  modelLink!: string | null;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  migrationMarkdown!: string | null;
}

/** One speed/service tier a model advertises, in catalog order. */
export class ModelServiceTierDto {
  /** Opaque tier id sent back as `serviceTier` (e.g. `priority`, `ultrafast`). */
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  description!: string;
}

/** Reasoning effort option advertised by a model. */
export class ReasoningEffortOptionDto {
  @ApiProperty({ enum: REASONING_EFFORT_VALUES })
  reasoningEffort!: (typeof REASONING_EFFORT_VALUES)[number];

  @ApiProperty()
  description!: string;
}

/** v2 Model mirror used for OpenAPI schema generation. */
export class ModelDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  model!: string;

  @ApiProperty(NULLABLE_STRING_SCHEMA)
  upgrade!: string | null;

  @ApiProperty({ nullable: true, type: () => ModelUpgradeInfoDto })
  upgradeInfo!: ModelUpgradeInfoDto | null;

  @ApiProperty({ nullable: true, type: () => ModelAvailabilityNuxDto })
  availabilityNux!: ModelAvailabilityNuxDto | null;

  @ApiProperty()
  displayName!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  hidden!: boolean;

  @ApiProperty({ type: () => [ReasoningEffortOptionDto] })
  supportedReasoningEfforts!: ReasoningEffortOptionDto[];

  @ApiProperty({ enum: REASONING_EFFORT_VALUES })
  defaultReasoningEffort!: (typeof REASONING_EFFORT_VALUES)[number];

  @ApiProperty({ enum: INPUT_MODALITY_VALUES, isArray: true })
  inputModalities!: Array<(typeof INPUT_MODALITY_VALUES)[number]>;

  @ApiProperty()
  supportsPersonality!: boolean;

  /**
   * Advertised speed tiers in catalog order. Replaces the app-server's
   * deprecated `additionalSpeedTiers`, which was a bare id list carrying no
   * display name or description and is not mirrored here.
   */
  @ApiProperty({ type: () => [ModelServiceTierDto] })
  serviceTiers!: ModelServiceTierDto[];

  /** Catalog default tier id, or null when the model configures none. */
  @ApiProperty(NULLABLE_STRING_SCHEMA)
  defaultServiceTier!: string | null;

  @ApiProperty()
  isDefault!: boolean;
}
