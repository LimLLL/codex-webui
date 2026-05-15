import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
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

  app.useLogger(app.get(Logger));
  app.useWebSocketAdapter(new IoAdapter(app));
  app.setGlobalPrefix('api', { exclude: ['/'] });

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
