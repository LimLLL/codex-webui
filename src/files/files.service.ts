/**
 * File system operations with workspace root security enforcement.
 * All paths are resolved to real paths and validated against allowed workspace roots.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Maximum file size for text reading (5 MB). */
const MAX_READ_SIZE = 5 * 1024 * 1024;

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

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly workspaceRoots = new Set<string>();

  constructor(private readonly config: ConfigService) {
    const roots = this.config.get<string>('WORKSPACE_ROOTS') ?? '';
    for (const root of roots
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)) {
      this.workspaceRoots.add(this.resolveExistingDirectorySync(root));
    }

    // Home directory is always an allowed root
    const home = fsSync.realpathSync(os.homedir());
    this.workspaceRoots.add(home);
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
      this.workspaceRoots.add(resolved);
      this.logger.log(`Registered workspace root: ${resolved}`);
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
   * Deletes a file, symlink, or empty directory.
   * For symlinks, removes the link itself (not the target).
   *
   * @param targetPath - Path to delete
   */
  async deletePath(targetPath: string): Promise<void> {
    // Validate the parent directory is within workspace roots
    const parentDir = path.dirname(path.resolve(targetPath));
    const resolvedParent = await this.resolveSafePath(parentDir);
    const entryPath = path.join(resolvedParent, path.basename(targetPath));

    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(entryPath);
    } catch {
      throw new NotFoundException(`Path not found: ${targetPath}`);
    }

    if (stat.isSymbolicLink()) {
      await fs.unlink(entryPath);
    } else if (stat.isDirectory()) {
      await fs.rmdir(entryPath);
    } else {
      await fs.unlink(entryPath);
    }
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

  /** Checks if a resolved path is under an allowed workspace root. */
  private isAllowedPath(resolved: string): boolean {
    return [...this.workspaceRoots].some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
  }
}
