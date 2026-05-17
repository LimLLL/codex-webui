import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { jsonValueSchema } from '../../codex/dto/v2/openapi.schema';

export const PLUGIN_INSTALL_POLICY_VALUES = [
  'NOT_AVAILABLE',
  'AVAILABLE',
  'INSTALLED_BY_DEFAULT',
] as const;

export const PLUGIN_AUTH_POLICY_VALUES = ['ON_INSTALL', 'ON_USE'] as const;

const JSON_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const;

/** Human-readable marketplace metadata. */
export class MarketplaceInterfaceDto {
  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;
}

/** Load error for a marketplace path. */
export class MarketplaceLoadErrorInfoDto {
  @ApiProperty()
  marketplacePath!: string;

  @ApiProperty()
  message!: string;
}

/** Presentation metadata declared by a plugin. */
export class PluginInterfaceDto {
  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  shortDescription!: string | null;

  @ApiProperty({ type: String, nullable: true })
  longDescription!: string | null;

  @ApiProperty({ type: String, nullable: true })
  developerName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  category!: string | null;

  @ApiProperty({ type: [String] })
  capabilities!: string[];

  @ApiProperty({ type: String, nullable: true })
  websiteUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  privacyPolicyUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  termsOfServiceUrl!: string | null;

  @ApiProperty({ type: [String], nullable: true })
  defaultPrompt!: string[] | null;

  @ApiProperty({ type: String, nullable: true })
  brandColor!: string | null;

  @ApiProperty({ type: String, nullable: true })
  composerIcon!: string | null;

  @ApiProperty({ type: String, nullable: true })
  logo!: string | null;

  @ApiProperty({ type: [String] })
  screenshots!: string[];
}

/** Summary row returned by plugin/list. */
export class PluginSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty(JSON_OBJECT_SCHEMA)
  source!: Record<string, unknown>;

  @ApiProperty()
  installed!: boolean;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ enum: PLUGIN_INSTALL_POLICY_VALUES })
  installPolicy!: (typeof PLUGIN_INSTALL_POLICY_VALUES)[number];

  @ApiProperty({ enum: PLUGIN_AUTH_POLICY_VALUES })
  authPolicy!: (typeof PLUGIN_AUTH_POLICY_VALUES)[number];

  @ApiProperty({ type: () => PluginInterfaceDto, nullable: true })
  interface!: PluginInterfaceDto | null;
}

/** Marketplace group returned by plugin/list. */
export class PluginMarketplaceEntryDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  path!: string;

  @ApiProperty({ type: () => MarketplaceInterfaceDto, nullable: true })
  interface!: MarketplaceInterfaceDto | null;

  @ApiProperty({ type: () => [PluginSummaryDto] })
  plugins!: PluginSummaryDto[];
}

/** Response for plugin/list. */
export class PluginListResponseDto {
  @ApiProperty({ type: () => [PluginMarketplaceEntryDto] })
  marketplaces!: PluginMarketplaceEntryDto[];

  @ApiProperty({ type: () => [MarketplaceLoadErrorInfoDto] })
  marketplaceLoadErrors!: MarketplaceLoadErrorInfoDto[];

  @ApiProperty({ type: String, nullable: true })
  remoteSyncError!: string | null;

  @ApiProperty({ type: [String] })
  featuredPluginIds!: string[];
}

/** Skill summary embedded in plugin detail. */
export class PluginSkillSummaryDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: String, nullable: true })
  shortDescription!: string | null;

  @ApiProperty()
  path!: string;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ ...jsonValueSchema(true), nullable: true })
  interface!: unknown;
}

/** App summary embedded in plugin responses. */
export class PluginAppSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  installUrl!: string | null;

  @ApiProperty()
  needsAuth!: boolean;
}

/** Detailed plugin metadata returned by plugin/read. */
export class PluginDetailDto {
  @ApiProperty()
  marketplaceName!: string;

  @ApiProperty()
  marketplacePath!: string;

  @ApiProperty({ type: () => PluginSummaryDto })
  summary!: PluginSummaryDto;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: () => [PluginSkillSummaryDto] })
  skills!: PluginSkillSummaryDto[];

  @ApiProperty({ type: () => [PluginAppSummaryDto] })
  apps!: PluginAppSummaryDto[];

  @ApiProperty({ type: [String] })
  mcpServers!: string[];
}

/** Response for plugin/read. */
export class PluginReadResponseDto {
  @ApiProperty({ type: () => PluginDetailDto })
  plugin!: PluginDetailDto;
}

/** Request body for plugin/install. */
export class PluginInstallRequestDto {
  @ApiProperty()
  marketplacePath!: string;

  @ApiProperty()
  pluginName!: string;

  @ApiPropertyOptional()
  forceRemoteSync?: boolean;
}

/** Response for plugin/install. */
export class PluginInstallResponseDto {
  @ApiProperty({ enum: PLUGIN_AUTH_POLICY_VALUES })
  authPolicy!: (typeof PLUGIN_AUTH_POLICY_VALUES)[number];

  @ApiProperty({ type: () => [PluginAppSummaryDto] })
  appsNeedingAuth!: PluginAppSummaryDto[];
}

/** Request body for plugin/uninstall. */
export class PluginUninstallRequestDto {
  @ApiProperty()
  pluginId!: string;

  @ApiPropertyOptional()
  forceRemoteSync?: boolean;
}

/** Empty response body for plugin/uninstall. */
export class PluginUninstallResponseDto {}
