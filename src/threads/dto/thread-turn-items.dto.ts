/** Bounded persisted-item read contract for open/reconnect recovery. */
import { ApiProperty } from '@nestjs/swagger';
import { threadItemSchema } from '../../codex/dto/v2';
import type { TurnItemsRead } from '../thread-item-history';

/** An exhausted read covers persisted items at read time, not future completions. */
export class ThreadTurnItemsResponseDto {
  @ApiProperty({
    type: 'array',
    items: threadItemSchema(false) as Record<string, unknown>,
    description:
      'Persisted completion order; may differ from live item-start order.',
  })
  items!: Record<string, unknown>[];

  @ApiProperty({
    description: 'True only when paging reached explicit cursor exhaustion.',
  })
  complete!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Continue a capped read. Null alone does not imply completeness.',
  })
  nextCursor!: string | null;

  // `null` is listed in the enum rather than relying on `nullable: true` alone:
  // with an enum schema the generated client drops the sibling nullable flag,
  // and a complete read reports null here. Without it the client type promises
  // a reason on every response, including the successful ones.
  @ApiProperty({
    enum: [
      'pageLimit',
      'cursorCycle',
      'invalidResponse',
      'pagingUnavailable',
      null,
    ],
    nullable: true,
  })
  incompleteReason!: TurnItemsRead['incompleteReason'];
}
