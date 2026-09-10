import type { Mock } from 'vitest';
/** Raw repair and configuration warnings remain usable when the child is unavailable. */
import { CodexConfigController } from '../codex-config.controller';
import type { CodexService } from '../codex.service';
import type { CodexStatusService } from '../codex-status.service';
import type { CodexProcessManager } from '../codex-process-manager.service';
import type { CatalogService } from './catalog.service';
import { catalogFixture } from './catalog.testing';
import { writeAtomic } from './catalog-files';

describe('independent raw config repair', () => {
  let fixture: ReturnType<typeof catalogFixture>;
  let controller: CodexConfigController;
  let request: ReturnType<typeof vi.fn>;
  let validateRawConfig: Mock<(content: string) => Promise<void>>;
  let configWarnings: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fixture = catalogFixture();
    request = vi.fn();
    validateRawConfig = vi.fn().mockResolvedValue(undefined);
    configWarnings = vi
      .fn()
      .mockResolvedValue([{ code: 'modelMissing', message: 'model missing' }]);
    controller = new CodexConfigController(
      { request } as unknown as CodexService,
      { invalidateCache: vi.fn() } as unknown as CodexStatusService,
      fixture.storage,
      { validateRawConfig, configWarnings } as unknown as CatalogService,
      {
        getClient: () => null,
        suspendRetries: vi.fn(),
      } as unknown as CodexProcessManager,
    );
  });
  afterEach(() => fixture.cleanup());
  it('reads a malformed raw config without querying the child', () => {
    writeAtomic(fixture.paths.configFile, '[broken');
    expect(controller.readRawConfig().content).toBe('[broken');
    expect(request).not.toHaveBeenCalled();
  });
  it('saves a repaired config and returns warnings with explicit reload state', async () => {
    writeAtomic(fixture.paths.configFile, '[broken');
    const result = await controller.updateRawConfig({
      content: 'model="custom"\n',
      expectedContent: '[broken',
    });
    expect(result).toMatchObject({
      reloaded: false,
      restartRequired: true,
      warnings: [{ code: 'modelMissing', message: 'model missing' }],
    });
    expect(configWarnings).toHaveBeenCalledWith({ model: 'custom' });
    expect(request).not.toHaveBeenCalled();
  });
  it('does not overwrite on validation failure or an intervening external edit', async () => {
    writeAtomic(fixture.paths.configFile, 'model="old"');
    validateRawConfig.mockRejectedValueOnce(new Error('invalid catalog'));
    await expect(
      controller.updateRawConfig({ content: 'model="new"' }),
    ).rejects.toThrow('invalid catalog');
    expect(fixture.storage.config()).toBe('model="old"');
    validateRawConfig.mockImplementationOnce(() => {
      writeAtomic(fixture.paths.configFile, 'model="external"');
      return Promise.resolve();
    });
    await expect(
      controller.updateRawConfig({ content: 'model="new"' }),
    ).rejects.toThrow('changed during validation');
    expect(fixture.storage.config()).toBe('model="external"');
  });
});
