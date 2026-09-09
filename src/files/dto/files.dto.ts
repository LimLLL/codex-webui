import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Directory entry returned by the file tree endpoint. */
export class FileEntryDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  path!: string;

  @ApiProperty({ enum: ['file', 'directory'] })
  type!: 'file' | 'directory';

  @ApiPropertyOptional()
  size?: number;

  @ApiPropertyOptional()
  mtime?: number;
}

/** Text-file read response. */
export class FileReadResponseDto {
  @ApiProperty()
  content!: string;

  @ApiProperty()
  size!: number;

  /**
   * Modification time captured with this content, as the write precondition.
   *
   * Paired with the body deliberately: a time taken from a separate metadata
   * request can refresh independently of the content and end up vouching for a
   * buffer it never described.
   */
  @ApiProperty()
  mtime!: number;
}

/** File write request body. */
export class WriteFileRequestDto {
  @ApiProperty()
  path!: string;

  @ApiProperty()
  content!: string;

  @ApiPropertyOptional()
  expectedMtime?: number;
}

/** File write response containing the new modification time. */
export class WriteFileResponseDto {
  @ApiProperty()
  mtime!: number;
}

/** File creation request body. */
export class CreateFileRequestDto {
  @ApiProperty()
  path!: string;

  @ApiPropertyOptional({ default: '' })
  content?: string;

  @ApiPropertyOptional({ default: false })
  overwrite?: boolean;
}

/** File creation response. */
export class CreateFileResponseDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty()
  path!: string;

  @ApiProperty()
  mtime!: number;
}

/** Directory creation request body. */
export class CreateDirectoryRequestDto {
  @ApiProperty()
  path!: string;

  @ApiPropertyOptional({ default: false })
  recursive?: boolean;

  @ApiPropertyOptional({ default: false })
  overwrite?: boolean;
}

/** Directory creation response. */
export class CreateDirectoryResponseDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty()
  path!: string;
}

/** Same-parent rename request body. */
export class RenamePathRequestDto {
  @ApiProperty()
  path!: string;

  @ApiProperty()
  newName!: string;

  @ApiPropertyOptional({ default: false })
  overwrite?: boolean;
}

/** Rename response containing old and new paths. */
export class RenamePathResponseDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty()
  oldPath!: string;

  @ApiProperty()
  newPath!: string;
}

/** Copy request body. */
export class CopyPathRequestDto {
  @ApiProperty()
  sourcePath!: string;

  @ApiProperty()
  destinationPath!: string;

  @ApiPropertyOptional({ default: false })
  overwrite?: boolean;
}

/** Move request body. */
export class MovePathRequestDto {
  @ApiProperty()
  sourcePath!: string;

  @ApiProperty()
  destinationPath!: string;

  @ApiPropertyOptional({ default: false })
  overwrite?: boolean;
}

/** Copy response containing source and destination paths. */
export class CopyPathResponseDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty()
  sourcePath!: string;

  @ApiProperty()
  destinationPath!: string;
}

/** Move response containing old and new paths. */
export class MovePathResponseDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty()
  oldPath!: string;

  @ApiProperty()
  newPath!: string;
}

/** Uploaded file result. */
export class UploadedFileDto {
  @ApiProperty()
  path!: string;

  @ApiProperty()
  size!: number;
}

/** Upload response containing all stored files. */
export class UploadFilesResponseDto {
  @ApiProperty({ example: true })
  ok!: boolean;

  @ApiProperty({ type: [UploadedFileDto] })
  files!: UploadedFileDto[];
}

/** File or directory metadata response. */
export class FileMetadataDto {
  @ApiProperty()
  path!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['file', 'directory', 'symlink', 'other'] })
  type!: 'file' | 'directory' | 'symlink' | 'other';

  @ApiProperty()
  size!: number;

  @ApiProperty()
  mtime!: number;

  @ApiProperty()
  permissions!: string;
}

/** Workspace roots response used by login and file browser bootstrapping. */
export class WorkspaceRootsResponseDto {
  @ApiProperty({ type: [String] })
  roots!: string[];

  @ApiProperty()
  homeDir!: string;
}

/** Request body for adding a workspace root. */
export class AddWorkspaceRootRequestDto {
  @ApiProperty()
  root!: string;
}
