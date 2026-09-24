import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../common/error-codes';
import { ArchiveService } from './archive.service';
import type { ArchiveAdapter, ArchiveEntry } from './archive.types';

function service(
  entries: ArchiveEntry[],
  stream = '0123456789',
  resolvedPath = '/workspace/archive.zip',
  metadataType: 'file' | 'directory' = 'file',
) {
  const adapter: ArchiveAdapter = {
    label: 'fake-zip',
    supports: (path) => path.endsWith('.zip'),
    list: vi.fn(() => Promise.resolve(entries)),
    openEntryStream: vi.fn(() => Promise.resolve(Readable.from([stream]))),
  };
  const files = {
    resolveSafePath: vi.fn(() => Promise.resolve(resolvedPath)),
    getMetadata: vi.fn(() => Promise.resolve({ type: metadataType })),
  };
  const unsupported: ArchiveAdapter = {
    label: 'unsupported',
    supports: () => false,
    list: vi.fn(() => Promise.resolve([])),
    openEntryStream: vi.fn(() => Promise.resolve(Readable.from([]))),
  };
  return new ArchiveService(
    files as never,
    adapter as never,
    unsupported as never,
    unsupported as never,
    unsupported as never,
  );
}

describe('ArchiveService', () => {
  it('builds a sorted directory tree and opens a safe entry', async () => {
    const archive = service([
      { name: 'z.txt', path: 'z.txt', type: 'file', size: 2 },
      { name: 'b.txt', path: 'dir/b.txt', type: 'file', size: 2 },
      { name: 'a.txt', path: 'dir/a.txt', type: 'file', size: 2 },
    ]);
    const listed = await archive.listArchive('/workspace/archive.zip');
    expect(listed.entries).toEqual([
      {
        name: 'dir',
        path: 'dir',
        type: 'directory',
        children: [
          { name: 'a.txt', path: 'dir/a.txt', type: 'file', size: 2 },
          { name: 'b.txt', path: 'dir/b.txt', type: 'file', size: 2 },
        ],
      },
      { name: 'z.txt', path: 'z.txt', type: 'file', size: 2 },
    ]);

    const opened = await archive.openEntry('/workspace/archive.zip', 'z.txt');
    expect(opened.filename).toBe('z.txt');
    expect(opened.size).toBe(2);
    const chunks: Buffer[] = [];
    for await (const chunk of await opened.openStream({ start: 1, end: 2 })) {
      chunks.push(Buffer.from(chunk as unknown as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString()).toBe('12');
  });

  it('rejects unsafe, encrypted, unsupported and oversized entries', async () => {
    await expect(
      service([
        { name: '../x', path: '../x', type: 'file', size: 1 },
      ]).listArchive('/workspace/archive.zip'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.archive.unsafeEntryPath });
    await expect(
      service([
        {
          name: 'secret',
          path: 'secret',
          type: 'file',
          size: 1,
          encrypted: true,
        },
      ]).openEntry('/workspace/archive.zip', 'secret'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.archive.entryEncrypted });
    await expect(
      service([
        { name: 'big', path: 'big', type: 'file', size: 50 * 1024 * 1024 + 1 },
      ]).openEntry('/workspace/archive.zip', 'big'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.archive.entryTooLarge });
    await expect(
      service([]).openEntry('/workspace/archive.zip', '../secret'),
    ).rejects.toMatchObject({ errorCode: ErrorCode.archive.invalidEntryPath });
  });

  it('rejects directories and unsupported archive formats', async () => {
    await expect(
      service([], '0123', '/workspace/archive.zip', 'directory').listArchive(
        '/workspace/archive.zip',
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.archive.pathNotFile });
    await expect(
      service([], '0123', '/workspace/archive.tar').listArchive(
        '/workspace/archive.tar',
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.archive.unsupportedFormat });
  });
});

it.each([
  [
    { name: 'x', path: 'x', type: 'directory' as const },
    ErrorCode.archive.entryNotFile,
  ],
  [
    { name: 'x', path: 'x', type: 'file' as const },
    ErrorCode.archive.entrySizeUnknown,
  ],
  [
    { name: 'x', path: 'x', type: 'file' as const, size: 1, unsupported: true },
    ErrorCode.archive.entryUnsupported,
  ],
])(
  'refuses entries that cannot be safely streamed',
  async (entry, errorCode) => {
    await expect(
      service([entry]).openEntry('/workspace/archive.zip', 'x'),
    ).rejects.toMatchObject({ errorCode });
  },
);

it('enforces both archive-wide entry-count and decompressed-size budgets', async () => {
  const entry: ArchiveEntry = { name: 'x', path: 'x', type: 'file', size: 1 };
  await expect(
    service(Array.from({ length: 20001 }, () => entry)).listArchive(
      '/workspace/archive.zip',
    ),
  ).rejects.toMatchObject({ errorCode: ErrorCode.archive.tooManyEntries });
  await expect(
    service([{ ...entry, size: 1024 * 1024 * 1024 + 1 }]).listArchive(
      '/workspace/archive.zip',
    ),
  ).rejects.toMatchObject({ errorCode: ErrorCode.archive.totalSizeTooLarge });
});
