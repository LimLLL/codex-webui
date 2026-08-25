/** Unit tests for AccountService: account read, login flows, logout, rate limits. */
import { Test, type TestingModule } from '@nestjs/testing';
import { BusinessException } from '../common/business.exception';
import { CodexStatusService } from '../codex/codex-status.service';
import { CodexService } from '../codex/codex.service';
import { AccountService } from './account.service';

describe('AccountService', () => {
  let moduleRef: TestingModule;
  let service: AccountService;

  const codexService = { request: vi.fn() };
  const codexStatusService = {
    getProviderStatus: vi.fn(),
    invalidateCache: vi.fn(),
  };

  const provider = {
    ok: true,
    id: 'donehub',
    name: 'OpenAI',
    baseUrlMasked: 'https://don…hub.example/v1',
    envKey: 'OPENAI_API_KEY',
    envPresent: true,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    moduleRef = await Test.createTestingModule({
      providers: [
        AccountService,
        { provide: CodexService, useValue: codexService },
        { provide: CodexStatusService, useValue: codexStatusService },
      ],
    }).compile();
    service = moduleRef.get(AccountService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('reads account state enriched with provider metadata', async () => {
    codexService.request.mockResolvedValueOnce({
      account: null,
      requiresOpenaiAuth: false,
    });
    codexStatusService.getProviderStatus.mockResolvedValueOnce(provider);

    const result = await service.readAccount();
    expect(result).toEqual({
      account: null,
      requiresOpenaiAuth: false,
      provider,
    });
    expect(codexService.request).toHaveBeenCalledWith('account/read', {
      refreshToken: false,
    });
  });

  it('starts API key login with trimmed key and invalidates cache', async () => {
    codexService.request.mockResolvedValueOnce({ type: 'apiKey' });
    const result = await service.login({
      type: 'apiKey',
      apiKey: '  sk-test  ',
    });
    expect(result).toEqual({ type: 'apiKey' });
    expect(codexService.request).toHaveBeenCalledWith('account/login/start', {
      type: 'apiKey',
      apiKey: 'sk-test',
    });
    expect(codexStatusService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('rejects empty API key', async () => {
    await expect(
      service.login({ type: 'apiKey', apiKey: '   ' }),
    ).rejects.toBeInstanceOf(BusinessException);
    expect(codexService.request).not.toHaveBeenCalled();
  });

  it('starts ChatGPT device-code login', async () => {
    const response = {
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://example.com/device',
      userCode: 'ABCD-EFGH',
    };
    codexService.request.mockResolvedValueOnce(response);
    const result = await service.login({ type: 'chatgptDeviceCode' });
    expect(result).toBe(response);
    expect(codexService.request).toHaveBeenCalledWith('account/login/start', {
      type: 'chatgptDeviceCode',
    });
  });

  it('starts chatgptAuthTokens login with trimmed fields', async () => {
    codexService.request.mockResolvedValueOnce({ type: 'chatgptAuthTokens' });
    await service.login({
      type: 'chatgptAuthTokens',
      accessToken: '  token  ',
      chatgptAccountId: '  acc-id  ',
    });
    expect(codexService.request).toHaveBeenCalledWith('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: 'token',
      chatgptAccountId: 'acc-id',
      chatgptPlanType: null,
    });
  });

  it('rejects chatgptAuthTokens with empty accessToken', async () => {
    await expect(
      service.login({
        type: 'chatgptAuthTokens',
        accessToken: '',
        chatgptAccountId: 'acc',
      }),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('cancels login with trimmed loginId', async () => {
    codexService.request.mockResolvedValueOnce(undefined);
    await service.cancelLogin('  login-1  ');
    expect(codexService.request).toHaveBeenCalledWith('account/login/cancel', {
      loginId: 'login-1',
    });
  });

  it('rejects empty loginId cancellation', async () => {
    await expect(service.cancelLogin('   ')).rejects.toBeInstanceOf(
      BusinessException,
    );
    expect(codexService.request).not.toHaveBeenCalled();
  });

  it('rejects undefined loginId cancellation', async () => {
    await expect(service.cancelLogin(undefined)).rejects.toBeInstanceOf(
      BusinessException,
    );
    expect(codexService.request).not.toHaveBeenCalled();
  });

  it('logs out and invalidates status cache', async () => {
    codexService.request.mockResolvedValueOnce(undefined);
    await service.logout();
    expect(codexService.request).toHaveBeenCalledWith('account/logout');
    expect(codexStatusService.invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('reads rate limits', async () => {
    const response = {
      rateLimits: { primary: null },
      rateLimitsByLimitId: null,
    };
    codexService.request.mockResolvedValueOnce(response);
    const result = await service.readRateLimits();
    expect(result).toBe(response);
    expect(codexService.request).toHaveBeenCalledWith(
      'account/rateLimits/read',
    );
  });
});
