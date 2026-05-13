/**
 * Manages codex app-server child process lifecycle.
 * Spawns the process, initializes the JSON-RPC handshake, and handles restart on exit.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import {
  CodexJsonRpcClient,
  CodexJsonRpcClientEvents,
} from './codex-jsonrpc-client';
import type { InitializeResponse } from './codex-schema';

export type CodexLifecycleEvent =
  | { type: 'appServerRestarting'; generation: number; delayMs: number }
  | { type: 'appServerReady'; generation: number; restarted: boolean }
  | { type: 'appServerUnavailable'; generation: number; message: string };

@Injectable()
export class CodexProcessManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CodexProcessManager.name);
  private client: CodexJsonRpcClient | null = null;
  private initResult: InitializeResponse | null = null;
  private restarting = false;
  private destroyed = false;
  private generation = 0;

  /** Listeners registered via onNotification/onServerRequest before the client is ready. */
  private readonly eventForwarders: Array<{
    event: keyof CodexJsonRpcClientEvents;
    handler: (...args: unknown[]) => void;
  }> = [];

  /** Process-level lifecycle listeners used by gateways and recovery services. */
  private readonly lifecycleHandlers = new Set<
    (event: CodexLifecycleEvent) => void
  >();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.client?.destroy();
    this.client = null;
  }

  /** Returns the current JSON-RPC client, or null if not connected. */
  getClient(): CodexJsonRpcClient | null {
    return this.client;
  }

  /** Returns the initialize response, or null if not initialized. */
  getInitResult(): InitializeResponse | null {
    return this.initResult;
  }

  /**
   * Registers a forwarded event listener that persists across process restarts.
   *
   * @param event - The event name to listen for
   * @param handler - The callback function
   */
  addListener(
    event: keyof CodexJsonRpcClientEvents,
    handler: (...args: unknown[]) => void,
  ): void {
    this.eventForwarders.push({ event, handler });
    if (this.client) {
      this.client.on(event, handler);
    }
  }

  /** Registers a process lifecycle listener. Returns an unsubscribe function. */
  addLifecycleListener(
    handler: (event: CodexLifecycleEvent) => void,
  ): () => void {
    this.lifecycleHandlers.add(handler);
    return () => this.lifecycleHandlers.delete(handler);
  }

  private emitLifecycle(event: CodexLifecycleEvent): void {
    for (const handler of this.lifecycleHandlers) {
      try {
        handler(event);
      } catch (err) {
        this.logger.warn(
          `Lifecycle listener failed: ${(err as Error).message}`,
        );
      }
    }
  }

  private async start(): Promise<void> {
    const codexBin = this.config.get<string>('CODEX_BIN', 'codex');
    const codexHome = this.config.get<string>('CODEX_HOME', '');

    const env: Record<string, string> = { ...process.env } as Record<
      string,
      string
    >;
    if (codexHome) {
      env['CODEX_HOME'] = codexHome;
    }

    this.logger.log(`Spawning ${codexBin} app-server (stdio)`);

    const child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.client = new CodexJsonRpcClient(child);

    // Attach persisted event forwarders
    for (const { event, handler } of this.eventForwarders) {
      this.client.on(event, handler);
    }

    this.client.on('error', (err) => {
      this.logger.warn(`Codex client error: ${err.message}`);
    });

    // Capture local reference to avoid race with close handler
    const currentClient = this.client;

    currentClient.on('close', (code, signal) => {
      this.logger.warn(
        `Codex app-server exited (code=${code}, signal=${signal})`,
      );
      // Only clear if still the active client (avoids clobbering a new spawn)
      if (this.client === currentClient) {
        this.client = null;
        this.initResult = null;
        this.emitLifecycle({
          type: 'appServerUnavailable',
          generation: this.generation,
          message: `Codex app-server exited (code=${code}, signal=${signal})`,
        });
      }
      if (!this.destroyed) {
        void this.restart();
      }
    });

    try {
      this.initResult = await currentClient.initialize({
        clientInfo: {
          name: 'codex_webui',
          title: 'Codex WebUI',
          version: '0.1.0',
        },
        capabilities: { experimentalApi: true },
      });
      this.generation += 1;
      this.logger.log(
        `Codex app-server initialized (codexHome=${this.initResult.codexHome}, platform=${this.initResult.platformOs})`,
      );
      this.emitLifecycle({
        type: 'appServerReady',
        generation: this.generation,
        restarted: this.generation > 1,
      });
    } catch (err) {
      this.logger.error(
        `Failed to initialize codex app-server: ${(err as Error).message}`,
      );
      currentClient.destroy();
      if (this.client === currentClient) {
        this.client = null;
      }
      if (!this.destroyed) {
        void this.restart();
      }
    }
  }

  private async restart(): Promise<void> {
    if (this.restarting || this.destroyed) return;
    this.restarting = true;
    const delayMs = 3000;
    this.logger.log(`Restarting codex app-server in ${delayMs}ms...`);
    this.emitLifecycle({
      type: 'appServerRestarting',
      generation: this.generation,
      delayMs,
    });
    await new Promise((r) => setTimeout(r, delayMs));
    this.restarting = false;
    if (!this.destroyed) {
      await this.start();
    }
  }
}
