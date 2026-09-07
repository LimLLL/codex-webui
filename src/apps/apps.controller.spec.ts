import { Test, type TestingModule } from '@nestjs/testing';
import { ErrorCode } from '../common/error-codes';
import { AppsController } from './apps.controller';
import { AppsService } from './apps.service';
import type { v2 } from '../codex/codex-schema';

describe('AppsController', () => {
  let moduleRef: TestingModule;
  let controller: AppsController;

  const appsService = { listApps: vi.fn(), readApps: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    moduleRef = await Test.createTestingModule({
      controllers: [AppsController],
      providers: [{ provide: AppsService, useValue: appsService }],
    }).compile();
    controller = moduleRef.get(AppsController);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('forwards list query params with parsed booleans and limits', async () => {
    const response: v2.AppsListResponse = { data: [], nextCursor: null };
    appsService.listApps.mockResolvedValueOnce(response);

    const result = await controller.listApps(
      'cursor-1',
      '25',
      'thr_123',
      'true',
    );

    expect(result).toBe(response);
    expect(appsService.listApps).toHaveBeenCalledWith({
      cursor: 'cursor-1',
      limit: 25,
      threadId: 'thr_123',
      forceRefetch: true,
    });
  });

  it('deduplicates app ids and forwards includeTools/read context', async () => {
    const response: v2.AppsReadResponse = { apps: [], missingAppIds: [] };
    appsService.readApps.mockResolvedValueOnce(response);

    const result = await controller.readApps(
      ['demo-app', 'demo-app', 'other-app'],
      ' thr_123 ',
      'true',
    );

    expect(result).toBe(response);
    expect(appsService.readApps).toHaveBeenCalledWith({
      appIds: ['demo-app', 'other-app'],
      threadId: 'thr_123',
      includeTools: true,
    });
  });

  it('rejects an empty app id list before calling app/read', async () => {
    await expect(
      Promise.resolve().then(() =>
        controller.readApps([], undefined, undefined),
      ),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.validation.fieldRequired,
      message: 'appIds is required',
      params: { field: 'appIds' },
    });
  });
});
