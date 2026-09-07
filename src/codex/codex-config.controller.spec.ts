import { Test, type TestingModule } from '@nestjs/testing';
import { ErrorCode } from '../common/error-codes';
import { CodexRpcError } from './codex-errors';
import { CodexConfigController } from './codex-config.controller';
import { CodexService } from './codex.service';
import { CodexStatusService } from './codex-status.service';
import { isCodexConfigEditableKey } from './dto/codex-config.dto';
import type { v2 } from './codex-schema';

describe('CodexConfigController', () => {
  let moduleRef: TestingModule;
  let controller: CodexConfigController;

  const codexService = { request: vi.fn() };
  const codexStatusService = { invalidateCache: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    moduleRef = await Test.createTestingModule({
      controllers: [CodexConfigController],
      providers: [
        { provide: CodexService, useValue: codexService },
        { provide: CodexStatusService, useValue: codexStatusService },
      ],
    }).compile();
    controller = moduleRef.get(CodexConfigController);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  /**
   * Minimal config/read stub.
   *
   * These tests assert on what is sent to `config/batchWrite`, not on the
   * read-back payload, so this deliberately does not mirror the full `Config`
   * shape — doing so would need updating on every protocol bump for no
   * assertion value.
   */
  function configReadResponse(): v2.ConfigReadResponse {
    return {
      config: {
        model: 'gpt-5',
        approvals_reviewer: 'user',
      } as unknown as v2.Config,
      origins: {},
      layers: [],
    };
  }

  it('sends null clears through to config/batchWrite', async () => {
    codexService.request
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(configReadResponse());

    await controller.updateConfig({
      edits: [{ keyPath: 'approvals_reviewer', value: null }],
    });

    expect(codexService.request).toHaveBeenCalledWith('config/batchWrite', {
      edits: [
        {
          keyPath: 'approvals_reviewer',
          value: null,
          mergeStrategy: 'replace',
        },
      ],
      reloadUserConfig: true,
    });
    expect(codexStatusService.invalidateCache).toHaveBeenCalled();
  });

  it('translates structured config validation refusals into a field error', async () => {
    codexService.request.mockRejectedValueOnce(
      new CodexRpcError(
        {
          code: -32600,
          message: 'invalid approvals reviewer',
          data: { config_write_error_code: 'configValidationError' },
        },
        { method: 'config/batchWrite' },
      ),
    );

    await expect(
      controller.updateConfig({
        edits: [{ keyPath: 'approvals_reviewer', value: 'invalid' }],
      }),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.codex.valueInvalid,
      message: 'invalid approvals reviewer',
      params: { key: 'approvals_reviewer' },
    });
    expect(codexStatusService.invalidateCache).not.toHaveBeenCalled();
  });

  it('preserves the original RPC error for multi-edit validation failures', async () => {
    const rpcError = new CodexRpcError(
      {
        code: -32600,
        message: 'invalid approvals reviewer',
        data: { config_write_error_code: 'configValidationError' },
      },
      { method: 'config/batchWrite' },
    );
    codexService.request.mockRejectedValueOnce(rpcError);

    await expect(
      controller.updateConfig({
        edits: [
          { keyPath: 'approvals_reviewer', value: 'invalid' },
          { keyPath: 'model', value: 'gpt-5.1' },
        ],
      }),
    ).rejects.toBe(rpcError);
  });

  it('keeps app config writes bounded to known leaf paths', () => {
    expect(isCodexConfigEditableKey('apps._default.approvals_reviewer')).toBe(
      true,
    );
    expect(isCodexConfigEditableKey('apps.demo.enabled')).toBe(true);
    expect(isCodexConfigEditableKey('apps.demo.default_tools_enabled')).toBe(
      true,
    );
    expect(
      isCodexConfigEditableKey('apps.demo.tools.search.approval_mode'),
    ).toBe(true);

    expect(isCodexConfigEditableKey('apps')).toBe(false);
    expect(isCodexConfigEditableKey('apps.demo')).toBe(false);
    expect(isCodexConfigEditableKey('apps.demo.tools')).toBe(false);
    expect(
      isCodexConfigEditableKey('apps.demo.links.account.approvals_reviewer'),
    ).toBe(false);
  });

  it('holds app-default to the narrower field set that AppsDefaultConfig models', () => {
    // `default_tools_enabled` and per-tool tables exist per-app but not on
    // `apps._default`. The app-server writes them without complaint and then
    // drops them on typed read, so the allowlist is the only thing that can
    // refuse them.
    expect(
      isCodexConfigEditableKey('apps._default.default_tools_enabled'),
    ).toBe(false);
    expect(
      isCodexConfigEditableKey('apps._default.tools.search.approval_mode'),
    ).toBe(false);

    // An app whose id merely starts with `_default` is still an ordinary app.
    expect(
      isCodexConfigEditableKey('apps._defaults.default_tools_enabled'),
    ).toBe(true);
  });
});
