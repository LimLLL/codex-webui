/**
 * File system operations with workspace root security enforcement.
 * All paths are resolved to real paths and validated against allowed workspace roots.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  isSecuritySettingKey,
  SECURITY_SETTING_KEYS,
} from '../settings/settings.definitions';
import { SettingsService } from '../settings/settings.service';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Maximum file size for text reading (5 MB). */
const MAX_READ_SIZE = 5 * 1024 * 1024;

/** Prefix used for upload temp files written next to their final target. */
const UPLOAD_TEMP_PREFIX = '.codex-upload-';

/** Directories always excluded from tree listings. */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  '__pycache__',
  '.DS_Store',
]);

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: number;
}

export interface FileMetadata {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: number;
  permissions: string;
}

export interface FileCreateResult {
  path: string;
  mtime: number;
}

export interface FileRelocationResult {
  oldPath?: string;
  newPath?: string;
  sourcePath?: string;
  destinationPath?: string;
}

export interface FileDownloadResult {
  path: string;
  filename: string;
  size: number;
  stream: fsSync.ReadStream;
}

export interface FileUploadInput {
  filename: string;
  relativePath?: string;
  stream: Readable;
}

export interface UploadedFileResult {
  path: string;
  size: number;
}

export interface UploadFilesResult {
  files: UploadedFileResult[];
}

interface ResolveTargetOptions {
  /** Allows mkdir -p style target resolution by validating the nearest existing ancestor. */
  recursiveParent?: boolean;
}

interface ExistingAncestor {
  originalPath: string;
  resolvedPath: string;
}

@Injectable()
export class FilesService implements OnModuleDestroy {
  private readonly logger = new Logger(FilesService.name);
  /** Roots dynamically added via addWorkspaceRoot (e.g. thread cwd). */
  private readonly dynamicRoots = new Set<string>();
  /** Union of configured roots (from setting/env) + dynamicRoots + home. */
  private workspaceRoots = new Set<string>();
  private unregisterSettingsChange: (() => void) | null = null;

  constructor(private readonly settingsService: SettingsService) {
    this.rebuildWorkspaceRoots();
    this.unregisterSettingsChange = this.settingsService.onChange((event) => {
      if (!isSecuritySettingKey(event.key)) return;
      this.rebuildWorkspaceRoots();
      this.logger.log('Workspace roots updated from runtime settings');
    });
  }

  onModuleDestroy(): void {
    if (this.unregisterSettingsChange) {
      this.unregisterSettingsChange();
      this.unregisterSettingsChange = null;
    }
  }

  /** Rebuilds the workspace roots set from the runtime setting. */
  private rebuildWorkspaceRoots(): void {
    const rootsStr =
      this.settingsService.getStringSetting(
        SECURITY_SETTING_KEYS.workspaceRoots,
      ) ?? '';
    const next = new Set<string>();
    for (const root of rootsStr
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)) {
      try {
        next.add(this.resolveExistingDirectorySync(root));
      } catch {
        this.logger.warn(`Skipping invalid workspace root: ${root}`);
      }
    }
    // Home directory is always included
    next.add(fsSync.realpathSync(os.homedir()));

    // Prune dynamic roots that no longer fall within any configured root
    for (const dynamicRoot of this.dynamicRoots) {
      const stillAllowed = [...next].some((root) =>
        this.isPathInside(dynamicRoot, root),
      );
      if (!stillAllowed) {
        this.dynamicRoots.delete(dynamicRoot);
        this.logger.warn(
          `Removed dynamic workspace root outside current settings: ${dynamicRoot}`,
        );
      }
    }

    // Merge configured + surviving dynamic
    this.workspaceRoots = new Set([...next, ...this.dynamicRoots]);
  }

  /**
   * Registers a workspace root directory (e.g. from a thread's cwd).
   * Dynamic roots must fall within an already-configured root.
   *
   * @param root - Absolute path to register
   * @throws ForbiddenException if root escapes configured workspace roots
   */
  addWorkspaceRoot(root: string): void {
    const resolved = this.resolveExistingDirectorySync(root);
    if (!this.isAllowedPath(resolved)) {
      throw new ForbiddenException(
        'Workspace root must be inside configured workspace roots',
      );
    }

    if (!this.workspaceRoots.has(resolved)) {
      this.dynamicRoots.add(resolved);
      this.workspaceRoots.add(resolved);
      this.logger.log(`Registered dynamic workspace root: ${resolved}`);
    }
  }

  /**
   * Resolves and validates that a path falls within an allowed workspace root.
   *
   * @param inputPath - The user-supplied path to validate
   * @returns The resolved real path
   * @throws ForbiddenException if path escapes workspace roots
   * @throws NotFoundException if path does not exist
   */
  async resolveSafePath(inputPath: string): Promise<string> {
    if (!inputPath) {
      throw new BadRequestException('Path is required');
    }

    let resolved: string;
    try {
      resolved = await fs.realpath(path.resolve(inputPath));
    } catch {
      throw new NotFoundException(`Path not found: ${inputPath}`);
    }

    if (!this.isAllowedPath(resolved)) {
      throw new ForbiddenException('Path outside allowed workspace roots');
    }

    return resolved;
  }

  /**
   * Resolves a destination path that may not exist yet.
   * The target parent must exist unless recursiveParent is enabled.
   *
   * @param inputPath - The user-supplied target path
   * @param options - Target resolution options
   * @returns Absolute safe target path rooted under an allowed workspace root
   */
  async resolveSafeTargetPath(
    inputPath: string,
    options: ResolveTargetOptions = {},
  ): Promise<string> {
    if (!inputPath) {
      throw new BadRequestException('Path is required');
    }

    const absolutePath = path.resolve(inputPath);
    this.validateEntryName(path.basename(absolutePath));

    if (!options.recursiveParent) {
      const resolvedParent = await this.resolveSafePath(
        path.dirname(absolutePath),
      );
      return path.join(resolvedParent, path.basename(absolutePath));
    }

    const parentPath = path.dirname(absolutePath);
    const ancestor = await this.resolveNearestExistingAncestor(parentPath);
    const relativeParent = path.relative(ancestor.originalPath, parentPath);
    const resolvedParent = relativeParent
      ? path.join(ancestor.resolvedPath, relativeParent)
      : ancestor.resolvedPath;
    const targetPath = path.join(resolvedParent, path.basename(absolutePath));

    this.assertAllowedPath(targetPath);
    return targetPath;
  }

  /**
   * Rejects unsafe single path entries such as separators, empty names, or traversal.
   *
   * @param name - One file or directory name, not a full path
   */
  validateEntryName(name: string): void {
    if (!name || name.trim().length === 0) {
      throw new BadRequestException('File or directory name is required');
    }
    if (name === '.' || name === '..') {
      throw new BadRequestException('Path traversal is not allowed');
    }
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new BadRequestException('File or directory name is invalid');
    }
  }

  /**
   * Reads a directory and returns its entries (one level, no recursion).
   *
   * @param dirPath - Directory to read
   * @returns Sorted array of file entries (directories first, then files)
   */
  async readDirectory(dirPath: string): Promise<FileEntry[]> {
    const resolved = await this.resolveSafePath(dirPath);

    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new BadRequestException('Path is not a directory');
    }

    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const result: FileEntry[] = [];

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;

      const entryPath = path.join(resolved, entry.name);
      const isDir = entry.isDirectory();

      let size: number | undefined;
      let mtime: number | undefined;
      if (!isDir) {
        try {
          const s = await fs.stat(entryPath);
          size = s.size;
          mtime = s.mtimeMs;
        } catch {
          /* skip unreadable entries */
        }
      }

      result.push({
        name: entry.name,
        path: entryPath,
        type: isDir ? 'directory' : 'file',
        size,
        mtime,
      });
    }

    // Directories first, then alphabetical within each group
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return result;
  }

  /**
   * Reads a text file's content.
   *
   * @param filePath - File to read
   * @returns The file content as UTF-8 string
   * @throws BadRequestException if file exceeds MAX_READ_SIZE
   */
  async readFile(filePath: string): Promise<{ content: string; size: number }> {
    const resolved = await this.resolveSafePath(filePath);

    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      throw new BadRequestException('Path is a directory, not a file');
    }
    if (stat.size > MAX_READ_SIZE) {
      throw new BadRequestException(
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_READ_SIZE / 1024 / 1024} MB`,
      );
    }

    const content = await fs.readFile(resolved, 'utf-8');
    return { content, size: stat.size };
  }

  /**
   * Creates a new text file with optional initial content.
   * Existing targets are rejected unless overwrite is explicitly enabled.
   *
   * @param filePath - File path to create
   * @param content - Optional UTF-8 content, defaults to empty string
   * @param overwrite - Whether an existing file may be overwritten
   * @returns The created file path and modification time
   */
  async createFile(
    filePath: string,
    content = '',
    overwrite = false,
  ): Promise<FileCreateResult> {
    const targetPath = await this.resolveSafeTargetPath(filePath);
    const existing = await this.assertNoOverwrite(targetPath, overwrite);
    if (existing?.isDirectory()) {
      throw new BadRequestException('Cannot overwrite a directory with a file');
    }

    try {
      await fs.writeFile(targetPath, content, {
        encoding: 'utf-8',
        flag: overwrite ? 'w' : 'wx',
      });
    } catch (err) {
      this.rethrowFsError(err, targetPath);
    }

    const stat = await fs.stat(targetPath);
    return { path: targetPath, mtime: stat.mtimeMs };
  }

  /**
   * Creates a directory, optionally creating missing parent directories.
   * Existing targets are rejected unless overwrite is explicitly enabled.
   *
   * @param dirPath - Directory path to create
   * @param recursive - Whether to create missing parent directories
   * @param overwrite - Whether an existing directory is acceptable
   * @returns The created directory path
   */
  async createDirectory(
    dirPath: string,
    recursive = false,
    overwrite = false,
  ): Promise<{ path: string }> {
    const targetPath = await this.resolveSafeTargetPath(dirPath, {
      recursiveParent: recursive,
    });
    const existing = await this.assertNoOverwrite(targetPath, overwrite);

    if (existing) {
      if (existing.isDirectory()) {
        return { path: targetPath };
      }
      throw new BadRequestException('Path exists and is not a directory');
    }

    try {
      await fs.mkdir(targetPath, { recursive });
    } catch (err) {
      this.rethrowFsError(err, targetPath);
    }

    return { path: targetPath };
  }

  /**
   * Writes content to a file, with optional mtime conflict detection.
   * Validates the final target path against workspace roots (symlink-safe).
   *
   * @param filePath - File to write
   * @param content - Text content to save
   * @param expectedMtime - If provided, reject if file was modified since this timestamp
   * @returns The new mtime after writing
   */
  async writeFile(
    filePath: string,
    content: string,
    expectedMtime?: number,
  ): Promise<{ mtime: number }> {
    const resolved = await this.resolveSafePath(
      path.dirname(path.resolve(filePath)),
    );
    let targetPath = path.join(resolved, path.basename(filePath));

    // If the target already exists, resolve its real path to catch symlinks
    try {
      targetPath = await this.resolveSafePath(targetPath);
    } catch (err) {
      if (!(err instanceof NotFoundException)) {
        throw err;
      }
      // File doesn't exist yet — ok to create in the resolved directory
    }

    if (expectedMtime !== undefined) {
      try {
        const current = await fs.stat(targetPath);
        if (Math.abs(current.mtimeMs - expectedMtime) > 1000) {
          throw new BadRequestException(
            'File was modified since last read. Refresh and retry.',
          );
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        // File doesn't exist yet — ok to create
      }
    }

    await fs.writeFile(targetPath, content, 'utf-8');
    const newStat = await fs.stat(targetPath);
    return { mtime: newStat.mtimeMs };
  }

  /**
   * Renames a file or directory within the same parent directory.
   *
   * @param sourcePath - Existing file or directory path
   * @param newName - New entry name, not a full path
   * @param overwrite - Whether an existing same-parent target may be overwritten
   * @returns Old and new paths
   */
  async renamePath(
    sourcePath: string,
    newName: string,
    overwrite = false,
  ): Promise<FileRelocationResult> {
    this.validateEntryName(newName);
    const source = await this.resolveSafePath(sourcePath);
    this.assertNotWorkspaceRoot(source);
    const destination = await this.resolveSafeTargetPath(
      path.join(path.dirname(source), newName),
    );
    await this.assertNoOverwrite(destination, overwrite);
    this.assertNotSelfOrDescendant(source, destination);

    try {
      await fs.rename(source, destination);
    } catch (err) {
      this.rethrowFsError(err, destination);
    }

    return { oldPath: source, newPath: destination };
  }

  /**
   * Copies a file or directory to a safe destination path.
   * Directory copies are recursive and cannot target themselves or descendants.
   *
   * @param sourcePath - Existing file or directory to copy
   * @param destinationPath - Destination path that may not exist yet
   * @param overwrite - Whether an existing destination may be overwritten
   * @returns Source and destination paths
   */
  async copyPath(
    sourcePath: string,
    destinationPath: string,
    overwrite = false,
  ): Promise<FileRelocationResult> {
    const source = await this.resolveSafePath(sourcePath);
    const destination = await this.resolveSafeTargetPath(destinationPath);
    await this.assertNoOverwrite(destination, overwrite);
    this.assertNotSelfOrDescendant(source, destination);

    const sourceStat = await fs.lstat(source);
    try {
      if (sourceStat.isDirectory()) {
        await fs.cp(source, destination, {
          recursive: true,
          force: overwrite,
          errorOnExist: !overwrite,
          dereference: false,
        });
      } else {
        await fs.copyFile(
          source,
          destination,
          overwrite ? 0 : fsSync.constants.COPYFILE_EXCL,
        );
      }
    } catch (err) {
      this.rethrowFsError(err, destination);
    }

    return { sourcePath: source, destinationPath: destination };
  }

  /**
   * Moves a file or directory to a safe destination path using fs.rename.
   * Cross-device moves fail fast with an explicit error; no copy/delete fallback.
   *
   * @param sourcePath - Existing file or directory to move
   * @param destinationPath - Destination path that may not exist yet
   * @param overwrite - Whether an existing destination may be overwritten
   * @returns Old and new paths
   */
  async movePath(
    sourcePath: string,
    destinationPath: string,
    overwrite = false,
  ): Promise<FileRelocationResult> {
    const source = await this.resolveSafePath(sourcePath);
    this.assertNotWorkspaceRoot(source);
    const destination = await this.resolveSafeTargetPath(destinationPath);
    await this.assertNoOverwrite(destination, overwrite);
    this.assertNotSelfOrDescendant(source, destination);

    try {
      await fs.rename(source, destination);
    } catch (err) {
      this.rethrowFsError(err, destination);
    }

    return { oldPath: source, newPath: destination };
  }

  /**
   * Returns metadata for a file or directory.
   *
   * @param targetPath - Path to inspect
   * @returns File metadata (type, size, mtime, permissions)
   */
  async getMetadata(targetPath: string): Promise<FileMetadata> {
    const resolved = await this.resolveSafePath(targetPath);
    const stat = await fs.lstat(resolved);

    let type: FileMetadata['type'] = 'other';
    if (stat.isFile()) type = 'file';
    else if (stat.isDirectory()) type = 'directory';
    else if (stat.isSymbolicLink()) type = 'symlink';

    return {
      path: resolved,
      name: path.basename(resolved),
      type,
      size: stat.size,
      mtime: stat.mtimeMs,
      permissions: `0${(stat.mode & 0o777).toString(8)}`,
    };
  }

  /**
   * Returns the list of configured workspace roots.
   *
   * @returns Array of absolute paths
   */
  getWorkspaceRoots(): string[] {
    return Array.from(this.workspaceRoots);
  }

  /** Returns the user's home directory. */
  getHomeDir(): string {
    return os.homedir();
  }

  /**
   * Deletes a file, symlink, or directory.
   * Recursive directory deletion is opt-in. Symlinks remove the link only.
   *
   * @param targetPath - Path to delete
   * @param recursive - Whether non-empty directories may be removed recursively
   */
  async deletePath(targetPath: string, recursive = false): Promise<void> {
    const entryPath = await this.resolveSafeTargetPath(targetPath);
    this.assertNotWorkspaceRoot(entryPath);

    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(entryPath);
    } catch {
      throw new NotFoundException(`Path not found: ${targetPath}`);
    }

    try {
      if (stat.isSymbolicLink()) {
        await fs.unlink(entryPath);
      } else if (stat.isDirectory()) {
        if (recursive) {
          await fs.rm(entryPath, { recursive: true, force: false });
        } else {
          await fs.rmdir(entryPath);
        }
      } else {
        await fs.unlink(entryPath);
      }
    } catch (err) {
      this.rethrowFsError(err, entryPath);
    }
  }

  /**
   * Prepares a safe file stream for download.
   *
   * @param filePath - File path to download
   * @returns File stream metadata and readable stream
   */
  async prepareDownload(filePath: string): Promise<FileDownloadResult> {
    const resolved = await this.resolveSafePath(filePath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new BadRequestException('Path is not a downloadable file');
    }

    return {
      path: resolved,
      filename: path.basename(resolved),
      size: stat.size,
      stream: fsSync.createReadStream(resolved),
    };
  }

  /**
   * Streams uploaded files into a destination directory, preserving relative paths.
   * Uploads are first written to temp files, then finalized to avoid partial targets.
   *
   * @param destinationPath - Existing directory to receive uploads
   * @param uploads - Async stream of uploaded file descriptors
   * @param overwrite - Whether existing file targets may be overwritten
   * @returns Uploaded file paths and sizes
   */
  async saveUploadedFiles(
    destinationPath: string,
    uploads: AsyncIterable<FileUploadInput>,
    overwrite = false,
  ): Promise<UploadFilesResult> {
    const destinationRoot = await this.resolveSafePath(destinationPath);
    const rootStat = await fs.stat(destinationRoot);
    if (!rootStat.isDirectory()) {
      throw new BadRequestException('Upload destination is not a directory');
    }

    const files: UploadedFileResult[] = [];
    for await (const upload of uploads) {
      files.push(
        await this.saveSingleUpload(destinationRoot, upload, overwrite),
      );
    }

    if (files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    return { files };
  }

  /** Resolves a path synchronously, ensuring it exists and is a directory. */
  private resolveExistingDirectorySync(inputPath: string): string {
    if (!inputPath) {
      throw new BadRequestException('Path is required');
    }
    const resolved = fsSync.realpathSync(path.resolve(inputPath));
    const stat = fsSync.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new BadRequestException('Workspace root is not a directory');
    }
    return resolved;
  }

  /** Resolves the closest existing parent directory for recursive target creation. */
  private async resolveNearestExistingAncestor(
    inputPath: string,
  ): Promise<ExistingAncestor> {
    let current = path.resolve(inputPath);

    while (true) {
      try {
        const stat = await fs.stat(current);
        if (!stat.isDirectory()) {
          throw new BadRequestException('Parent path is not a directory');
        }
        const resolved = await this.resolveSafePath(current);
        return { originalPath: current, resolvedPath: resolved };
      } catch (err) {
        if (err instanceof HttpException) {
          throw err;
        }
        const parent = path.dirname(current);
        if (parent === current) {
          throw new NotFoundException(`No existing parent found: ${inputPath}`);
        }
        current = parent;
      }
    }
  }

  /** Checks whether a target already exists and enforces explicit overwrite. */
  private async assertNoOverwrite(
    targetPath: string,
    overwrite: boolean,
  ): Promise<fsSync.Stats | null> {
    const existing = await this.getOptionalLstat(targetPath);
    if (existing && !overwrite) {
      throw new ConflictException(`Path already exists: ${targetPath}`);
    }
    return existing;
  }

  /** Rejects copy/move operations that target the source or one of its descendants. */
  private assertNotSelfOrDescendant(
    sourcePath: string,
    targetPath: string,
  ): void {
    const relative = path.relative(sourcePath, targetPath);
    if (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    ) {
      throw new BadRequestException(
        'Destination cannot be the source or its descendant',
      );
    }
  }

  /** Prevents destructive operations against configured workspace roots. */
  private assertNotWorkspaceRoot(targetPath: string): void {
    if (this.workspaceRoots.has(targetPath)) {
      throw new BadRequestException('Cannot modify a workspace root directly');
    }
  }

  /** Ensures an absolute path remains under a specific resolved root. */
  private assertPathInside(targetPath: string, rootPath: string): void {
    if (!this.isPathInside(targetPath, rootPath)) {
      throw new ForbiddenException('Path outside allowed workspace roots');
    }
  }

  /** Ensures an absolute path is covered by at least one configured workspace root. */
  private assertAllowedPath(targetPath: string): void {
    if (!this.isAllowedPath(targetPath)) {
      throw new ForbiddenException('Path outside allowed workspace roots');
    }
  }

  /** Returns lstat data when a target exists, otherwise null. */
  private async getOptionalLstat(
    targetPath: string,
  ): Promise<fsSync.Stats | null> {
    try {
      return await fs.lstat(targetPath);
    } catch (err) {
      if (this.getErrorCode(err) === 'ENOENT') return null;
      throw err;
    }
  }

  /** Streams one uploaded file to a temp file and finalizes it atomically where possible. */
  private async saveSingleUpload(
    destinationRoot: string,
    upload: FileUploadInput,
    overwrite: boolean,
  ): Promise<UploadedFileResult> {
    const targetPath = this.resolveUploadTargetPath(
      destinationRoot,
      upload.relativePath ?? upload.filename,
    );
    const parentDir = path.dirname(targetPath);
    await fs.mkdir(parentDir, { recursive: true });

    const existing = await this.assertNoOverwrite(targetPath, overwrite);
    if (existing?.isDirectory()) {
      throw new BadRequestException(
        'Cannot overwrite a directory with an upload',
      );
    }

    let tempPath: string | null = path.join(
      parentDir,
      `${UPLOAD_TEMP_PREFIX}${randomUUID()}.tmp`,
    );

    try {
      await pipeline(
        upload.stream,
        fsSync.createWriteStream(tempPath, { flags: 'wx' }),
      );

      const latestExisting = await this.getOptionalLstat(targetPath);
      if (latestExisting?.isDirectory()) {
        throw new BadRequestException(
          'Cannot overwrite a directory with an upload',
        );
      }
      if (latestExisting && !overwrite) {
        throw new ConflictException(`Path already exists: ${targetPath}`);
      }

      if (overwrite) {
        await fs.rename(tempPath, targetPath);
      } else {
        await fs.copyFile(tempPath, targetPath, fsSync.constants.COPYFILE_EXCL);
        await fs.unlink(tempPath);
      }
      tempPath = null;
    } catch (err) {
      if (tempPath) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
      this.rethrowFsError(err, targetPath);
    }

    const stat = await fs.stat(targetPath);
    return { path: targetPath, size: stat.size };
  }

  /** Builds a safe absolute target path for one uploaded file. */
  private resolveUploadTargetPath(
    destinationRoot: string,
    relativePath: string,
  ): string {
    const segments = this.normalizeUploadRelativePath(relativePath);
    const targetPath = path.join(destinationRoot, ...segments);
    this.assertPathInside(targetPath, destinationRoot);
    return targetPath;
  }

  /** Validates folder-upload relative paths and returns safe path segments. */
  private normalizeUploadRelativePath(relativePath: string): string[] {
    if (!relativePath || relativePath.includes('\\')) {
      throw new BadRequestException('Upload relative path is invalid');
    }
    if (
      path.posix.isAbsolute(relativePath) ||
      path.win32.isAbsolute(relativePath)
    ) {
      throw new BadRequestException(
        'Upload relative path must not be absolute',
      );
    }

    const segments = relativePath.split('/');
    if (segments.some((segment) => segment.length === 0)) {
      throw new BadRequestException(
        'Upload relative path contains an empty segment',
      );
    }

    for (const segment of segments) {
      this.validateEntryName(segment);
    }
    return segments;
  }

  /** Converts common filesystem errors into explicit HTTP exceptions. */
  private rethrowFsError(error: unknown, targetPath: string): never {
    if (error instanceof HttpException) {
      throw error;
    }

    const code = this.getErrorCode(error);
    if (code === 'EEXIST') {
      throw new ConflictException(`Path already exists: ${targetPath}`);
    }
    if (code === 'ENOENT') {
      throw new NotFoundException(`Path not found: ${targetPath}`);
    }
    if (code === 'ENOTEMPTY') {
      throw new BadRequestException('Directory is not empty');
    }
    if (code === 'EXDEV') {
      throw new BadRequestException(
        'Cannot move across devices; copy/delete fallback is not supported',
      );
    }

    const message =
      error instanceof Error ? error.message : 'File operation failed';
    throw new BadRequestException(message);
  }

  /** Extracts Node-style error codes without weakening type safety. */
  private getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return undefined;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  /** Checks if a resolved path is under an allowed workspace root. */
  private isAllowedPath(resolved: string): boolean {
    return [...this.workspaceRoots].some((root) =>
      this.isPathInside(resolved, root),
    );
  }

  /** Checks if a path is the root itself or a descendant of it. */
  private isPathInside(targetPath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, targetPath);
    return (
      relative === '' ||
      (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    );
  }
}
