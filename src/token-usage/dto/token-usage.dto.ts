import { ApiProperty } from '@nestjs/swagger';

/** Token usage counters for one model call or aggregate snapshot. */
export class TokenUsageBreakdownDto {
  @ApiProperty()
  totalTokens!: number;

  @ApiProperty()
  inputTokens!: number;

  @ApiProperty()
  cachedInputTokens!: number;

  @ApiProperty()
  outputTokens!: number;

  @ApiProperty()
  reasoningOutputTokens!: number;
}

/** Thread-level token usage payload mirrored from app-server notifications. */
export class ThreadTokenUsageDto {
  @ApiProperty({ type: () => TokenUsageBreakdownDto })
  total!: TokenUsageBreakdownDto;

  @ApiProperty({ type: () => TokenUsageBreakdownDto })
  last!: TokenUsageBreakdownDto;

  @ApiProperty({ nullable: true, type: Number })
  modelContextWindow!: number | null;
}

/** Persisted token usage for a specific turn. */
export class TurnTokenUsageDto {
  @ApiProperty()
  turnId!: string;

  @ApiProperty({ type: () => ThreadTokenUsageDto })
  usage!: ThreadTokenUsageDto;

  @ApiProperty()
  updatedAt!: number;
}

/** Token usage query response for hydrating the frontend store. */
export class ThreadTokenUsageResponseDto {
  @ApiProperty()
  threadId!: string;

  @ApiProperty({ type: () => [TurnTokenUsageDto] })
  turns!: TurnTokenUsageDto[];

  @ApiProperty({ nullable: true, type: () => TurnTokenUsageDto })
  latest!: TurnTokenUsageDto | null;
}
