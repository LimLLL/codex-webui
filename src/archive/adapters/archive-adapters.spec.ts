/** Real ZIP and TAR adapters read fixtures without extracting to disk. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import { ZipArchiveAdapter } from './zip-archive.adapter';
import { TarArchiveAdapter } from './tar-archive.adapter';

/** Consumes a real stream with no reliance on its chunk boundaries. */
async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
}

it('lists and streams a ZIP entry without materializing its directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-zip-'));
  const path = join(root, 'test.zip');
  try {
    await writeFile(
      path,
      Buffer.from(
        'UEsDBBQAAAAAAFV3OF1qUpXmDwAAAA8AAAANAAAAZGlyL2hlbGxvLnR4dGFyY2hpdmUgY29udGVudFBLAQIUAxQAAAAAAFV3OF1qUpXmDwAAAA8AAAANAAAAAAAAAAAAAACAAQAAAABkaXIvaGVsbG8udHh0UEsFBgAAAAABAAEAOwAAADoAAAAAAA==',
        'base64',
      ),
    );
    const adapter = new ZipArchiveAdapter();
    expect(await adapter.list(path)).toContainEqual(
      expect.objectContaining({
        path: 'dir/hello.txt',
        size: 15,
        type: 'file',
      }),
    );
    expect(
      await text(await adapter.openEntryStream(path, 'dir/hello.txt')),
    ).toBe('archive content');
    expect(await readdir(root)).toEqual(['test.zip']);
    await expect(adapter.openEntryStream(path, 'absent')).rejects.toMatchObject(
      { errorCode: 'archive.entry_not_found' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('lists real TAR members, flags links as unsupported, and streams only the named file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-tar-'));
  const path = join(root, 'test.tar');
  try {
    const pack = tar.pack();
    pack.entry({ name: 'dir/hello.txt', type: 'file' }, 'archive content');
    pack.entry({ name: 'link', type: 'symlink', linkname: '/etc/passwd' });
    pack.finalize();
    await pipeline(pack, createWriteStream(path));
    const adapter = new TarArchiveAdapter();
    expect(await adapter.list(path)).toContainEqual(
      expect.objectContaining({ path: 'link', unsupported: true }),
    );
    expect(
      await text(await adapter.openEntryStream(path, 'dir/hello.txt')),
    ).toBe('archive content');
    expect((await readFile(path)).length).toBeGreaterThan(0);
    expect(await readdir(root)).toEqual(['test.tar']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
