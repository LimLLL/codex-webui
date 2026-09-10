/** Unattended startup-failure retry policy, without launching a real Codex binary. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexProcessManager } from './codex-process-manager.service';
import { catalogFixture } from './catalog/catalog.testing';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

/**
 * Builds a child stub that dies immediately, the way a transient spawn fault
 * looks: the handshake never completes and the process is gone.
 */
function failingChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  queueMicrotask(() => child.emit('close', 1, null));
  return child;
}

describe('CodexProcessManager unattended start failures', () => {
  let fixture: ReturnType<typeof catalogFixture>;
  let manager: CodexProcessManager;

  beforeEach(() => {
    vi.useFakeTimers();
    fixture = catalogFixture();
    manager = new CodexProcessManager(fixture.storage);
    mocks.spawn.mockImplementation(() => failingChild());
  });

  afterEach(() => {
    manager.onModuleDestroy();
    vi.useRealTimers();
    fixture.cleanup();
    mocks.spawn.mockReset();
  });

  it('keeps retrying a transient first-boot failure instead of staying down', async () => {
    await manager.onModuleInit();

    expect(manager.getClient()).toBeNull();
    expect(manager.getStartupError()).not.toBeNull();
    const afterFirst = mocks.spawn.mock.calls.length;
    expect(afterFirst).toBe(1);

    // The 3s self-heal timer is the only thing standing between a late-mounting
    // volume and an app-server that never comes back without human action.
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('stays down for a rejected catalog so a deterministic failure cannot loop', async () => {
    const catalog = join(fixture.paths.directory, 'catalog-a.json');
    writeFileSync(catalog, '{bad');
    fixture.storage.switchPointer(null, catalog);
    // Make the configured catalog unreadable so startup fails catalog-specifically.
    fixture.storage.switchPointer(catalog, join(fixture.home, 'missing.json'));

    await manager.onModuleInit();

    expect(manager.getStartupError()).toContain('model_catalog_json');
    const attempts = mocks.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn.mock.calls.length).toBe(attempts);
  });

  it('never spawns when pending-activation recovery refuses', async () => {
    // Recovery is what decides which catalog is legitimate after an interrupted
    // publish. Spawning anyway would load whichever file the crash left behind.
    vi.spyOn(fixture.storage, 'recoverPending').mockImplementation(() => {
      throw new Error('Catalog pointer changed externally');
    });

    await manager.onModuleInit();

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(manager.getStartupError()).toContain('changed externally');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('never auto-restarts a child this manager asked to stop', async () => {
    // A controlled stop that times out clears the `controlled` flag in its
    // `finally`. If the later exit were read through that flag it would look
    // like a crash, and the automatic restart would boot a candidate outside
    // the activation transaction — no acceptance, no rollback.
    const children: EventEmitter[] = [];
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      children.push(child);
      return child;
    });

    const started = manager.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    manager.suspendRetries();
    const attempts = mocks.spawn.mock.calls.length;
    children[0]?.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn.mock.calls.length).toBe(attempts);
  });

  it('resumes the withheld retry once the stuck child finally exits', async () => {
    // The gate defers a transient-failure retry while the old process may still
    // be alive. If it simply dropped it, a slow shutdown would turn a
    // self-healing fault into permanent downtime.
    let stuck: EventEmitter | undefined;
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      stuck ??= child;
      return child;
    });

    const started = manager.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    const attempts = mocks.spawn.mock.calls.length;

    stuck?.emit('close', 1, null);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(attempts);
  });

  it('does not replace a child that failed to shut down', async () => {
    // `stop()` timing out means the old process may still be alive; a second
    // app-server on the same Codex home is worse than staying down.
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      // Never emits 'close': destroy() cannot confirm the process is gone.
      return child;
    });

    const started = manager.onModuleInit();
    // The handshake times out first; only then does stop() start its own timer.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    // The shutdown timeout is logged, not promoted over the real cause: the
    // retained diagnostic is what classifies the failure, and replacing it with
    // "did not exit" would lose a catalog rejection and restart the retry loop.
    expect(manager.getStartupError()).toContain('timed out');
    const attempts = mocks.spawn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn.mock.calls.length).toBe(attempts);
  });
});
