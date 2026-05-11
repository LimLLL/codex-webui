import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FilesService } from './files.service';

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
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'WORKSPACE_ROOTS' ? tmpDir : undefined,
          },
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
