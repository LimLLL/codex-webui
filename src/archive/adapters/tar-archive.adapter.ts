/** TAR family adapter using tar-stream and streaming decompression. */
import { Injectable } from '@nestjs/common';
import { BusinessException } from '../../common/business.exception';
import { ErrorCode } from '../../common/error-codes';
import * as fsSync from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { PassThrough, type Readable } from 'node:stream';
import tar from 'tar-stream';
import { archiveEntryName, normalizeArchiveEntryPath } from '../archive-path';
import type { ArchiveAdapter, ArchiveEntry } from '../archive.types';

@Injectable()
export class TarArchiveAdapter implements ArchiveAdapter {
  readonly label = 'tar';
  private sevenZaChecked = false;
  private sevenZaAvailable = false;

  /** Returns true for TAR, TAR.GZ, TAR.BZ2, and TAR.XZ archives. */
  supports(archivePath: string): boolean {
    return /\.(tar|tgz|tar\.gz|tbz2|tar\.bz2|txz|tar\.xz)$/i.test(archivePath);
  }

  /** Lists TAR entries sequentially without writing extracted files to disk. */
  async list(archivePath: string): Promise<ArchiveEntry[]> {
    const extract = tar.extract();
    const body = this.createTarBodyStream(archivePath);
    body.once('error', (error) => extract.destroy(error));
    body.pipe(extract);
    const entries: ArchiveEntry[] = [];

    for await (const entry of extract) {
      const normalized = normalizeArchiveEntryPath(entry.header.name);
      if (!normalized) {
        throw BusinessException.badRequest(
          ErrorCode.archive.unsafeEntryPath,
          'Unsafe TAR entry path',
        );
      }
      const isDirectory = entry.header.type === 'directory';
      const unsupported = !isDirectory && entry.header.type !== 'file';
      entries.push({
        name: archiveEntryName(normalized),
        path: normalized,
        type: isDirectory ? 'directory' : 'file',
        size: isDirectory ? undefined : entry.header.size,
        mtime: entry.header.mtime?.getTime(),
        unsupported,
      });
      entry.resume();
    }

    return entries;
  }

  /** Opens one TAR entry stream by normalized archive path. */
  async openEntryStream(
    archivePath: string,
    entryPath: string,
  ): Promise<Readable> {
    const extract = tar.extract();
    const output = new PassThrough();
    let body: Readable | null = null;
    let activeEntryStream: Readable | null = null;
    let found = false;
    let settled = false;

    // Clean up the entire pipeline when output closes early (e.g. Range slice abort)
    const cleanupPipeline = () => {
      activeEntryStream?.destroy();
      extract.destroy();
      body?.destroy();
    };
    output.once('close', cleanupPipeline);

    const promise = new Promise<Readable>((resolve, reject) => {
      extract.on('entry', (header, stream, next) => {
        const normalized = normalizeArchiveEntryPath(header.name);
        if (normalized !== entryPath) {
          stream.on('end', next);
          stream.resume();
          return;
        }

        if (header.type !== 'file') {
          reject(
            BusinessException.badRequest(
              ErrorCode.archive.entryNotFile,
              'TAR entry is not a regular file',
            ),
          );
          stream.resume();
          return;
        }

        found = true;
        settled = true;
        activeEntryStream = stream as unknown as Readable;
        stream.on('end', next);
        stream.on('error', (error) => output.destroy(error));
        stream.pipe(output);
        resolve(output);
      });
      extract.once('finish', () => {
        if (!found && !settled)
          reject(
            BusinessException.notFound(
              ErrorCode.archive.entryNotFound,
              'TAR entry not found',
            ),
          );
      });
      extract.once('error', reject);
    });

    body = this.createTarBodyStream(archivePath);
    body.once('error', (error) => extract.destroy(error));
    body.pipe(extract);
    return promise;
  }

  /** Creates the raw TAR body stream, using host 7za for BZ2/XZ wrappers. */
  private createTarBodyStream(archivePath: string): Readable {
    const lower = archivePath.toLowerCase();
    if (
      lower.endsWith('.tar') ||
      lower.endsWith('.tar.gz') ||
      lower.endsWith('.tgz')
    ) {
      const stream = fsSync.createReadStream(archivePath);
      return lower.endsWith('.tar') ? stream : stream.pipe(createGunzip());
    }

    this.assert7zaAvailable();
    // -spd disables wildcard matching for safety
    const child = spawn('7za', ['x', '-so', '-spd', '--', archivePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childDone = false;
    child.stderr.resume();
    child.stdout.once('end', () => {
      childDone = true;
    });
    child.stdout.once('close', () => {
      if (!childDone && !child.killed) child.kill();
    });
    child.on('error', (error) => child.stdout.destroy(error));
    child.on('close', (code) => {
      childDone = true;
      if (code !== 0) {
        child.stdout.destroy(
          BusinessException.badRequest(
            ErrorCode.archive.unsupportedFormat,
            'Unable to decompress TAR archive',
          ),
        );
      }
    });
    return child.stdout;
  }

  /** Fails fast with a clear message when host 7za is not installed (cached after first check). */
  private assert7zaAvailable(): void {
    if (this.sevenZaChecked) {
      if (!this.sevenZaAvailable) {
        throw BusinessException.badRequest(
          ErrorCode.archive.sevenZipUnavailable,
          '7za binary is not available on the host',
        );
      }
      return;
    }
    const result = spawnSync('7za', ['i'], { stdio: 'ignore' });
    this.sevenZaChecked = true;
    this.sevenZaAvailable = !result.error && result.status === 0;
    if (!this.sevenZaAvailable) {
      throw BusinessException.badRequest(
        ErrorCode.archive.sevenZipUnavailable,
        '7za binary is not available on the host',
      );
    }
  }
}
