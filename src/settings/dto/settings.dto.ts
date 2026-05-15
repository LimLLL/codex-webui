/** Swagger DTO definitions for runtime settings endpoints. */
import {
  ApiProperty,
  ApiPropertyOptional,
  type ApiPropertyOptions,
} from '@nestjs/swagger';
import {
  SETTING_CATEGORIES,
  SETTING_TYPES,
  type SettingCategory,
  type SettingType,
} from '../settings.definitions';

const JSON_VALUE_ONE_OF: NonNullable<ApiPropertyOptions['oneOf']> = [
  { type: 'string' },
  { type: 'number' },
  { type: 'boolean' },
  { type: 'array', items: {} },
  { type: 'object', additionalProperties: true },
];

function jsonValueProperty(
  description: string,
  nullable = false,
): ApiPropertyOptions {
  return { description, nullable, oneOf: JSON_VALUE_ONE_OF };
}

/** Constraint metadata used by the settings UI for validation controls. */
export class SettingConstraintsDto {
  @ApiPropertyOptional()
  min?: number;

  @ApiPropertyOptional()
  max?: number;

  @ApiPropertyOptional({
    description: 'Allowed values',
    type: 'array',
    items: {},
  })
  enum?: readonly unknown[];

  @ApiPropertyOptional()
  integer?: boolean;
}

/** Runtime setting with effective value and source metadata. */
export class SettingDto {
  @ApiProperty()
  key!: string;

  @ApiProperty(jsonValueProperty('Effective value (JSON-compatible)'))
  value!: unknown;

  @ApiProperty({ enum: ['db', 'env', 'default'] })
  source!: 'db' | 'env' | 'default';

  @ApiProperty({ enum: SETTING_TYPES })
  type!: SettingType;

  @ApiProperty({ enum: SETTING_CATEGORIES })
  category!: SettingCategory;

  @ApiProperty()
  description!: string;

  @ApiProperty(jsonValueProperty('Hardcoded default value'))
  defaultValue!: unknown;

  @ApiProperty({ type: () => SettingConstraintsDto })
  constraints!: SettingConstraintsDto;

  @ApiProperty()
  updatedAt!: number;
}

/** List response for runtime settings. */
export class SettingsListResponseDto {
  @ApiProperty({ type: () => [SettingDto] })
  settings!: SettingDto[];
}

/** Request body for updating or resetting a single setting. */
export class UpdateSettingDto {
  @ApiProperty(jsonValueProperty('New value or null to reset', true))
  value!: unknown;
}

/** One entry in a batch settings update. */
export class BatchUpdateSettingDto {
  @ApiProperty()
  key!: string;

  @ApiProperty(jsonValueProperty('New value or null to reset', true))
  value!: unknown;
}

/** Request body for atomically updating multiple settings. */
export class BatchUpdateSettingsDto {
  @ApiProperty({ type: () => [BatchUpdateSettingDto] })
  updates!: BatchUpdateSettingDto[];
}
