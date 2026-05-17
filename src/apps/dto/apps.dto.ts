import { ApiProperty } from '@nestjs/swagger';

const STRING_MAP_SCHEMA = {
  type: 'object',
  additionalProperties: { type: 'string' },
  nullable: true,
} as const;

/** Branding fields returned by app/list. */
export class AppBrandingDto {
  @ApiProperty({ type: String, nullable: true })
  category!: string | null;

  @ApiProperty({ type: String, nullable: true })
  developer!: string | null;

  @ApiProperty({ type: String, nullable: true })
  website!: string | null;

  @ApiProperty({ type: String, nullable: true })
  privacyPolicy!: string | null;

  @ApiProperty({ type: String, nullable: true })
  termsOfService!: string | null;

  @ApiProperty()
  isDiscoverableApp!: boolean;
}

/** Review status for app marketplace metadata. */
export class AppReviewDto {
  @ApiProperty()
  status!: string;
}

/** Screenshot metadata for an app. */
export class AppScreenshotDto {
  @ApiProperty({ type: String, nullable: true })
  url!: string | null;

  @ApiProperty({ type: String, nullable: true })
  fileId!: string | null;

  @ApiProperty()
  userPrompt!: string;
}

/** Extended metadata returned for discoverable apps. */
export class AppMetadataDto {
  @ApiProperty({ type: () => AppReviewDto, nullable: true })
  review!: AppReviewDto | null;

  @ApiProperty({ type: [String], nullable: true })
  categories!: string[] | null;

  @ApiProperty({ type: [String], nullable: true })
  subCategories!: string[] | null;

  @ApiProperty({ type: String, nullable: true })
  seoDescription!: string | null;

  @ApiProperty({ type: () => [AppScreenshotDto], nullable: true })
  screenshots!: AppScreenshotDto[] | null;

  @ApiProperty({ type: String, nullable: true })
  developer!: string | null;

  @ApiProperty({ type: String, nullable: true })
  version!: string | null;

  @ApiProperty({ type: String, nullable: true })
  versionId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  versionNotes!: string | null;

  @ApiProperty({ type: String, nullable: true })
  firstPartyType!: string | null;

  @ApiProperty({ type: Boolean, nullable: true })
  firstPartyRequiresInstall!: boolean | null;

  @ApiProperty({ type: Boolean, nullable: true })
  showInComposerWhenUnlinked!: boolean | null;
}

/** App metadata row returned by app/list. */
export class AppInfoDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  logoUrlDark!: string | null;

  @ApiProperty({ type: String, nullable: true })
  distributionChannel!: string | null;

  @ApiProperty({ type: () => AppBrandingDto, nullable: true })
  branding!: AppBrandingDto | null;

  @ApiProperty({ type: () => AppMetadataDto, nullable: true })
  appMetadata!: AppMetadataDto | null;

  @ApiProperty(STRING_MAP_SCHEMA)
  labels!: Record<string, string> | null;

  @ApiProperty({ type: String, nullable: true })
  installUrl!: string | null;

  @ApiProperty()
  isAccessible!: boolean;

  @ApiProperty()
  isEnabled!: boolean;

  @ApiProperty({ type: [String] })
  pluginDisplayNames!: string[];
}

/** Paginated app/list response. */
export class AppsListResponseDto {
  @ApiProperty({ type: () => [AppInfoDto] })
  data!: AppInfoDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
