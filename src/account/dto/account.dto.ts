import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { nullableStringEnumSchema } from '../../codex/dto/v2/openapi.schema';

export const ACCOUNT_LOGIN_TYPES = [
  'apiKey',
  'chatgpt',
  'chatgptDeviceCode',
  'chatgptAuthTokens',
] as const;

export const ACCOUNT_TYPES = ['apiKey', 'chatgpt'] as const;

export const AUTH_MODE_VALUES = [
  'apikey',
  'chatgpt',
  'chatgptAuthTokens',
] as const;

export const PLAN_TYPE_VALUES = [
  'free',
  'go',
  'plus',
  'pro',
  'team',
  'self_serve_business_usage_based',
  'business',
  'enterprise_cbp_usage_based',
  'enterprise',
  'edu',
  'unknown',
] as const;

/** Codex account state (apiKey or chatgpt). */
export class AccountDto {
  @ApiProperty({ enum: ACCOUNT_TYPES })
  type!: (typeof ACCOUNT_TYPES)[number];

  @ApiPropertyOptional({
    description: 'ChatGPT email (only when type=chatgpt)',
  })
  email?: string;

  @ApiPropertyOptional({
    enum: PLAN_TYPE_VALUES,
    description: 'ChatGPT plan (only when type=chatgpt)',
  })
  planType?: (typeof PLAN_TYPE_VALUES)[number];
}

/** Provider/account error shape. */
export class AccountErrorDto {
  @ApiPropertyOptional()
  message?: string;

  @ApiPropertyOptional()
  code?: string;
}

/** Provider credential metadata safe to expose in the browser. */
export class AccountProviderDto {
  @ApiProperty()
  ok!: boolean;

  @ApiProperty({ type: String, nullable: true })
  id!: string | null;

  @ApiProperty({ type: String, nullable: true })
  name!: string | null;

  @ApiProperty({ type: String, nullable: true })
  baseUrlMasked!: string | null;

  @ApiProperty({ type: String, nullable: true })
  envKey!: string | null;

  @ApiProperty({ type: Boolean, nullable: true })
  envPresent!: boolean | null;

  @ApiPropertyOptional({ type: () => AccountErrorDto })
  error?: AccountErrorDto;
}

/** Browser-facing account/read response enriched with provider metadata. */
export class AccountReadResponseDto {
  @ApiProperty({ type: () => AccountDto, nullable: true })
  account!: AccountDto | null;

  @ApiProperty()
  requiresOpenaiAuth!: boolean;

  @ApiProperty({ type: () => AccountProviderDto })
  provider!: AccountProviderDto;
}

/** Body for account/login/start. Discriminated by type. */
export class LoginAccountDto {
  @ApiProperty({ enum: ACCOUNT_LOGIN_TYPES })
  type!: (typeof ACCOUNT_LOGIN_TYPES)[number];

  @ApiPropertyOptional({ description: 'Required for API key login.' })
  apiKey?: string;

  @ApiPropertyOptional({
    description: 'Required for externally managed ChatGPT token login.',
  })
  accessToken?: string;

  @ApiPropertyOptional({
    description: 'Required for externally managed ChatGPT token login.',
  })
  chatgptAccountId?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  chatgptPlanType?: string | null;
}

/** Body for account/login/cancel. */
export class CancelLoginAccountDto {
  @ApiProperty()
  loginId!: string;
}

/** account/login/start response. Shape depends on login type. */
export class LoginAccountResponseDto {
  @ApiProperty({ enum: ACCOUNT_LOGIN_TYPES })
  type!: (typeof ACCOUNT_LOGIN_TYPES)[number];

  @ApiPropertyOptional()
  loginId?: string;

  @ApiPropertyOptional()
  authUrl?: string;

  @ApiPropertyOptional()
  verificationUrl?: string;

  @ApiPropertyOptional()
  userCode?: string;
}

/** Codex account/login/completed notification payload mirrored for frontend typing. */
export class AccountLoginCompletedDto {
  @ApiProperty({ type: String, nullable: true })
  loginId!: string | null;

  @ApiProperty()
  success!: boolean;

  @ApiProperty({ type: String, nullable: true })
  error!: string | null;
}

export class RateLimitWindowDto {
  @ApiProperty()
  usedPercent!: number;

  @ApiProperty({ type: Number, nullable: true })
  windowDurationMins!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  resetsAt!: number | null;
}

export class CreditsSnapshotDto {
  @ApiProperty()
  hasCredits!: boolean;

  @ApiProperty()
  unlimited!: boolean;

  @ApiProperty({ type: String, nullable: true })
  balance!: string | null;
}

/** account/rateLimits/read response. Null sections are normal in API-key/proxy mode. */
export class RateLimitSnapshotDto {
  @ApiProperty({ type: String, nullable: true })
  limitId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  limitName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  normalModelSlug!: string | null;

  @ApiProperty({ type: () => RateLimitWindowDto, nullable: true })
  primary!: RateLimitWindowDto | null;

  @ApiProperty({ type: () => RateLimitWindowDto, nullable: true })
  secondary!: RateLimitWindowDto | null;

  @ApiProperty({ type: () => CreditsSnapshotDto, nullable: true })
  credits!: CreditsSnapshotDto | null;

  @ApiProperty(nullableStringEnumSchema(PLAN_TYPE_VALUES))
  planType!: (typeof PLAN_TYPE_VALUES)[number] | null;
}

/** account/rateLimits/read response including legacy and per-limit snapshots. */
export class AccountRateLimitsResponseDto {
  @ApiProperty({ type: () => RateLimitSnapshotDto })
  rateLimits!: RateLimitSnapshotDto;

  @ApiProperty({
    nullable: true,
    additionalProperties: { $ref: '#/components/schemas/RateLimitSnapshotDto' },
  })
  rateLimitsByLimitId!: Record<string, RateLimitSnapshotDto | undefined> | null;

  @ApiProperty({ type: Boolean, nullable: true })
  ordinaryUsageAllowed!: boolean | null;
}
