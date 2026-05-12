import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { CodexProcessManager } from './codex-process-manager.service';
import { CodexStatusService } from './codex-status.service';
import { CodexService } from './codex.service';
import type { InitializeResponse, v2 } from './codex-schema';

const initResult: InitializeResponse = {
  userAgent: 'codex/0.1.0',
  codexHome: '/home/test/.codex',
  platformFamily: 'unix',
  platformOs: 'linux',
};

function accountResponse(
  overrides: Partial<v2.GetAccountResponse> = {},
): v2.GetAccountResponse {
  return {
    account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
    requiresOpenaiAuth: false,
    ...overrides,
  };
}

function configResponse(
  overrides: Partial<v2.Config> = {},
): v2.ConfigReadResponse {
  return {
    config: {
      model: 'gpt-5',
      review_model: null,
      model_context_window: 128_000n,
      model_auto_compact_token_limit: 64_000n,
      model_provider: 'openai',
      approval_policy: 'on-request',
      approvals_reviewer: null,
      sandbox_mode: 'workspace-write',
      sandbox_workspace_write: null,
      forced_chatgpt_workspace_id: null,
      forced_login_method: null,
      web_search: null,
      tools: null,
      profile: null,
      profiles: {},
      instructions: null,
      developer_instructions: null,
      compact_prompt: null,
      model_reasoning_effort: null,
      model_reasoning_summary: null,
      model_verbosity: null,
      service_tier: null,
      analytics: null,
      ...overrides,
    } as v2.Config,
    origins: {},
    layers: null,
  };
}

function model(overrides: Partial<v2.Model> = {}): v2.Model {
  return {
    id: 'gpt-5',
    model: 'gpt-5',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'GPT-5',
    description: 'Default model',
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    isDefault: true,
    ...overrides,
  };
}

function modelListResponse(
  overrides: Partial<v2.ModelListResponse> = {},
): v2.ModelListResponse {
  return {
    data: [model()],
    nextCursor: null,
    ...overrides,
  };
}

describe('CodexStatusService', () => {
  let service: CodexStatusService;
  let moduleRef: TestingModule;

  const mockClient = { request: jest.fn() };
  const mockProcessManager = {
    getClient: jest.fn(),
    getInitResult: jest.fn(),
  };
  const mockCodex = { request: jest.fn() };
  const mockConfig = { get: jest.fn() };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        CodexStatusService,
        { provide: CodexProcessManager, useValue: mockProcessManager },
        { provide: CodexService, useValue: mockCodex },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = moduleRef.get(CodexStatusService);
    mockProcessManager.getClient.mockReturnValue(mockClient);
    mockProcessManager.getInitResult.mockReturnValue(initResult);
    mockConfig.get.mockImplementation((key: string) =>
      key === 'OPENAI_API_KEY' ? 'sk-test' : undefined,
    );
    mockCodex.request.mockReset();
    mockClient.request.mockReset();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await moduleRef.close();
  });

  function mockSuccessfulProbes(): void {
    mockCodex.request.mockImplementation((method: string) => {
      switch (method) {
        case 'account/read':
          return Promise.resolve(accountResponse());
        case 'config/read':
          return Promise.resolve(configResponse());
        case 'model/list':
          return Promise.resolve(modelListResponse());
        default:
          return Promise.reject(new Error(`Unexpected method: ${method}`));
      }
    });
  }

  it('should return unavailable without probing when app-server client is missing', async () => {
    mockProcessManager.getClient.mockReturnValue(null);
    mockSuccessfulProbes();

    const status = await service.getStatus();

    expect(status.appServer).toMatchObject({
      ok: false,
      connected: false,
      initialized: true,
    });
    expect(status.runtime.status).toBe('unavailable');
    expect(status.runtime.reasons).toEqual(['appServerUnavailable']);
    expect(status.runtime.cacheTtlMs).toBe(5_000);
    expect(mockCodex.request).not.toHaveBeenCalled();
  });

  it('should aggregate ready status and convert config bigint fields to numbers', async () => {
    mockSuccessfulProbes();

    const status = await service.getStatus();

    expect(status.runtime.status).toBe('ready');
    expect(status.runtime.reasons).toEqual([]);
    expect(status.initialize.data).toMatchObject({
      codexHome: '/home/test/.codex',
      platformOs: 'linux',
    });
    expect(status.provider).toMatchObject({
      ok: true,
      id: 'openai',
      envKey: 'OPENAI_API_KEY',
      envPresent: true,
    });
    expect(status.models).toMatchObject({
      ok: true,
      listable: true,
      defaultModel: 'gpt-5',
      count: 1,
    });

    // Config now returns a whitelist summary, not raw config/read data
    const configData = status.config.data as Record<string, unknown>;
    expect(configData.model).toBe('gpt-5');
    expect(configData.modelProvider).toBe('openai');
    expect(configData.sandboxMode).toBeDefined();
    expect(configData.approvalPolicy).toBeDefined();
    expect(mockCodex.request).toHaveBeenCalledWith('account/read', {
      refreshToken: false,
    });
    expect(mockCodex.request).toHaveBeenCalledWith('config/read', {
      includeLayers: true,
    });
    expect(mockCodex.request).toHaveBeenCalledWith('model/list', {});
  });

  it('should stay ready when provider env and models override account login requirement', async () => {
    mockCodex.request.mockImplementation((method: string) => {
      switch (method) {
        case 'account/read':
          return Promise.resolve(
            accountResponse({ account: null, requiresOpenaiAuth: true }),
          );
        case 'config/read':
          return Promise.resolve(configResponse({ model_provider: 'openai' }));
        case 'model/list':
          return Promise.resolve(modelListResponse());
        default:
          return Promise.reject(new Error(`Unexpected method: ${method}`));
      }
    });

    const status = await service.getStatus();

    expect(status.provider).toMatchObject({
      envKey: 'OPENAI_API_KEY',
      envPresent: true,
    });
    expect(status.runtime.status).toBe('ready');
    expect(status.runtime.reasons).toEqual([]);
  });

  it('should resolve env key from custom provider config before hardcoded mapping', async () => {
    mockCodex.request.mockImplementation((method: string) => {
      switch (method) {
        case 'account/read':
          return Promise.resolve(
            accountResponse({ account: null, requiresOpenaiAuth: true }),
          );
        case 'config/read':
          return Promise.resolve(
            configResponse({
              model_provider: 'donehub',
              model_providers: {
                donehub: { env_key: 'OPENAI_API_KEY' },
              },
            }),
          );
        case 'model/list':
          return Promise.resolve(modelListResponse());
        default:
          return Promise.reject(new Error(`Unexpected method: ${method}`));
      }
    });

    const status = await service.getStatus();

    expect(status.provider).toMatchObject({
      id: 'donehub',
      envKey: 'OPENAI_API_KEY',
      envPresent: true,
    });
    expect(status.runtime.status).toBe('ready');
    expect(status.runtime.reasons).not.toContain('unknownProviderEnvKey');
  });

  it('should return degraded when account/read fails but config and models work', async () => {
    mockCodex.request.mockImplementation((method: string) => {
      switch (method) {
        case 'account/read':
          return Promise.reject(new Error('account offline'));
        case 'config/read':
          return Promise.resolve(configResponse());
        case 'model/list':
          return Promise.resolve(modelListResponse());
        default:
          return Promise.reject(new Error(`Unexpected method: ${method}`));
      }
    });

    const status = await service.getStatus();

    expect(status.account.ok).toBe(false);
    expect(status.account.error?.message).toBe('account offline');
    expect(status.models.ok).toBe(true);
    expect(status.runtime.status).toBe('degraded');
    expect(status.runtime.reasons).toContain('accountReadFailed');
  });

  it('should return unavailable for known provider with missing env key and no account', async () => {
    const originalEnv = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    mockConfig.get.mockReturnValue(undefined);
    mockCodex.request.mockImplementation((method: string) => {
      switch (method) {
        case 'account/read':
          return Promise.resolve(
            accountResponse({ account: null, requiresOpenaiAuth: true }),
          );
        case 'config/read':
          return Promise.resolve(configResponse({ model_provider: 'openai' }));
        case 'model/list':
          return Promise.resolve(modelListResponse());
        default:
          return Promise.reject(new Error(`Unexpected method: ${method}`));
      }
    });

    try {
      const status = await service.getStatus();

      expect(status.provider).toMatchObject({
        id: 'openai',
        envKey: 'OPENAI_API_KEY',
        envPresent: false,
      });
      expect(status.runtime.status).toBe('unavailable');
      expect(status.runtime.reasons).toEqual(
        expect.arrayContaining(['accountLoginRequired', 'missingEnvKey']),
      );
      expect(status.runtime.cacheTtlMs).toBe(5_000);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalEnv;
      }
    }
  });

  it('should cache ready responses for 30 seconds and refresh after TTL', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockSuccessfulProbes();

    await service.getStatus();
    await service.getStatus();
    expect(mockCodex.request).toHaveBeenCalledTimes(3);

    now += 30_001;
    await service.getStatus();
    expect(mockCodex.request).toHaveBeenCalledTimes(6);
  });

  it('should coalesce concurrent cache misses into one probe batch', async () => {
    let resolveAccount: (value: v2.GetAccountResponse) => void = () => {};
    const accountPromise = new Promise<v2.GetAccountResponse>((resolve) => {
      resolveAccount = resolve;
    });

    mockCodex.request.mockImplementation((method: string) => {
      switch (method) {
        case 'account/read':
          return accountPromise;
        case 'config/read':
          return Promise.resolve(configResponse());
        case 'model/list':
          return Promise.resolve(modelListResponse());
        default:
          return Promise.reject(new Error(`Unexpected method: ${method}`));
      }
    });

    const first = service.getStatus();
    const second = service.getStatus();
    await Promise.resolve();

    expect(mockCodex.request).toHaveBeenCalledTimes(3);
    resolveAccount(accountResponse());

    const [firstStatus, secondStatus] = await Promise.all([first, second]);
    expect(firstStatus.runtime.status).toBe('ready');
    expect(secondStatus.runtime.status).toBe('ready');
    expect(mockCodex.request).toHaveBeenCalledTimes(3);
  });
});
