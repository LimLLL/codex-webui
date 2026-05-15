import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { SECURITY_SETTING_KEYS } from '../settings/settings.definitions';
import { SettingsService } from '../settings/settings.service';
import { FilesService, type FileUploadInput } from './files.service';

describe('FilesService', () => {
  let service: FilesService;
  let tmpDir: string;

  beforeAll(async () => {
    const rawTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'files-test-'));
    // Resolve symlinks (macOS /tmp → /private/tmp) so realpath checks pass
    tmpDir = await fs.realpath(rawTmp);

    // Create test file structure
    await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'Hello world');
    await fs.mkdir(path.join(tmpDir, 'subdir'));
    await fs.writeFile(path.join(tmpDir, 'subdir', 'nested.ts'), 'export {}');
    await fs.mkdir(path.join(tmpDir, 'node_modules'));
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.js'), '');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        FilesService,
        {
          provide: SettingsService,
          useValue: {
            getStringSetting: (key: string) =>
              key === SECURITY_SETTING_KEYS.workspaceRoots ? tmpDir : null,
            onChange: () => () => {},
          } satisfies Partial<SettingsService>,
        },
      ],
    }).compile();

    service = module.get(FilesService);
  });

  describe('resolveSafePath', () => {
    it('should resolve valid path within workspace root', async () => {
      const resolved = await service.resolveSafePath(
        path.join(tmpDir, 'hello.txt'),
      );
      expect(resolved).toContain('hello.txt');
    });

    it('should reject path outside workspace root', async () => {
      await expect(service.resolveSafePath('/etc/passwd')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should reject empty path', async () => {
      await expect(service.resolveSafePath('')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject non-existent path', async () => {
      await expect(
        service.resolveSafePath(path.join(tmpDir, 'nope.txt')),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('readDirectory', () => {
    it('should list directory entries', async () => {
      const entries = await service.readDirectory(tmpDir);
      const names = entries.map((e) => e.name);
      expect(names).toContain('hello.txt');
      expect(names).toContain('subdir');
    });

    it('should exclude node_modules', async () => {
      const entries = await service.readDirectory(tmpDir);
      const names = entries.map((e) => e.name);
      expect(names).not.toContain('node_modules');
    });

    it('should sort directories before files', async () => {
      const entries = await service.readDirectory(tmpDir);
      const dirIdx = entries.findIndex((e) => e.name === 'subdir');
      const fileIdx = entries.findIndex((e) => e.name === 'hello.txt');
      expect(dirIdx).toBeLessThan(fileIdx);
    });
  });

  describe('readFile', () => {
    it('should read text file content', async () => {
      const result = await service.readFile(path.join(tmpDir, 'hello.txt'));
      expect(result.content).toBe('Hello world');
      expect(result.size).toBe(11);
    });

    it('should reject directory path', async () => {
      await expect(service.readFile(tmpDir)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('createFile', () => {
    it('should create a new empty file by default', async () => {
      const target = path.join(tmpDir, 'created-empty.txt');
      const result = await service.createFile(target);
      expect(result.path).toBe(target);
      expect(result.mtime).toBeGreaterThan(0);
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('');
    });

    it('should reject existing targets unless overwrite is explicit', async () => {
      await expect(
        service.createFile(path.join(tmpDir, 'hello.txt'), 'replace'),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject targets outside workspace roots', async () => {
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
      const resolvedOutside = await fs.realpath(outsideRoot);
      try {
        await expect(
          service.createFile(path.join(resolvedOutside, 'blocked.txt')),
        ).rejects.toThrow(ForbiddenException);
      } finally {
        await fs.rm(resolvedOutside, { recursive: true, force: true });
      }
    });
  });

  describe('createDirectory', () => {
    it('should create nested directories when recursive is true', async () => {
      const target = path.join(tmpDir, 'recursive-a', 'recursive-b');
      const result = await service.createDirectory(target, true);
      expect(result.path).toBe(target);
      await expect(fs.stat(target)).resolves.toMatchObject({});
    });

    it('should reject existing directories unless overwrite is explicit', async () => {
      await expect(
        service.createDirectory(path.join(tmpDir, 'subdir')),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('writeFile', () => {
    it('should write file content', async () => {
      const target = path.join(tmpDir, 'new-file.txt');
      await fs.writeFile(target, ''); // create first
      const result = await service.writeFile(target, 'new content');
      expect(result.mtime).toBeGreaterThan(0);
      const content = await fs.readFile(target, 'utf-8');
      expect(content).toBe('new content');
    });

    it('should reject write with stale mtime', async () => {
      const target = path.join(tmpDir, 'hello.txt');
      await expect(service.writeFile(target, 'updated', 0)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('renamePath', () => {
    it('should rename an entry within the same parent', async () => {
      const source = path.join(tmpDir, 'rename-source.txt');
      await fs.writeFile(source, 'rename me');

      const result = await service.renamePath(source, 'rename-target.txt');
      expect(result.oldPath).toBe(source);
      expect(result.newPath).toBe(path.join(tmpDir, 'rename-target.txt'));
      await expect(fs.readFile(result.newPath!, 'utf-8')).resolves.toBe(
        'rename me',
      );
    });

    it('should reject path traversal in the new name', async () => {
      await expect(
        service.renamePath(path.join(tmpDir, 'hello.txt'), '../bad.txt'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('copyPath', () => {
    it('should copy directories recursively', async () => {
      const source = path.join(tmpDir, 'copy-source');
      const destination = path.join(tmpDir, 'copy-destination');
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, 'nested.txt'), 'copy data');

      const result = await service.copyPath(source, destination);
      expect(result.sourcePath).toBe(source);
      expect(result.destinationPath).toBe(destination);
      await expect(
        fs.readFile(path.join(destination, 'nested.txt'), 'utf-8'),
      ).resolves.toBe('copy data');
    });

    it('should reject copying a directory into itself', async () => {
      const source = path.join(tmpDir, 'copy-self-source');
      const child = path.join(source, 'child');
      await fs.mkdir(child, { recursive: true });

      await expect(
        service.copyPath(source, path.join(child, 'copy')),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject destinations outside workspace roots', async () => {
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
      const resolvedOutside = await fs.realpath(outsideRoot);
      try {
        await expect(
          service.copyPath(
            path.join(tmpDir, 'hello.txt'),
            path.join(resolvedOutside, 'hello-copy.txt'),
          ),
        ).rejects.toThrow(ForbiddenException);
      } finally {
        await fs.rm(resolvedOutside, { recursive: true, force: true });
      }
    });
  });

  describe('movePath', () => {
    it('should move files within the same device', async () => {
      const source = path.join(tmpDir, 'move-source.txt');
      const destination = path.join(tmpDir, 'move-target.txt');
      await fs.writeFile(source, 'move data');

      const result = await service.movePath(source, destination);
      expect(result.oldPath).toBe(source);
      expect(result.newPath).toBe(destination);
      await expect(fs.readFile(destination, 'utf-8')).resolves.toBe(
        'move data',
      );
      await expect(fs.stat(source)).rejects.toThrow();
    });

    it('should reject moving to an existing target without overwrite', async () => {
      const source = path.join(tmpDir, 'move-conflict-src.txt');
      const destination = path.join(tmpDir, 'hello.txt'); // already exists
      await fs.writeFile(source, 'conflict data');

      await expect(service.movePath(source, destination)).rejects.toThrow(
        ConflictException,
      );
      // Source untouched
      await expect(fs.readFile(source, 'utf-8')).resolves.toBe('conflict data');
    });
  });

  describe('getMetadata', () => {
    it('should return file metadata', async () => {
      const meta = await service.getMetadata(path.join(tmpDir, 'hello.txt'));
      expect(meta.type).toBe('file');
      expect(meta.size).toBe(11);
      expect(meta.permissions).toMatch(/^0\d{3}$/);
    });

    it('should return directory metadata', async () => {
      const meta = await service.getMetadata(tmpDir);
      expect(meta.type).toBe('directory');
    });
  });

  describe('deletePath', () => {
    it('should delete non-empty directories when recursive is true', async () => {
      const target = path.join(tmpDir, 'recursive-delete');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'child.txt'), 'delete me');

      await service.deletePath(target, true);
      await expect(fs.stat(target)).rejects.toThrow();
    });

    it('should reject non-empty directories when recursive is false', async () => {
      const target = path.join(tmpDir, 'non-recursive-delete');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'child.txt'), 'keep me');

      await expect(service.deletePath(target)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should unlink symlinks without deleting their targets', async () => {
      const realFile = path.join(tmpDir, 'symlink-target.txt');
      const linkFile = path.join(tmpDir, 'symlink-link.txt');
      await fs.writeFile(realFile, 'target data');
      await fs.symlink(realFile, linkFile);

      await service.deletePath(linkFile);

      await expect(fs.lstat(linkFile)).rejects.toThrow();
      await expect(fs.readFile(realFile, 'utf-8')).resolves.toBe('target data');
    });
  });

  describe('prepareDownload', () => {
    it('should prepare a safe file stream for download', async () => {
      const result = await service.prepareDownload(
        path.join(tmpDir, 'hello.txt'),
      );
      expect(result.filename).toBe('hello.txt');
      expect(result.size).toBe(11);
      result.stream.destroy();
    });

    it('should reject directories', async () => {
      await expect(service.prepareDownload(tmpDir)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('saveUploadedFiles', () => {
    it('should preserve folder upload hierarchy', async () => {
      const result = await service.saveUploadedFiles(
        tmpDir,
        uploadInputs([
          { relativePath: 'upload-folder/nested.txt', content: 'upload data' },
        ]),
      );

      expect(result.files).toHaveLength(1);
      await expect(
        fs.readFile(path.join(tmpDir, 'upload-folder', 'nested.txt'), 'utf-8'),
      ).resolves.toBe('upload data');
    });

    it('should reject upload path traversal', async () => {
      await expect(
        service.saveUploadedFiles(
          tmpDir,
          uploadInputs([{ relativePath: '../evil.txt', content: 'blocked' }]),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject empty upload path segments', async () => {
      await expect(
        service.saveUploadedFiles(
          tmpDir,
          uploadInputs([{ relativePath: 'bad//file.txt', content: 'blocked' }]),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject overwrite by default', async () => {
      await expect(
        service.saveUploadedFiles(
          tmpDir,
          uploadInputs([{ relativePath: 'hello.txt', content: 'blocked' }]),
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('getWorkspaceRoots', () => {
    it('should return configured roots', () => {
      const roots = service.getWorkspaceRoots();
      expect(roots).toContain(tmpDir);
    });
  });

  describe('addWorkspaceRoot', () => {
    it('should allow access to dynamically added sub-roots', async () => {
      // Dynamic roots must be inside an existing root
      const newRoot = path.join(tmpDir, 'extra-root');
      await fs.mkdir(newRoot);
      const testFile = path.join(newRoot, 'test.txt');
      await fs.writeFile(testFile, 'dynamic');

      // Already accessible since it's under tmpDir
      const result = await service.resolveSafePath(testFile);
      expect(result).toBe(testFile);

      // Registering as explicit root should not throw
      service.addWorkspaceRoot(newRoot);
      expect(service.getWorkspaceRoots()).toContain(newRoot);
    });

    it('should reject adding root outside configured workspace', async () => {
      // Create a real directory outside tmpDir
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'));
      const resolvedOutside = await fs.realpath(outsideRoot);
      try {
        expect(() => service.addWorkspaceRoot(resolvedOutside)).toThrow(
          ForbiddenException,
        );
      } finally {
        await fs.rm(resolvedOutside, { recursive: true, force: true });
      }
    });
  });
});

interface UploadFixture {
  relativePath: string;
  content: string;
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* uploadInputs(
  fixtures: UploadFixture[],
): AsyncIterable<FileUploadInput> {
  for (const fixture of fixtures) {
    yield {
      filename: path.basename(fixture.relativePath),
      relativePath: fixture.relativePath,
      stream: Readable.from([fixture.content]),
    };
  }
}
