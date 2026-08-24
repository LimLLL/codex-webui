import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { normalizeForwardedPrefix, renderIndexHtml } from './public-base-path';
import { FILES_SETTING_KEYS } from './settings/settings.definitions';
import { SettingsService } from './settings/settings.service';

/** Keeps generated SDK operation names stable across controller renames. */
function operationIdFactory(controllerKey: string, methodKey: string): string {
  const controller = controllerKey.replace(/Controller$/, '');
  return `${controller.charAt(0).toLowerCase()}${controller.slice(1)}_${methodKey}`;
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );

  const settingsService = app.get(SettingsService);
  const uploadMaxBytes = settingsService.getNumberSetting(
    FILES_SETTING_KEYS.uploadMaxBytes,
  );

  await app.register(multipart, {
    // Folder uploads send webkitRelativePath as the multipart filename.
    // Keep that relative path so FilesService can validate and recreate it.
    preservePath: true,
    limits: {
      fileSize: uploadMaxBytes,
    },
  });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useWebSocketAdapter(new IoAdapter(app));
  app.setGlobalPrefix('api', { exclude: ['/'] });

  // `public/` is a gitignored build artifact, so it is absent on a fresh clone
  // and during any backend-only dev loop. A missing SPA must not stop the
  // server: there is simply no HTML to rewrite.
  const indexHtml = await readFile(
    join(__dirname, '..', 'public', 'index.html'),
    'utf8',
  ).catch(() => null);

  if (indexHtml === null) {
    logger.warn(
      'public/index.html not found — serving API only. Run `cd web && pnpm build` to build the SPA.',
    );
  } else {
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onSend', async (request, reply, payload) => {
        const contentType = String(reply.getHeader('content-type') ?? '');
        if (
          request.method !== 'GET' ||
          request.url.startsWith('/api') ||
          !contentType.startsWith('text/html')
        ) {
          return payload;
        }

        if (payload instanceof Readable) payload.destroy();
        reply.removeHeader('content-length');
        const basePath = normalizeForwardedPrefix(
          request.headers['x-forwarded-prefix'],
        );
        return renderIndexHtml(indexHtml, basePath);
      });
  }

  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Codex WebUI')
      .setDescription('Codex WebUI API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig, {
      operationIdFactory,
    });
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(process.env.PORT ?? 8172, '0.0.0.0');
}
void bootstrap();
