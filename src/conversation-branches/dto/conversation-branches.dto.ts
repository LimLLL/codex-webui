/** Request and response shapes for locally tracked conversation branches. */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ThreadForkResponseDto } from '../../codex/dto/v2';

/** Request body for creating a new version by forking before a user turn. */
export class CreateMessageBranchDto {
  @ApiProperty({
    description: 'Turn id of the user message being edited.',
  })
  editedTurnId!: string;

  @ApiPropertyOptional({
    description:
      'Preview text for the edited version before the new turn exists.',
  })
  previewText?: string;
}

/** One locally tracked thread in a branch tree. */
export class BranchTreeMemberDto {
  @ApiProperty()
  threadId!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  parentThreadId!: string | null;

  @ApiProperty()
  hasChildren!: boolean;
}

/** A concrete sibling version for one edited user-message group. */
export class BranchVersionDto {
  @ApiProperty()
  versionId!: string;

  @ApiProperty()
  groupId!: string;

  @ApiProperty()
  threadId!: string;

  @ApiProperty()
  versionIndex!: number;

  @ApiProperty({ enum: ['original', 'branch'] })
  kind!: 'original' | 'branch';

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Turn carrying this version's message; null until it starts.",
  })
  messageTurnId!: string | null;

  @ApiProperty()
  previewText!: string;

  @ApiProperty()
  createdAt!: number;

  @ApiProperty()
  updatedAt!: number;
}

/** Versions attached to one edited user message. */
export class BranchGroupDto {
  @ApiProperty()
  groupId!: string;

  @ApiProperty()
  treeRootThreadId!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Last turn of the common prefix; null when the first turn was edited.',
  })
  commonPrefixTurnId!: string | null;

  @ApiProperty()
  createdAt!: number;

  @ApiProperty()
  updatedAt!: number;

  @ApiProperty({ type: () => [BranchVersionDto] })
  versions!: BranchVersionDto[];
}

/** Complete local branch topology for a tree. */
export class BranchTreeDto {
  @ApiProperty()
  treeRootThreadId!: string;

  @ApiProperty()
  tracked!: boolean;

  @ApiProperty({ type: () => [BranchTreeMemberDto] })
  members!: BranchTreeMemberDto[];

  @ApiProperty({ type: () => [BranchGroupDto] })
  groups!: BranchGroupDto[];
}

/**
 * Mutating-operation capability summary for a thread.
 *
 * Derived purely from local topology so the client can render disabled states
 * without a round trip to app-server. Forks made by other clients are invisible
 * here; the server re-checks them when the operation is actually attempted.
 */
export class BranchStateDto {
  @ApiProperty()
  threadId!: string;

  @ApiProperty()
  treeRootThreadId!: string;

  @ApiProperty({
    description: 'Whether this client knows any branch metadata.',
  })
  tracked!: boolean;

  @ApiProperty({
    description:
      'Blocks compaction and deletion: descendants read this history.',
  })
  hasKnownDescendants!: boolean;

  @ApiProperty({ type: () => [String] })
  knownTreeThreadIds!: string[];
}

/** Response returned after a fork has been recorded locally. */
export class CreateMessageBranchResponseDto {
  @ApiProperty({ type: () => ThreadForkResponseDto })
  fork!: ThreadForkResponseDto;

  @ApiProperty({ type: () => BranchTreeDto })
  tree!: BranchTreeDto;

  @ApiProperty({ type: () => BranchGroupDto })
  group!: BranchGroupDto;

  @ApiProperty({ type: () => BranchVersionDto })
  version!: BranchVersionDto;
}
