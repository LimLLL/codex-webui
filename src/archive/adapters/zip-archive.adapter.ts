/** ZIP archive adapter using yauzl lazy entry iteration and safe file-name validation. */
import { Injectable } from '@nestjs/common';
import { BusinessException } from '../../common/business.exception';
import { ErrorCode } from '../../common/error-codes';
import * as yauzl from 'yauzl';
import { PassThrough, type Readable } from 'node:stream';
import { archiveEntryName, normalizeArchiveEntryPath } from '../archive-path';
import type { ArchiveAdapter, ArchiveEntry } from '../archive.types';

@Injectable()
export class ZipArchiveAdapter implements ArchiveAdapter {
  readonly label = 'zip';

  /** Returns true for ZIP archives. */
  supports(archivePath: string): boolean {
    return archivePath.toLowerCase().endsWith('.zip');
  }

  /** Lists ZIP entries without extracting file contents. */
  async list(archivePath: string): Promise<ArchiveEntry[]> {
    const zipfile = await this.openZip(archivePath);
    return new Promise<ArchiveEntry[]>((resolve, reject) => {
      const entries: ArchiveEntry[] = [];
      const fail = (error: Error) => {
        zipfile.close();
        reject(error);
      };

      zipfile.on('entry', (raw: yauzl.Entry) => {
        const validationError = yauzl.validateFileName(raw.fileName);
        if (validationError) {
          fail(
            BusinessException.badRequest(
              ErrorCode.archive.unsafeEntryPath,
              `Unsafe ZIP entry: ${validationError}`,
            ),
          );
          return;
        }

        const normalized = normalizeArchiveEntryPath(raw.fileName);
        if (!normalized) {
          fail(
            BusinessException.badRequest(
              ErrorCode.archive.unsafeEntryPath,
              'Unsafe ZIP entry path',
            ),
          );
          return;
        }

        const isDirectory = raw.fileName.endsWith('/');
        entries.push({
          name: archiveEntryName(normalized),
          path: normalized,
          type: isDirectory ? 'directory' : 'file',
          size: isDirectory ? undefined : raw.uncompressedSize,
          compressedSize: raw.compressedSize,
          encrypted: (raw.generalPurposeBitFlag & 0x1) === 0x1,
        });
        zipfile.readEntry();
      });
      zipfile.once('error', fail);
      zipfile.once('end', () => {
        zipfile.close();
        resolve(entries);
      });
      zipfile.readEntry();
    });
  }

  /** Opens one ZIP entry stream by normalized archive path. */
  async openEntryStream(
    archivePath: string,
    entryPath: string,
  ): Promise<Readable> {
    const zipfile = await this.openZip(archivePath);
    return new Promise<Readable>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(error);
      };

      zipfile.on('entry', (raw: yauzl.Entry) => {
        const normalized = normalizeArchiveEntryPath(raw.fileName);
        if (normalized !== entryPath) {
          zipfile.readEntry();
          return;
        }
        if (raw.fileName.endsWith('/')) {
          fail(
            BusinessException.badRequest(
              ErrorCode.archive.entryNotFile,
              'ZIP entry is a directory',
            ),
          );
          return;
        }
        if ((raw.generalPurposeBitFlag & 0x1) === 0x1) {
          fail(
            BusinessException.badRequest(
              ErrorCode.archive.entryEncrypted,
              'Encrypted files are not supported',
            ),
          );
          return;
        }

        zipfile.openReadStream(raw, (error, stream) => {
          if (error || !stream) {
            fail(
              error ??
                BusinessException.badRequest(
                  ErrorCode.archive.entryUnsupported,
                  'Unable to read ZIP entry',
                ),
            );
            return;
          }
          settled = true;
          // yauzl 3.3.0 stored-entry streams stall under async iteration
          // (upstream #169). A standard Node stream also gives Range consumers
          // a reliable early-close boundary without changing dependencies.
          const output = new PassThrough();
          output.once('close', () => {
            stream.destroy();
            zipfile.close();
          });
          stream.once('error', (error) => output.destroy(error));
          stream.once('end', () => zipfile.close());
          stream.pipe(output);
          resolve(output);
        });
      });
      zipfile.once('error', fail);
      zipfile.once('end', () => {
        if (!settled)
          fail(
            BusinessException.notFound(
              ErrorCode.archive.entryNotFound,
              'ZIP entry not found',
            ),
          );
      });
      zipfile.readEntry();
    });
  }

  /** Opens a ZIP file with lazy entry reading to avoid loading the directory at once. */
  private openZip(archivePath: string): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => {
      yauzl.open(
        archivePath,
        { lazyEntries: true, autoClose: false, validateEntrySizes: true },
        (error, zipfile) => {
          if (error || !zipfile)
            reject(
              error ??
                BusinessException.badRequest(
                  ErrorCode.archive.unsupportedFormat,
                  'Unable to open ZIP archive',
                ),
            );
          else resolve(zipfile);
        },
      );
    });
  }
}
