/** Real Fastify streaming checks range bytes and preview security headers. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { SettingsService } from '../settings/settings.service';
import {
  FILES_SETTING_KEYS,
  SECURITY_SETTING_KEYS,
} from '../settings/settings.definitions';

it('streams exact byte ranges with hardened headers and returns 416 for invalid ranges', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'file-range-')));
  const file = join(root, 'preview.svg');
  await writeFile(file, '0123456789');
  const settings = {
    getStringSetting: (key: string) =>
      key === SECURITY_SETTING_KEYS.workspaceRoots ? root : null,
    getSetting: (key: string) => ({
      value: key === FILES_SETTING_KEYS.excludedDirs ? '' : null,
    }),
    onChange: () => () => undefined,
  } as unknown as SettingsService;
  const service = new FilesService(settings);
  const controller = new FilesController(service);
  const app = Fastify();
  app.get('/serve', (request, reply) =>
    controller.serveFile(file, request, reply),
  );
  try {
    const response = await app.inject({
      url: '/serve',
      headers: { range: 'bytes=2-5' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe('2345');
    expect(response.headers).toMatchObject({
      'content-range': 'bytes 2-5/10',
      'content-length': '4',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, no-store',
    });
    expect(response.headers['content-security-policy']).toContain(
      "sandbox; default-src 'none'",
    );
    expect(response.headers['content-disposition']).toContain('inline;');
    const invalid = await app.inject({
      url: '/serve',
      headers: { range: 'bytes=99-' },
    });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */10');
    expect((await app.inject('/serve')).body).toBe('0123456789');
  } finally {
    await app.close();
    service.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
  }
});
