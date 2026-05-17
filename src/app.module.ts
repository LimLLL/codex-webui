import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { LoggerModule } from 'nestjs-pino';
import { join } from 'node:path';
import { AccountModule } from './account/account.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ApiKeyGuard } from './auth/api-key.guard';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { CodexModule } from './codex/codex.module';
import { DatabaseModule } from './database/database.module';
import { FilesModule } from './files/files.module';
import { LogsModule } from './logs/logs.module';
import { McpServersModule } from './mcp-servers/mcp-servers.module';
import { ModelsModule } from './models/models.module';
import { PendingApprovalsModule } from './pending-approvals/pending-approvals.module';
import { SettingsModule } from './settings/settings.module';
import { SkillsModule } from './skills/skills.module';
import { TerminalModule } from './terminal/terminal.module';
import { ThreadsModule } from './threads/threads.module';
import { TokenUsageModule } from './token-usage/token-usage.module';
import { TurnDiffModule } from './turn-diff/turn-diff.module';

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

/** Strips access_token query param from URL strings to prevent JWT leakage in logs. */
function sanitizeUrl(url: string): string {
  return url.replace(/([?&])access_token=[^&]*/g, '$1access_token=[Redacted]');
}

const PINO_REDACT = {
  paths: [
    'req.headers["authorization"]',
    'req.headers["cookie"]',
    // File preview URLs may carry RFC 6750 query tokens
    'req.query.access_token',
    'req.query["access_token"]',
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
        serializers: {
          req(req: { url?: string; [k: string]: unknown }) {
            // pino-http default serializer fields + sanitized URL
            return {
              id: req.id,
              method: req.method,
              url: typeof req.url === 'string' ? sanitizeUrl(req.url) : req.url,
              query: req.query,
              params: req.params,
              headers: req.headers,
              remoteAddress: req.remoteAddress,
              remotePort: req.remotePort,
            };
          },
        },
      },
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/api/(.*)'],
      serveStaticOptions: {
        fallthrough: true,
      },
    }),
    AuthModule,
    ChatModule,
    DatabaseModule,
    CodexModule,
    AccountModule,
    FilesModule,
    SettingsModule,
    SkillsModule,
    TerminalModule,
    ThreadsModule,
    PendingApprovalsModule,
    TokenUsageModule,
    TurnDiffModule,
    ModelsModule,
    LogsModule,
    McpServersModule,
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
