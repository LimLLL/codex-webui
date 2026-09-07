import { Test, type TestingModule } from '@nestjs/testing';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';
import type { v2 } from '../codex/codex-schema';

describe('PluginsController', () => {
  let moduleRef: TestingModule;
  let controller: PluginsController;

  const pluginsService = {
    listPlugins: vi.fn(),
    readPlugin: vi.fn(),
    installPlugin: vi.fn(),
    uninstallPlugin: vi.fn(),
    reconcilePlugin: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    moduleRef = await Test.createTestingModule({
      controllers: [PluginsController],
      providers: [{ provide: PluginsService, useValue: pluginsService }],
    }).compile();
    controller = moduleRef.get(PluginsController);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('forwards reconcile requests with a trimmed optional reason', async () => {
    const response: v2.PluginReconcileResponse = {
      changedPlugins: [],
      failedRemotePluginIds: [],
      failedMaterializationRemotePluginIds: [],
    };
    pluginsService.reconcilePlugin.mockResolvedValueOnce(response);

    const result = await controller.reconcilePlugin({
      reason: '  manual sync  ',
    });

    expect(result).toBe(response);
    expect(pluginsService.reconcilePlugin).toHaveBeenCalledWith({
      reason: 'manual sync',
    });
  });

  it('keeps null reasons intact for app-server passthrough', async () => {
    const response: v2.PluginReconcileResponse = {
      changedPlugins: [],
      failedRemotePluginIds: [],
      failedMaterializationRemotePluginIds: [],
    };
    pluginsService.reconcilePlugin.mockResolvedValueOnce(response);

    await controller.reconcilePlugin({ reason: null });

    expect(pluginsService.reconcilePlugin).toHaveBeenCalledWith({
      reason: null,
    });
  });
});
