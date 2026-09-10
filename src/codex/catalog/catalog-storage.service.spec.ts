/** Crash-boundary, concurrency and content-preservation tests using real temporary files. */
import { linkSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  catalogPointer,
  editCatalogPointer,
  readToml,
  writeAtomic,
} from './catalog-files';
import { CatalogStorageService } from './catalog-storage.service';
import { catalogFixture, draftCatalog } from './catalog.testing';

describe('catalog file storage', () => {
  let fixture: ReturnType<typeof catalogFixture>;
  beforeEach(() => {
    fixture = catalogFixture();
  });
  afterEach(() => fixture.cleanup());

  it('changes only a quoted leaf value and retains comments, CRLF and unrelated tables', () => {
    const before =
      '# greeting\r\n"model_catalog_json"  =  \'old.json\' # catalog\r\n[provider]\r\nkey = "secret"\r\n';
    const after = editCatalogPointer(before, '/new.json');
    expect(after).toBe(before.replace("'old.json'", '"/new.json"'));
    expect(catalogPointer(after)).toBe('/new.json');
    const removed = editCatalogPointer(after, null);
    expect(removed).toContain('# catalog\r\n[provider]');
    expect(readToml(removed)).toEqual({ provider: { key: 'secret' } });
  });
  it('inserts at the root and leaves an absent leaf absent', () => {
    const before = '# preserved\n[model_providers.proxy]\nname="Proxy"\n';
    expect(
      catalogPointer(editCatalogPointer(before, 'C:\\data\\models.json')),
    ).toBe('C:\\data\\models.json');
    expect(editCatalogPointer(before, null)).toBe(before);
  });
  it('draft saves preserve the live catalog, pointer and previous activation', () => {
    const { storage, paths } = fixture;
    const active = storage.candidatePath();
    writeAtomic(active, draftCatalog);
    storage.switchPointer(null, active);
    storage.runningPaths.add(active);
    storage.record({ outcome: 'accepted', before: null, after: active });
    storage.saveDraft(draftCatalog, null);
    const originalConfig = storage.config();
    const originalRecord = storage.activation();
    storage.saveDraft(
      draftCatalog.replace('custom-model', 'another'),
      draftCatalog,
    );
    expect(readFileSync(active, 'utf8')).toBe(draftCatalog);
    expect(storage.config()).toBe(originalConfig);
    expect(storage.activation()).toEqual(originalRecord);
    expect(
      readToml(readFileSync(paths.configFile, 'utf8')).model_catalog_json,
    ).toBe(active);
    expect(() => storage.saveDraft(draftCatalog, null)).toThrow(
      'Draft changed',
    );
  });
  it.each(['direct', 'symlink', 'hardlink'])(
    'rejects a %s reference to the draft',
    (kind) => {
      const { storage, paths } = fixture;
      storage.saveDraft(draftCatalog, null);
      const draft = join(paths.directory, 'draft.json');
      let pointer = draft;
      if (kind !== 'direct') {
        pointer = join(fixture.home, 'alias.json');
        if (kind === 'symlink') symlinkSync(draft, pointer);
        else linkSync(draft, pointer);
      }
      storage.switchPointer(null, pointer);
      expect(() => storage.saveDraft('changed', draftCatalog)).toThrow(
        'referenced',
      );
      expect(storage.draft()).toBe(draftCatalog);
    },
  );
  it('protects a live file after a user has changed the configured pointer', () => {
    const { storage } = fixture;
    const active = storage.candidatePath();
    writeAtomic(active, draftCatalog);
    storage.runningPaths.add(active);
    expect(storage.candidatePath()).not.toBe(active);
    expect(() => storage.assertUnreferenced(active)).toThrow('referenced');
  });
  it.each(['intent', 'published', 'switched'])(
    'aborts an interrupted activation after %s on a fresh service instance',
    (boundary) => {
      const { storage, paths } = fixture;
      const active = storage.candidatePath();
      writeAtomic(active, 'previous');
      storage.switchPointer(null, active);
      const candidate = storage.candidatePath();
      storage.record({ outcome: 'pending', before: active, after: candidate });
      if (boundary !== 'intent') writeAtomic(candidate, draftCatalog);
      if (boundary === 'switched') storage.switchPointer(active, candidate);
      writeFileSync(
        paths.configFile,
        `${storage.config()}\n# concurrent unrelated edit\nmodel = "new-choice"\n`,
      );
      const restarted = new CatalogStorageService(paths);
      restarted.recoverPending();
      restarted.recoverPending();
      expect(restarted.pointer()).toBe(active);
      expect(restarted.config()).toContain('# concurrent unrelated edit');
      expect(readFileSync(active, 'utf8')).toBe('previous');
      expect(restarted.activation()?.outcome).toBe('reverted');
    },
  );
  it('does not undo accepted activation after response loss', () => {
    const { storage, paths } = fixture;
    const next = storage.candidatePath();
    writeAtomic(next, draftCatalog);
    storage.switchPointer(null, next);
    storage.record({ outcome: 'accepted', before: null, after: next });
    new CatalogStorageService(paths).recoverPending();
    expect(storage.pointer()).toBe(next);
  });
  it('restores absence and stops on a different external pointer', () => {
    const { storage } = fixture;
    const next = storage.candidatePath();
    storage.record({ outcome: 'pending', before: null, after: next });
    storage.switchPointer(null, next);
    storage.recoverPending();
    expect(storage.pointer()).toBeNull();
    storage.record({ outcome: 'pending', before: null, after: next });
    storage.switchPointer(null, '/external.json');
    expect(() => storage.recoverPending()).toThrow('changed externally');
    expect(storage.pointer()).toBe('/external.json');
  });
  it('finishes restoration after a crash between pointer restoration and outcome writing', () => {
    const { storage } = fixture;
    storage.record({
      outcome: 'pending',
      before: null,
      after: '/candidate.json',
    });
    storage.recoverPending();
    expect(storage.activation()?.outcome).toBe('reverted');
  });
  it('fails clearly for malformed config or records instead of treating them as empty', () => {
    const { storage, paths } = fixture;
    writeFileSync(paths.configFile, '[broken');
    expect(() => storage.candidatePath()).toThrow();
    writeFileSync(join(paths.directory, 'activation.json'), '{broken');
    expect(() => storage.activation()).toThrow();
  });
});
