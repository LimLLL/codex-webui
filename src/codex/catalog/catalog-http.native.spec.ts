/** HTTP repair, activation and model-list contracts with an isolated real child and no model inference. */
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { CodexModule } from '../codex.module';
import { ModelsModule } from '../../models/models.module';
import { AuthModule } from '../../auth/auth.module';
import { ApiKeyGuard } from '../../auth/api-key.guard';
import { AllExceptionsFilter } from '../../common/all-exceptions.filter';
import { CodexProcessManager } from '../codex-process-manager.service';
import { catalogFixture } from './catalog.testing';
import { writeAtomic } from './catalog-files';
import type {
  CatalogDocumentDto,
  CatalogStateDto,
  CatalogBlockersDto,
} from './catalog.dto';

it('serves authenticated repair after startup failure and applies/restores a full catalog over HTTP', async () => {
  const fixture = catalogFixture();
  const broken = fixture.storage.candidatePath();
  writeAtomic(broken, '{invalid');
  fixture.storage.switchPointer(null, broken);
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      AuthModule,
      CodexModule,
      ModelsModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
  })
    .overrideProvider(ConfigService)
    .useValue(
      new ConfigService({
        WEBUI_API_KEY: 'catalog-http-test',
        CODEX_HOME: fixture.home,
        CODEX_BIN: fixture.paths.binary,
      }),
    )
    .compile();
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ bodyLimit: 18 * 1024 * 1024 }),
    { logger: false },
  );
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const headers = { authorization: 'Bearer catalog-http-test' };
    const server = app.getHttpAdapter().getInstance();
    expect(
      (await server.inject({ method: 'GET', url: '/api/codex/config/raw' }))
        .statusCode,
    ).toBe(401);
    const raw = await server.inject({
      method: 'GET',
      url: '/api/codex/config/raw',
      headers,
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.json<{ content: string }>().content).toContain(broken);
    const repaired = await server.inject({
      method: 'PUT',
      url: '/api/codex/config/raw',
      headers,
      payload: { content: '', expectedContent: fixture.storage.config() },
    });
    expect(repaired.statusCode).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/codex/catalog/restart',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    const seed = await server.inject({
      method: 'POST',
      url: '/api/codex/catalog/seed',
      headers,
      payload: { source: 'bundled', expectedDraft: null },
    });
    expect(seed.statusCode).toBe(200);
    const { content } = seed.json<CatalogDocumentDto>();
    expect(content).toBeTruthy();
    const applied = await server.inject({
      method: 'POST',
      url: '/api/codex/catalog/apply',
      headers,
      payload: { expectedDraft: content, expectedPointer: null },
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const state = applied.json<CatalogStateDto>();
    expect(state.activation?.outcome).toBe('accepted');
    const models = await server.inject({
      method: 'GET',
      url: '/api/models?includeHidden=true',
      headers,
    });
    expect(models.statusCode).toBe(200);
    expect(
      models
        .json<{ data: { hidden: boolean }[] }>()
        .data.some((model) => model.hidden),
    ).toBe(true);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/models?includeHidden=invalid',
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const blockers = (
      await server.inject({
        method: 'GET',
        url: '/api/codex/catalog/blockers',
        headers,
      })
    ).json<CatalogBlockersDto>();
    expect(blockers.scope).toBe('managedAppServer');
    expect(blockers.limitations[0]).toContain('External clients');
    const restored = await server.inject({
      method: 'POST',
      url: '/api/codex/catalog/restore',
      headers,
      payload: { expectedPointer: state.configuredPointer },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json<CatalogStateDto>().configuredPointer).toBeNull();
  } finally {
    const manager = app.get(CodexProcessManager);
    const client = manager.getClient();
    const closed = client
      ? new Promise<void>((done) => client.once('close', () => done()))
      : Promise.resolve();
    await app.close();
    await closed;
    fixture.cleanup();
  }
}, 30_000);
