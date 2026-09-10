/** Native process resource bounds and argument isolation without launching a real subprocess. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import {
  CatalogNativeService,
  CATALOG_MAX_BYTES,
} from './catalog-native.service';
import { catalogFixture, draftCatalog } from './catalog.testing';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

describe('bounded native catalog subprocess', () => {
  let fixture: ReturnType<typeof catalogFixture>;
  let native: CatalogNativeService;
  let child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  let started: Promise<void>;
  beforeEach(() => {
    vi.useFakeTimers();
    fixture = catalogFixture();
    native = new CatalogNativeService(fixture.paths);
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        child.emit('close', null);
        return true;
      }),
    });
    started = new Promise((resolve) => {
      mocks.spawn.mockImplementation(() => {
        resolve();
        return child;
      });
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    fixture.cleanup();
    mocks.spawn.mockReset();
  });
  it('kills and reaps a timed-out command, retaining an actionable reason', async () => {
    const result = native.bundled();
    const rejected = expect(result).rejects.toThrow('20 seconds');
    await started;
    await vi.advanceTimersByTimeAsync(20_001);
    await rejected;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('kills excessive output without keeping an unbounded buffer', async () => {
    const result = native.bundled();
    const rejected = expect(result).rejects.toThrow('output exceeded');
    await started;
    child.stdout.write('x'.repeat(CATALOG_MAX_BYTES + 1));
    await rejected;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('uses argument arrays, isolated config, no inherited credentials, and cleans temporary files', async () => {
    const result = native.validate(draftCatalog);
    await started;
    const args = mocks.spawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string>; cwd: string; shell?: boolean },
    ];
    expect(args[1]).toEqual(['debug', 'models']);
    expect(args[2].shell).toBeUndefined();
    expect(args[2].env.CODEX_HOME).not.toBe(fixture.home);
    expect(args[2].env.OPENAI_API_KEY).toBeUndefined();
    child.stdout.write(draftCatalog);
    child.emit('close', 0);
    await result;
    expect(existsSync(args[2].env.CODEX_HOME)).toBe(false);
  });
  it('reports executable errors and invalid output without publishing anything', async () => {
    const result = native.bundled();
    const rejected = expect(result).rejects.toThrow('executable missing');
    await started;
    child.emit('error', new Error('executable missing'));
    child.emit('close', -2);
    await rejected;
    expect(fixture.storage.pointer()).toBeNull();
  });
});
