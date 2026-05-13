import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { LoggerModule } from 'nestjs-pino';
import { join } from 'node:path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ApiKeyGuard } from './auth/api-key.guard';
import { AuthModule } from './auth/auth.module';
import { CodexModule } from './codex/codex.module';
import { DatabaseModule } from './database/database.module';
import { FilesModule } from './files/files.module';
import { LogsModule } from './logs/logs.module';
import { ModelsModule } from './models/models.module';
import { TerminalModule } from './terminal/terminal.module';
import { ThreadsModule } from './threads/threads.module';
import { TokenUsageModule } from './token-usage/token-usage.module';

const isDev = process.env.NODE_ENV !== 'production';

const rollTarget = {
  target: 'pino-roll',
  options: {
    file: join(process.cwd(), 'logs', 'app'),
    size: '10m',
    mkdir: true,
    limit: { count: 5 },
  },
};

const PINO_REDACT = {
  paths: [
    'req.headers["authorization"]',
    'req.headers["cookie"]',
    'res.headers["set-cookie"]',
    'token',
    'accessToken',
    'apiKey',
    'password',
    '*.token',
    '*.accessToken',
    '*.apiKey',
    '*.password',
  ],
  censor: '[Redacted]',
};

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
        transport: isDev
          ? {
              targets: [
                { ...rollTarget, level: 'trace' },
                {
                  target: 'pino/file',
                  options: { destination: 1 },
                  level: 'trace',
                },
              ],
            }
          : rollTarget,
        redact: PINO_REDACT,
      },
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/api/(.*)'],
    }),
    AuthModule,
    DatabaseModule,
    CodexModule,
    FilesModule,
    TerminalModule,
    ThreadsModule,
    TokenUsageModule,
    ModelsModule,
    LogsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
})
export class AppModule {}
