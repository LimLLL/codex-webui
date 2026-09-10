/** Pinned-binary integration checks; all configuration and cache files live in disposable homes. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import {
  CatalogNativeService,
  parseCatalog,
  CATALOG_MAX_BYTES,
} from './catalog-native.service';
import { catalogFixture } from './catalog.testing';
import {
  CodexProcessManager,
  isCatalogStartupFailure,
  CodexStartupError,
} from '../codex-process-manager.service';
import { CatalogActivityService } from './catalog-activity.service';
import { CatalogAdmissionService } from './catalog-admission.service';
import { writeAtomic } from './catalog-files';
import type { v2 } from '../codex-schema';

const baseline = readFileSync(
  resolve('docs/upstream/model-catalog-0.153.2.json'),
  'utf8',
);

describe('pinned catalog parser and lifecycle', () => {
  let fixture: ReturnType<typeof catalogFixture>;
  let native: CatalogNativeService;
  let manager: CodexProcessManager;
  beforeEach(() => {
    fixture = catalogFixture();
    native = new CatalogNativeService(fixture.paths);
    manager = new CodexProcessManager(fixture.storage);
  });
  afterEach(async () => {
    if (manager.getClient()) {
      const client = manager.getClient()!;
      const closed = new Promise<void>((done) =>
        client.once('close', () => done()),
      );
      manager.onModuleDestroy();
      await closed;
    } else manager.onModuleDestroy();
    fixture.cleanup();
  });
  it('exports exactly the checked-in complete baseline and validates its UTF-8 instructions', async () => {
    const exported = await native.bundled();
    expect(JSON.parse(exported)).toEqual(JSON.parse(baseline));
    const catalog = await native.validate(exported);
    expect(catalog.models).toHaveLength(11);
    expect(catalog.models.some((entry) => entry.visibility === 'hide')).toBe(
      true,
    );
  }, 25_000);
  it('returns upstream enum and missing-instructions refusals', async () => {
    const badEnum = parseCatalog(baseline);
    badEnum.models[0].visibility = 'not-real';
    await expect(native.validate(JSON.stringify(badEnum))).rejects.toThrow(
      /unknown variant|not-real/,
    );
    const missing = parseCatalog(baseline);
    delete missing.models[0].base_instructions;
    delete (missing.models[0].model_messages as Record<string, unknown>)
      .instructions_template;
    await expect(native.validate(JSON.stringify(missing))).rejects.toThrow(
      /missing both.*base_instructions/,
    );
  }, 25_000);
  it('never modifies the original remote cache during effective export', async () => {
    const catalogFile = join(fixture.home, 'custom.json');
    writeAtomic(catalogFile, baseline);
    fixture.storage.switchPointer(null, 'custom.json');
    const cache = join(fixture.home, 'models_cache.json');
    const original = '{"models":[],"sentinel":"preserve"}';
    writeFileSync(cache, original);
    expect(parseCatalog(await native.effective()).models).toHaveLength(11);
    expect(readFileSync(cache, 'utf8')).toBe(original);
  }, 25_000);
  it('aborts pending activation before spawn and checks real idle/unmaterialized thread RPCs', async () => {
    const old = fixture.storage.candidatePath();
    writeAtomic(old, baseline);
    fixture.storage.switchPointer(null, old);
    const next = fixture.storage.candidatePath();
    writeAtomic(next, '{bad');
    fixture.storage.record({ outcome: 'pending', before: old, after: next });
    fixture.storage.switchPointer(old, next);
    await manager.onModuleInit();
    expect(manager.getClient()).not.toBeNull();
    expect(fixture.storage.pointer()).toBe(old);
    const client = manager.getClient()!;
    const started = await client.request<v2.ThreadStartResponse>(
      'thread/start',
      { cwd: fixture.home, ephemeral: true },
    );
    const activity = new CatalogActivityService(
      manager,
      new CatalogAdmissionService(),
    );
    const inspection = await activity.inspect();
    expect(inspection.canApply).toBe(false);
    expect(inspection.blockers[0].reason).toContain(
      'ephemeral thread does not support goals',
    );
    const read = await client.request<v2.ThreadReadResponse>('thread/read', {
      threadId: started.thread.id,
      includeTurns: false,
    });
    expect(read.thread.status.type).toBe('idle');
  }, 25_000);
  it('leaves repair available after malformed catalog startup and accepts a repaired restart', async () => {
    const target = fixture.storage.candidatePath();
    writeAtomic(target, '{bad');
    fixture.storage.switchPointer(null, target);
    await manager.onModuleInit();
    expect(manager.isStopped()).toBe(true);
    expect(manager.getStartupError()).toContain('model_catalog_json');
    writeAtomic(target, baseline);
    const observed: string[] = [];
    manager.addLifecycleListener((event) => {
      if (event.type === 'appServerReady') observed.push('ready');
    });
    await manager.restartControlled(() => {
      observed.push('committed');
    });
    expect(observed).toEqual(['committed', 'ready']);
    expect(manager.getGeneration()).toBe(1);
    const first = manager.getClient();
    await manager.restartControlled();
    expect(manager.getGeneration()).toBe(2);
    expect(manager.getClient()).not.toBe(first);
  }, 25_000);
  it('detects a real active turn against a local held-response provider without an inference service', async () => {
    let observedRequest: () => void = () => undefined;
    const providerRequest = new Promise<void>((done) => {
      observedRequest = done;
    });
    const provider = createServer((_request, response) => {
      observedRequest();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"local-probe","status":"in_progress"}}\n\n',
      );
    });
    await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
    try {
      const path = fixture.storage.candidatePath();
      writeAtomic(path, baseline);
      const port = (provider.address() as AddressInfo).port;
      writeAtomic(
        fixture.paths.configFile,
        `model_catalog_json = ${JSON.stringify(path)}\nmodel="gpt-5.6-sol"\nmodel_provider="catalog_test"\n[model_providers.catalog_test]\nname="Local catalog test"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nexperimental_bearer_token="test-only"\nrequest_max_retries=0\n`,
      );
      await manager.onModuleInit();
      const client = manager.getClient()!;
      const { thread } = await client.request<v2.ThreadStartResponse>(
        'thread/start',
        { cwd: fixture.home },
      );
      const { turn } = await client.request<v2.TurnStartResponse>(
        'turn/start',
        {
          threadId: thread.id,
          input: [
            { type: 'text', text: 'Wait until cancelled', text_elements: [] },
          ],
        },
      );
      const inspection = await new CatalogActivityService(
        manager,
        new CatalogAdmissionService(),
      ).inspect();
      expect(inspection.canApply).toBe(false);
      expect(inspection.blockers).toContainEqual(
        expect.objectContaining({
          threadId: thread.id,
          requestMethod: 'turn/start',
          turnId: turn.id,
        }),
      );
      await providerRequest;
      await client.request('turn/interrupt', {
        threadId: thread.id,
        turnId: turn.id,
      });
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((done) => provider.close(() => done()));
    }
  }, 25_000);
  it('distinguishes catalog parse/read errors from credentials, inference and timeouts', () => {
    for (const message of [
      'failed to parse model_catalog_json path as JSON',
      'failed to read model_catalog_json: ENOENT',
    ])
      expect(
        isCatalogStartupFailure(new CodexStartupError('start', message)),
      ).toBe(true);
    for (const message of [
      'expired credentials',
      'model provider unavailable',
      'context_window_exceeded',
      'initialize timeout',
    ])
      expect(
        isCatalogStartupFailure(new CodexStartupError('start', message)),
      ).toBe(false);
    expect(
      isCatalogStartupFailure(new Error('failed to parse model_catalog_json')),
    ).toBe(false);
  });
  it('rejects oversized documents before launching a command', async () => {
    await expect(
      native.validate(' '.repeat(CATALOG_MAX_BYTES + 1)),
    ).rejects.toThrow('8 MiB');
  });
});
