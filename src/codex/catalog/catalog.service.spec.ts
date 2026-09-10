import type { Mock } from 'vitest';
import type { ModelCatalog } from './catalog-native.service';
import type { CatalogBlockers } from './catalog-activity.service';
/** Catalog activation behavior with real files and controlled native/RPC/lifecycle collaborators. */
import { readFileSync } from 'node:fs';
import { CatalogService } from './catalog.service';
import { CatalogAdmissionService } from './catalog-admission.service';
import type { CatalogActivityService } from './catalog-activity.service';
import type { CatalogNativeService } from './catalog-native.service';
import { parseCatalog } from './catalog-native.service';
import {
  CodexStartupError,
  type CodexProcessManager,
} from '../codex-process-manager.service';
import { writeAtomic } from './catalog-files';
import { catalogFixture, draftCatalog } from './catalog.testing';

describe('CatalogService', () => {
  let fixture: ReturnType<typeof catalogFixture>;
  let service: CatalogService;
  let native: {
    validate: Mock<(text: string) => Promise<ModelCatalog>>;
    validateFile: Mock<(path: string) => Promise<ModelCatalog>>;
    bundled: Mock<() => Promise<string>>;
    effective: Mock<() => Promise<string>>;
  };
  let manager: {
    getClient: Mock<() => { request: typeof request } | null>;
    getStartupError: Mock<() => string | null>;
    isStopped: Mock<() => boolean>;
    suspendRetries: Mock<() => void>;
    restartControlled: Mock<(beforeReady?: () => void) => Promise<void>>;
  };
  let request: Mock<
    (
      method: string,
      params: { edits?: { value: string | null }[] },
    ) => Promise<unknown>
  >;
  let inspect: Mock<() => Promise<CatalogBlockers>>;
  beforeEach(() => {
    fixture = catalogFixture();
    native = {
      validate: vi.fn((text: string) => Promise.resolve(parseCatalog(text))),
      validateFile: vi.fn().mockResolvedValue(parseCatalog(draftCatalog)),
      bundled: vi.fn().mockResolvedValue(draftCatalog),
      effective: vi.fn().mockResolvedValue(draftCatalog),
    };
    request = vi.fn(
      (method: string, params: { edits?: { value: string | null }[] }) => {
        if (method === 'config/read')
          return Promise.resolve({
            config: { model_catalog_json: fixture.storage.pointer() },
            origins: {},
            layers: [
              { name: { type: 'user', profile: null }, version: 'old-version' },
            ],
          });
        if (method === 'config/batchWrite')
          fixture.storage.switchPointer(
            fixture.storage.pointer(),
            params.edits![0].value,
          );
        return Promise.resolve({});
      },
    );
    manager = {
      getClient: vi.fn().mockReturnValue({ request }),
      getStartupError: vi.fn().mockReturnValue(null),
      isStopped: vi.fn().mockReturnValue(false),
      suspendRetries: vi.fn(),
      restartControlled: vi.fn((beforeReady?: () => void) => {
        fixture.storage.runningPaths.clear();
        const pointer = fixture.storage.pointer();
        if (pointer) {
          fixture.storage.runningPaths.add(pointer);
          fixture.storage.runningContent = readFileSync(pointer, 'utf8');
        } else fixture.storage.runningContent = null;
        beforeReady?.();
        return Promise.resolve();
      }),
    };
    inspect = vi.fn().mockResolvedValue({
      canApply: true,
      generation: 1,
      blockers: [],
      scope: 'managedAppServer',
      limitations: [],
    });
    service = new CatalogService(
      fixture.storage,
      native as unknown as CatalogNativeService,
      manager as unknown as CodexProcessManager,
      { inspect } as unknown as CatalogActivityService,
      new CatalogAdmissionService(),
    );
  });
  afterEach(() => fixture.cleanup());
  it('seeds every entry and never activates a draft save', async () => {
    const complete = JSON.stringify({
      models: [{ slug: 'visible' }, { slug: 'hidden', visibility: 'hide' }],
    });
    native.bundled.mockResolvedValue(complete);
    await service.seed('bundled', null);
    expect(fixture.storage.draft()).toBe(complete);
    expect(fixture.storage.pointer()).toBeNull();
    expect(manager.restartControlled).not.toHaveBeenCalled();
  });
  it('refuses invalid or stale drafts without writing or restarting', async () => {
    native.validate.mockRejectedValueOnce(new Error('invalid enum'));
    await expect(service.saveDraft(draftCatalog, null)).rejects.toThrow(
      'invalid enum',
    );
    expect(fixture.storage.draft()).toBeNull();
    await service.saveDraft(draftCatalog, null);
    await expect(service.apply('stale', null)).rejects.toThrow('Draft changed');
    expect(manager.restartControlled).not.toHaveBeenCalled();
  });
  it('publishes before switching and commits before readiness; official-only edits also wire the key', async () => {
    await service.saveDraft(draftCatalog, null);
    manager.restartControlled.mockImplementation((commit?: () => void) => {
      expect(fixture.storage.activation()?.outcome).toBe('pending');
      const path = fixture.storage.pointer()!;
      expect(readFileSync(path, 'utf8')).toBe(draftCatalog);
      fixture.storage.runningPaths.add(path);
      commit!();
      expect(fixture.storage.activation()?.outcome).toBe('accepted');
      return Promise.resolve();
    });
    await service.apply(draftCatalog, null);
    expect(request).toHaveBeenCalledWith(
      'config/batchWrite',
      expect.objectContaining({
        expectedVersion: 'old-version',
        reloadUserConfig: false,
      }),
    );
  });
  it('blocks active work without publishing or writing a record', async () => {
    await service.saveDraft(draftCatalog, null);
    inspect.mockResolvedValue({
      canApply: false,
      scope: 'managedAppServer',
      limitations: [],
      generation: 1,
      blockers: [
        { threadId: 'busy', name: 'Conversation', reason: 'waitingOnApproval' },
      ],
    });
    await expect(service.apply(draftCatalog, null)).rejects.toThrow();
    expect(fixture.storage.activation()).toBeNull();
    expect(manager.restartControlled).not.toHaveBeenCalled();
  });
  it('keeps the previous file intact and only explicit default disables management', async () => {
    await service.saveDraft(draftCatalog, null);
    await service.apply(draftCatalog, null);
    const old = fixture.storage.pointer()!;
    const edited = draftCatalog.replace('custom-model', 'official-only');
    await service.saveDraft(edited, draftCatalog);
    await service.apply(edited, old);
    expect(readFileSync(old, 'utf8')).toBe(draftCatalog);
    expect(fixture.storage.pointer()).not.toBe(old);
    await service.useDefault(fixture.storage.pointer());
    expect(fixture.storage.pointer()).toBeNull();
  });
  it('undoes pointer success followed by a lost RPC response before restarting', async () => {
    await service.saveDraft(draftCatalog, null);
    const original = request.getMockImplementation()!;
    request.mockImplementation(
      async (
        method: string,
        params: { edits?: { value: string | null }[] },
      ) => {
        const result = await original(method, params);
        if (method === 'config/batchWrite') throw new Error('response lost');
        return result;
      },
    );
    await expect(service.apply(draftCatalog, null)).rejects.toThrow(
      'response lost',
    );
    expect(fixture.storage.pointer()).toBeNull();
    expect(fixture.storage.activation()?.outcome).toBe('reverted');
    expect(manager.restartControlled).not.toHaveBeenCalled();
  });
  it('rolls back a catalog startup rejection exactly once', async () => {
    await service.saveDraft(draftCatalog, null);
    manager.restartControlled.mockRejectedValueOnce(
      new CodexStartupError(
        'startup',
        'failed to parse model_catalog_json path as JSON: invalid enum',
      ),
    );
    await expect(service.apply(draftCatalog, null)).rejects.toThrow(
      'previous catalog restored',
    );
    expect(fixture.storage.pointer()).toBeNull();
    expect(manager.restartControlled).toHaveBeenCalledTimes(2);
  });
  it('does not roll back an unrelated failed startup', async () => {
    await service.saveDraft(draftCatalog, null);
    manager.restartControlled.mockImplementationOnce(() => {
      manager.getClient.mockReturnValue(null);
      return Promise.reject(
        new CodexStartupError('auth unavailable', 'expired credentials'),
      );
    });
    await expect(service.apply(draftCatalog, null)).rejects.toThrow(
      'auth unavailable',
    );
    expect(fixture.storage.pointer()).not.toBeNull();
    expect(fixture.storage.activation()?.outcome).toBe('pending');
    expect(manager.restartControlled).toHaveBeenCalledTimes(1);
  });
  it('keeps a stopped child from replacing the previous-working recovery record', async () => {
    manager.getClient.mockReturnValue(null);
    manager.isStopped.mockReturnValue(true);
    await service.saveDraft(draftCatalog, null);
    await expect(service.apply(draftCatalog, null)).rejects.toThrow(
      'repair raw config',
    );
    expect(request).not.toHaveBeenCalled();
    expect(fixture.storage.activation()).toBeNull();
  });
  it('preserves a hand-edited pointer and reports a corrupt recovery record through state', async () => {
    await service.saveDraft(draftCatalog, null);
    fixture.storage.switchPointer(null, '/external.json');
    await expect(service.apply(draftCatalog, null)).rejects.toThrow(
      'pointer changed',
    );
    writeAtomic(fixture.paths.directory + '/activation.json', '{broken');
    expect(service.state().repairError).not.toBeNull();
  });
  it('warns for configured and review models while distinguishing inherited metadata and hiding', async () => {
    native.effective.mockResolvedValue(
      JSON.stringify({ models: [{ slug: 'official', visibility: 'hide' }] }),
    );
    expect(
      await service.configWarnings({
        model: 'official',
        review_model: 'missing',
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'modelHidden' }),
        expect.objectContaining({ code: 'modelMissing' }),
      ]),
    );
    expect(
      await service.configWarnings({ model: 'proxy/official-v2' }),
    ).toEqual([expect.objectContaining({ code: 'modelMetadataInherited' })]);
  });
  it('reports unavailable catalog evidence rather than accepting a missing-model check', async () => {
    native.effective.mockRejectedValue(new Error('failed'));
    expect(await service.configWarnings({ model: 'anything' })).toEqual([
      expect.objectContaining({ code: 'catalogUnavailable' }),
    ]);
  });
});
