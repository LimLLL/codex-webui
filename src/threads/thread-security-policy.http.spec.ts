/** Exercises the public acknowledgement and schema through the Nest HTTP boundary. */
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CodexService } from '../codex/codex.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';
import { ThreadSecurityPolicyController } from './thread-security-policy.controller';

describe('security policy HTTP contract', () => {
  let app: NestFastifyApplication;
  const codex = { request: vi.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ThreadSecurityPolicyController],
      providers: [
        { provide: CodexService, useValue: codex },
        {
          provide: ThreadSettingsObserverService,
          useValue: { readSecurityPolicy: vi.fn() },
        },
        {
          provide: ThreadDeletionRegistryService,
          useValue: { assertMutable: vi.fn() },
        },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    codex.request
      .mockReset()
      .mockImplementation((method: string) =>
        Promise.resolve(
          method === 'thread/read'
            ? { thread: { status: { type: 'idle' } } }
            : {},
        ),
      );
  });

  it('returns 202 acknowledgement without invented effective values and rejects typos', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/security-policy',
      payload: { approvalPolicy: 'never' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'accepted' });
    const calls = codex.request.mock.calls.length;
    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/security-policy',
      payload: { approvalPolcy: 'never' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(codex.request).toHaveBeenCalledTimes(calls);
  });

  it('advertises the queued response and the exact pinned sandbox leaves for SDK generation', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('policy').setVersion('test').build(),
    );
    expect(
      document.paths['/api/threads/{threadId}/security-policy'].patch
        ?.responses,
    ).toHaveProperty('202');
    const readOnly = document.components?.schemas?.SandboxReadOnlyDto;
    expect(
      readOnly && 'properties' in readOnly
        ? Object.keys(readOnly.properties ?? {})
        : [],
    ).toEqual(['type', 'networkAccess']);
    const workspaceWrite =
      document.components?.schemas?.SandboxWorkspaceWriteDto;
    expect(
      workspaceWrite && 'properties' in workspaceWrite
        ? Object.keys(workspaceWrite.properties ?? {})
        : [],
    ).toEqual([
      'type',
      'writableRoots',
      'networkAccess',
      'excludeTmpdirEnvVar',
      'excludeSlashTmp',
    ]);
  });
});
