/** Request and response shapes for locally tracked conversation branches. */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ThreadForkResponseDto } from '../../codex/dto/v2';

export type BranchMetadataSource = 'local' | 'adopted';

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

  @ApiProperty({ enum: ['local', 'adopted'] })
  source!: BranchMetadataSource;

  /**
   * Grouping key of the fork that created this member; null for the tree root.
   *
   * A thread can hold version rows in more than one group, so this is what tells
   * a client which of them describes the member's own divergence rather than an
   * edit made later inside it.
   */
  @ApiPropertyOptional({ type: String, nullable: true })
  commonPrefixTurnId!: string | null;
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

  @ApiProperty({ enum: ['local', 'adopted'] })
  source!: BranchMetadataSource;

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

export type BranchAdoptionStatus = 'pending' | 'running' | 'ready' | 'failed';

export type BranchAdoptionDiagnosticSeverity = 'warning' | 'error';

export type BranchAdoptionDiagnosticCode =
  | 'scan_not_ready'
  | 'session_file_unreadable'
  | 'session_header_missing'
  | 'session_header_invalid'
  | 'parent_missing'
  | 'history_base_missing'
  | 'history_base_invalid'
  | 'history_base_parent_mismatch'
  | 'history_base_offset_mismatch'
  | 'duplicate_child_conflict'
  | 'local_edge_conflict'
  | 'local_version_conflict'
  | 'topology_cycle';

/** One conservative scanner diagnostic from private rollout metadata parsing. */
export class BranchAdoptionDiagnosticDto {
  @ApiProperty({ enum: ['warning', 'error'] })
  severity!: BranchAdoptionDiagnosticSeverity;

  @ApiProperty()
  code!: BranchAdoptionDiagnosticCode;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional()
  threadId?: string;

  @ApiPropertyOptional()
  parentThreadId?: string;
}

/** Startup scanner status used to gate destructive branch operations. */
export class BranchAdoptionStatusDto {
  @ApiProperty({ enum: ['pending', 'running', 'ready', 'failed'] })
  status!: BranchAdoptionStatus;

  @ApiProperty()
  generation!: number;

  /** Rollout files found on disk across `sessions/` and `archived_sessions/`. */
  @ApiProperty()
  scannedFiles!: number;

  /**
   * Files whose **header** was read successfully — not files parsed in full.
   *
   * The scan is two-pass by design: every file gives up its first line only, and
   * just the fork chains are then parsed end to end. Reading this as a full-parse
   * count would hide the difference that keeps startup off a gigabyte of JSON.
   */
  @ApiProperty()
  parsedFiles!: number;

  /** Files parsed end to end, i.e. those on a fork chain. */
  @ApiProperty()
  fullyParsedFiles!: number;

  @ApiProperty()
  adoptedEdges!: number;

  @ApiProperty()
  adoptedVersions!: number;

  @ApiProperty()
  topologyOnlyEdges!: number;

  @ApiProperty()
  skippedLegacyForks!: number;

  @ApiProperty()
  skippedFiles!: number;

  @ApiProperty()
  conflicts!: number;

  @ApiPropertyOptional()
  errorMessage?: string;

  @ApiProperty({ type: () => [BranchAdoptionDiagnosticDto] })
  diagnostics!: BranchAdoptionDiagnosticDto[];
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
