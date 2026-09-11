/** Owns one Codex child, controlled catalog restarts, and generation-scoped recovery events. */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { readCatalogFile } from './catalog/catalog-files';
import {
  CodexJsonRpcClient,
  type CodexJsonRpcClientEvents,
} from './codex-jsonrpc-client';
import type { InitializeResponse } from './codex-schema';
import { CatalogStorageService } from './catalog/catalog-storage.service';
import type { ServerRequestHandler } from './server-request-owner';

export type CodexLifecycleEvent =
  | { type: 'appServerRestarting'; generation: number; delayMs: number }
  | { type: 'appServerReady'; generation: number; restarted: boolean }
  | { type: 'appServerUnavailable'; generation: number; message: string };

/** Startup failures retain bounded stderr for precise catalog-error classification and repair. */
export class CodexStartupError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Only catalog-specific parser/read diagnostics permit automatic activation rollback. */
export function isCatalogStartupFailure(error: unknown): boolean {
  return (
    error instanceof CodexStartupError &&
    /(?:failed to (?:parse|read|load).*model_catalog_json|model_catalog_json[^\n]*(?:failed|must contain|No such file|Permission denied))/i.test(
      error.stderr,
    )
  );
}

@Injectable()
export class CodexProcessManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CodexProcessManager.name);
  private client: CodexJsonRpcClient | null = null;
  private initResult: InitializeResponse | null = null;
  private destroyed = false;
  private controlled = false;
  private starting: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** A transient-failure retry withheld because the old child had not exited yet. */
  private retryOnClose = false;
  /**
   * Clients this manager asked to stop.
   *
   * Intent has to be recorded per child rather than read from `controlled` at
   * close time: a controlled stop that times out clears that flag in `finally`,
   * and the old child's later exit would then look like an ordinary crash and
   * schedule a plain restart — booting a candidate while its activation record
   * is still pending, outside the accept/rollback transaction.
   */
  private readonly retired = new WeakSet<CodexJsonRpcClient>();
  private generation = 0;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private startupError: string | null = null;
  private readonly eventForwarders: Array<{
    event: keyof CodexJsonRpcClientEvents;
    handler: (...args: unknown[]) => void;
  }> = [];
  private readonly lifecycleHandlers = new Set<
    (event: CodexLifecycleEvent) => void
  >();

  constructor(private readonly storage: CatalogStorageService) {}

  /** Recovers interrupted activation before spawning; errors leave HTTP repair available. */
  async onModuleInit(): Promise<void> {
    try {
      this.storage.recoverPending();
    } catch (error) {
      // Recovery is a precondition of spawning, not part of the attempt: a
      // half-applied activation must be resolved before a child loads whichever
      // catalog the interrupted publish happened to leave behind. Retrying on a
      // 3s timer would spawn exactly the child this check exists to prevent.
      this.unavailable(error);
      return;
    }
    try {
      await this.start();
    } catch (error) {
      this.failUnattendedStart(error);
    }
  }
  /** Stops timers and the child when Nest shuts down. */
  onModuleDestroy(): void {
    this.destroyed = true;
    this.clearRetryIntent();
    this.client?.destroy();
    this.client = null;
  }
  /** Returns only an initialized client, never a half-started generation. */
  getClient(): CodexJsonRpcClient | null {
    return this.initResult ? this.client : null;
  }
  /** Returns the current handshake. */
  getInitResult(): InitializeResponse | null {
    return this.initResult;
  }
  /** Returns the accepted child generation. */
  getGeneration(): number {
    return this.generation;
  }
  /** Exposes startup diagnostics through the authenticated repair endpoint. */
  getStartupError(): string | null {
    return this.startupError;
  }
  /** Confirms there is no process or initialization attempt that could own active work. */
  isStopped(): boolean {
    return this.client === null && this.starting === null;
  }
  /** Registers a listener that survives child replacement. */
  addListener(
    event: keyof CodexJsonRpcClientEvents,
    handler: (...args: unknown[]) => void,
  ): void {
    this.eventForwarders.push({ event, handler });
    if (this.client) this.forward(this.client, event, handler);
  }
  /** Registers the one request admission owner for every replacement connection. */
  setServerRequestHandler(handler: ServerRequestHandler): void {
    if (this.serverRequestHandler && this.serverRequestHandler !== handler)
      throw new Error('Server-request admission already has an owner');
    this.serverRequestHandler = handler;
    this.client?.serverRequests.setHandler(handler);
  }

  /** Old child buffers must never acquire the replacement child's identity. */
  private forward(
    client: CodexJsonRpcClient,
    event: keyof CodexJsonRpcClientEvents,
    handler: (...args: unknown[]) => void,
  ): void {
    // Close subscribers are dispatched together before the manager clears this
    // connection. Attaching one after startup must not put it behind cleanup.
    if (event === 'close') return;
    client.on(event, (...args: unknown[]) => {
      if (this.client === client) handler(...args);
    });
  }
  /** Registers process lifecycle observations. */
  addLifecycleListener(
    handler: (event: CodexLifecycleEvent) => void,
  ): () => void {
    this.lifecycleHandlers.add(handler);
    return () => this.lifecycleHandlers.delete(handler);
  }
  /** Suspends automatic retries during offline file repair without killing a healthy child. */
  suspendRetries(): void {
    // Includes the deferred one: offline repair means no automatic spawn at all,
    // and a retry owed to a lingering child would otherwise fire mid-repair.
    this.clearRetryIntent();
  }
  /** Cancels a pending timer and any retry still owed to a child's exit. */
  private clearRetryIntent(): void {
    this.retryOnClose = false;
    this.clearRetry();
  }
  /** Restarts once; the callback commits durable activation before any ready event or auto-resume. */
  async restartControlled(
    beforeReady: () => void = () => undefined,
  ): Promise<void> {
    if (this.controlled)
      throw new Error('A controlled restart is already in progress');
    this.controlled = true;
    // A controlled restart supersedes any earlier automatic intent, deferred or
    // scheduled; this restart is now the only thing allowed to spawn.
    this.clearRetryIntent();
    let stopRequested = false;
    try {
      if (this.starting) await this.starting.catch(() => undefined);
      if (this.client?.acceptedWork.blockers().length) {
        throw new Error(
          'Cannot establish idle: locally dispatched work has no observed terminal transition',
        );
      }
      stopRequested = true;
      this.emitLifecycle({
        type: 'appServerRestarting',
        generation: this.generation,
        delayMs: 0,
      });
      await this.stop();
      await this.start(beforeReady);
    } catch (error) {
      // A pre-stop refusal leaves the healthy child and its approval generation untouched.
      if (stopRequested) this.unavailable(error);
      throw error;
    } finally {
      this.controlled = false;
    }
  }
  private start(beforeReady: () => void = () => undefined): Promise<void> {
    if (this.starting) return this.starting;
    const attempt = this.spawnAndInitialize(beforeReady);
    this.starting = attempt;
    void attempt
      .finally(() => {
        if (this.starting === attempt) this.starting = null;
      })
      .catch(() => undefined);
    return attempt;
  }
  private async spawnAndInitialize(beforeReady: () => void): Promise<void> {
    // A missing configured catalog otherwise produces a generic upstream I/O error.
    // This direct read establishes its catalog-specific cause before spawning.
    const configuredPointer = this.storage.pointer();
    if (configuredPointer) {
      try {
        // Bounded and asynchronous: this path is user-controlled, and a FIFO or
        // a stalled mount read synchronously here would freeze the whole Nest
        // process, taking the repair endpoints down with it.
        await readCatalogFile(this.storage.resolvePointer(configuredPointer));
      } catch (error) {
        throw new CodexStartupError(
          'Cannot read configured catalog',
          `failed to read model_catalog_json: ${String(error)}`,
        );
      }
    }
    const child = spawn(
      this.storage.paths.binary,
      ['app-server', '--listen', 'stdio://'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CODEX_HOME: this.storage.paths.home },
      },
    );
    let stderr = '';
    let accepted = false;
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    });
    const current = new CodexJsonRpcClient(child);
    this.client = current;
    if (this.serverRequestHandler)
      current.serverRequests.setHandler(this.serverRequestHandler);
    for (const { event, handler } of this.eventForwarders)
      this.forward(current, event, handler);
    current.on('error', (error) => this.logger.warn(error.message));
    child.on('error', (error) => {
      stderr = (stderr + error.message).slice(-16_384);
      current.destroy();
    });
    current.on('close', (code, signal) => {
      if (this.client !== current) return;
      for (const { event, handler } of this.eventForwarders) {
        if (event !== 'close') continue;
        try {
          handler(code, signal);
        } catch {
          // Observer failure cannot prevent connection cleanup or self-healing.
          this.logger.warn('App-server close observer failed');
        }
      }
      this.client = null;
      this.initResult = null;
      this.storage.runningPaths.clear();
      this.storage.runningContent = null;
      this.emitLifecycle({
        type: 'appServerUnavailable',
        generation: this.generation,
        message: 'Codex app-server exited',
      });
      // A retry deferred because the previous child had not been observed to
      // exit is owed exactly one attempt once it does. Without this, a shutdown
      // timeout on an otherwise transient failure is permanently fatal: the
      // gate refuses while the process lingers, and nothing re-checks after it
      // finally goes away.
      // Two distinct reasons to restart, and retirement only silences the first.
      // A crash of an accepted child self-heals unless this manager asked it to
      // stop — an intentional stop belongs to whoever requested it, and reviving
      // it here would boot a candidate outside the activation transaction. An
      // owed retry is different: it was already decided, and was only deferred
      // until this exit could be observed.
      const owed = this.retryOnClose;
      this.retryOnClose = false;
      const crashed = accepted && !this.retired.has(current);
      if ((crashed || owed) && !this.controlled && !this.destroyed)
        this.scheduleRestart();
    });
    try {
      const initialized = await current.initialize({
        clientInfo: {
          name: 'codex_webui',
          title: 'Codex WebUI',
          version: '0.1.0',
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      // Resolve startup-effective layering before recording which files must not be overwritten.
      const response = await current.request<{
        config: Record<string, unknown>;
      }>('config/read', { includeLayers: true });
      const pointer = response.config.model_catalog_json;
      if (typeof pointer === 'string')
        this.storage.runningPaths.add(this.storage.resolvePointer(pointer));
      this.storage.runningContent =
        typeof pointer === 'string'
          ? await readCatalogFile(this.storage.resolvePointer(pointer))
          : null;
      await current.request('model/list', { includeHidden: true, limit: 1 });
      if (this.client !== current)
        throw new Error('App-server exited during initialization');
      beforeReady();
      this.initResult = initialized;
      this.generation += 1;
      this.startupError = null;
      accepted = true;
      this.emitLifecycle({
        type: 'appServerReady',
        generation: this.generation,
        restarted: this.generation > 1,
      });
    } catch (error) {
      // A shutdown timeout must not replace the diagnostic that caused this
      // failure: the retained stderr is what classifies a rejected catalog, and
      // losing it would turn a deterministic failure back into a retry loop.
      // Whether the child actually stopped is reported separately, by the
      // retirement bookkeeping the close handler reads.
      await this.stop().catch((stopError: unknown) =>
        this.logger.warn(
          `Codex did not exit after a failed start: ${String(stopError)}`,
        ),
      );
      throw new CodexStartupError(
        error instanceof Error ? error.message : String(error),
        stderr,
      );
    }
  }
  private async stop(): Promise<void> {
    const current = this.client;
    this.initResult = null;
    if (!current) return;
    // Recorded before the request so a later exit is never mistaken for a crash.
    this.retired.add(current);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Codex did not exit; replacement was not started'));
      }, 5_000);
      current.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      current.destroy();
    });
    if (this.client === current) this.client = null;
    this.storage.runningPaths.clear();
    this.storage.runningContent = null;
  }
  private scheduleRestart(): void {
    if (this.retry || this.destroyed || this.controlled) return;
    this.emitLifecycle({
      type: 'appServerRestarting',
      generation: this.generation,
      delayMs: 3000,
    });
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start().catch((error: unknown) =>
        this.failUnattendedStart(error),
      );
    }, 3000);
  }

  /**
   * Reports an unattended start failure and keeps retrying transient ones.
   *
   * A rejected catalog is deterministic: retrying it just loops forever, so it
   * stays down and waits for repair. Every other startup failure used to
   * self-heal on a 3s timer, and losing that would turn an ordinary transient
   * fault — a volume that mounts a moment late, a briefly busy binary — into a
   * permanently dead app-server that only an explicit restart can recover.
   *
   * A retry also requires an observed stop. When `stop()` times out the previous
   * child may still be alive, and spawning a replacement would put two
   * app-servers on one Codex home — worse than staying down with a recorded
   * diagnostic and the explicit restart endpoint.
   *
   * @param error - Failure raised by a spawn/initialize attempt nobody is awaiting.
   */
  private failUnattendedStart(error: unknown): void {
    this.unavailable(error);
    if (isCatalogStartupFailure(error)) return;
    if (this.isStopped()) this.scheduleRestart();
    // Still holding a child that would not stop. Defer the retry to its close
    // rather than dropping it, so self-healing survives a slow shutdown.
    else this.retryOnClose = true;
  }
  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }
  private unavailable(error: unknown): void {
    this.startupError =
      error instanceof CodexStartupError
        ? error.stderr || error.message
        : String(error);
    this.logger.error(`Codex unavailable: ${this.startupError}`);
    this.emitLifecycle({
      type: 'appServerUnavailable',
      generation: this.generation,
      message: this.startupError,
    });
  }
  private emitLifecycle(event: CodexLifecycleEvent): void {
    for (const handler of this.lifecycleHandlers) {
      try {
        handler(event);
      } catch (error) {
        this.logger.warn(`Lifecycle listener failed: ${String(error)}`);
      }
    }
  }
}
