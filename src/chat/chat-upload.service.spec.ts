/** Unit tests for chat attachment upload staging and path validation. */
import { ConfigService } from '@nestjs/config';
import { BusinessException } from '../common/business.exception';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { SettingsService } from '../settings/settings.service';
import { ChatUploadService } from './chat-upload.service';

/** Creates a readable stream matching the multipart upload shape used by the service. */
function streamFromText(text: string): Readable & { truncated?: boolean } {
  return Readable.from([text]);
}

describe('ChatUploadService', () => {
  let tempCodexHome: string;
  let service: ChatUploadService;

  beforeEach(async () => {
    tempCodexHome = await fs.mkdtemp(
      path.join(os.tmpdir(), 'codex-webui-chat-'),
    );
    const configService = {
      get: vi.fn((key: string) =>
        key === 'CODEX_HOME' ? tempCodexHome : undefined,
      ),
    } as unknown as ConfigService;
    const settingsService = {
      getNumberSetting: vi.fn(() => 1024 * 1024),
    } as unknown as SettingsService;
    service = new ChatUploadService(configService, settingsService);
  });

  afterEach(async () => {
    await fs.rm(tempCodexHome, { recursive: true, force: true });
  });

  it('stores an upload under CODEX_HOME/webui-uploads with a generated filename', async () => {
    const result = await service.saveUploadedFile({
      filename: 'note.txt',
      mimeType: 'text/plain',
      stream: streamFromText('hello'),
    });

    expect(result.mimeType).toBe('text/plain');
    expect(result.size).toBe(5);
    const resolvedTempCodexHome = await fs.realpath(tempCodexHome);
    expect(path.dirname(result.path)).toBe(
      path.join(resolvedTempCodexHome, 'webui-uploads'),
    );
    expect(path.basename(result.path)).toMatch(/^[0-9a-f-]{36}\.txt$/);
    await expect(fs.readFile(result.path, 'utf8')).resolves.toBe('hello');
  });

  it('resolves only paths inside the upload root', async () => {
    const result = await service.saveUploadedFile({
      filename: 'image.png',
      stream: streamFromText('image-bytes'),
    });

    await expect(service.resolveStoredUploadPath(result.path)).resolves.toBe(
      result.path,
    );
  });

  it('rejects local image paths outside the upload root', async () => {
    const outsidePath = path.join(tempCodexHome, 'outside.png');
    await fs.writeFile(outsidePath, 'outside');

    await expect(
      service.resolveStoredUploadPath(outsidePath),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects filenames with path traversal separators', async () => {
    await expect(
      service.saveUploadedFile({
        filename: '../evil.png',
        stream: streamFromText('evil'),
      }),
    ).rejects.toBeInstanceOf(BusinessException);
  });
});
