/** Coordinates shared PTYs with durable terminal intent; UI visibility never owns a process. */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { FilesService } from '../files/files.service';
import { SettingsService } from '../settings/settings.service';
import { isTerminalSettingKey } from '../settings/settings.definitions';
import type { TerminalIdentity } from '../database/schema';
import { TerminalRegistryService } from './terminal-registry.service';
import { TerminalSession } from './terminal-session';
import {
  assertTerminalCapacity,
  readTerminalConfig,
  requireTerminalSessionId,
  requireTerminalConnection,
  normalizeTerminalContext,
  resolveTerminalDirectory,
  resolveTerminalShell,
  terminalDimension,
  terminalTitle,
} from './terminal-launch';
import type {
  TerminalAttachment,
  TerminalClosedEvent,
  TerminalConfig,
  TerminalExitEvent,
  TerminalMetadata,
  TerminalMetadataEvent,
  TerminalOpenParams,
  TerminalOutputEvent,
} from './terminal.types';

/** All physical allocation occurs synchronously after asynchronous preparation and revalidation. */
@Injectable()
export class TerminalService implements OnModuleDestroy {
  private readonly logger = new Logger(TerminalService.name);
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly recovering = new Map<
    string,
    {
      result: Promise<TerminalSession>;
      connections: Array<() => boolean>;
    }
  >();
  private readonly events = new EventEmitter();
  private readonly unregisterSettingsChange: () => void;
  private config: TerminalConfig;
  private destroying = false;

  constructor(
    private readonly filesService: FilesService,
    settingsService: SettingsService,
    private readonly registry: TerminalRegistryService,
  ) {
    this.config = readTerminalConfig(settingsService);
    this.unregisterSettingsChange = settingsService.onChange((event) => {
      if (!isTerminalSettingKey(event.key)) return;
      this.config = readTerminalConfig(settingsService);
      this.logger.log(
        'Terminal settings updated for future launches and detach timers',
      );
    });
    this.events.setMaxListeners(20);
  }

  /** Stops owned physical sessions while retaining eligible identities for a later foreground recovery. */
  onModuleDestroy(): void {
    this.destroying = true;
    this.unregisterSettingsChange();
    // One shell that refuses to die must not strand the others. `dispose` throws
    // so an interactive close can report incomplete cleanup, but during shutdown
    // that same throw would abandon every remaining PTY as an orphan process.
    for (const session of this.sessions.values()) {
      try {
        this.dispose(session);
      } catch {
        // Already logged with its terminal id by `dispose`.
      }
    }
    this.events.removeAllListeners();
  }

  /** Returns current limits and defaults, without hydrating or creating a terminal. */
  getConfig(): TerminalConfig {
    return { ...this.config };
  }

  /** Subscribes to mirrored output with a physical-session identity and snapshot sequence. */
  onOutput(listener: (event: TerminalOutputEvent) => void): () => void {
    return this.listen('output', listener);
  }
  /** Subscribes to metadata updates for currently attached sockets. */
  onMetadata(listener: (event: TerminalMetadataEvent) => void): () => void {
    return this.listen('metadata', listener);
  }
  /** Subscribes to natural exits, whose retained buffers remain attachable. */
  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    return this.listen('exit', listener);
  }
  /** Subscribes to explicit logical closure; grace reclamation is not a logical close. */
  onClosed(listener: (event: TerminalClosedEvent) => void): () => void {
    return this.listen('closed', listener);
  }

  /** Lists extant physical sessions only; durable missing records cannot leak into discovery. */
  list(contextKey: string): TerminalMetadata[] {
    const context = normalizeTerminalContext(contextKey);
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.published &&
          session.metadata.contextKey === context &&
          !this.registry.get(context, session.metadata.id).closed,
      )
      .map((session) => session.describe());
  }

  /** Creates one new logical terminal using the explicit directory before any global default. */
  async open(
    socketId: string,
    params: TerminalOpenParams,
    connected: () => boolean = () => true,
  ): Promise<TerminalMetadata> {
    const contextKey = normalizeTerminalContext(params.contextKey);
    const cwd = await resolveTerminalDirectory(
      this.filesService,
      contextKey,
      params.cwd,
      this.config.defaultCwd,
    );
    requireTerminalConnection(!this.destroying && connected());
    const shell = resolveTerminalShell();
    const row: TerminalIdentity = {
      id: randomUUID(),
      contextKey,
      cwd,
      shell,
      title: terminalTitle(params.title, basename(shell)),
      sessionId: randomUUID(),
      generation: 0,
      closed: false,
      automaticAttempts: [],
      createdAt: new Date().toISOString(),
    };
    const session = this.allocate(row, params.cols, params.rows);
    try {
      this.registry.create(row);
    } catch (error) {
      this.dispose(session);
      throw error;
    }
    this.publish(session);
    this.attachSocket(session, socketId);
    return session.describe();
  }

  /** Attaches existing sessions only. Discovery and hidden panes must use this operation. */
  async reconnect(
    socketId: string,
    contextKey: string,
    terminalId: string,
    connected: () => boolean = () => true,
  ): Promise<TerminalAttachment> {
    const session = this.getSession(contextKey, terminalId);
    return this.attach(session, socketId, connected);
  }

  /**
   * Recovers one presented terminal. An existing replacement wins even if the
   * request that created it lost its acknowledgement. Manual attempts bypass the
   * rolling automatic limit but never bypass durable closure or reset the limit.
   */
  async recover(
    socketId: string,
    contextKey: string,
    terminalId: string,
    manual: boolean,
    connected: () => boolean = () => true,
  ): Promise<TerminalAttachment> {
    const context = normalizeTerminalContext(contextKey);
    const row = this.registry.requireOpen(context, terminalId);
    let session = this.sessions.get(row.id);
    if (!session) {
      let pending = this.recovering.get(row.id);
      if (!pending) {
        const connections = [connected];
        pending = {
          connections,
          result: this.replace(row, manual, () =>
            connections.some((isConnected) => isConnected()),
          ).finally(() => this.recovering.delete(row.id)),
        };
        this.recovering.set(row.id, pending);
      } else {
        pending.connections.push(connected);
      }
      session = await pending.result;
    }
    return this.attach(session, socketId, connected);
  }

  /** Detaches this socket only; a browser may own many retained terminal attachments. */
  detach(socketId: string, terminalId?: string): void {
    for (const session of this.sessions.values()) {
      if (terminalId && session.metadata.id !== terminalId) continue;
      if (!session.attachedSocketIds.delete(socketId)) continue;
      this.emitMetadata(session);
      if (!session.attachedSocketIds.size) this.startGraceTimer(session);
    }
  }

  /** Rejects input addressed to a former PTY even if the socket attached to its replacement. */
  write(
    socketId: string,
    context: string,
    id: string,
    sessionId: string,
    data: string,
  ): void {
    requireTerminalSessionId(sessionId);
    const session = this.getAttached(socketId, context, id, sessionId);
    session.write(data);
  }

  /** Applies the latest visible view's size to the addressed physical session only. */
  resize(
    socketId: string,
    context: string,
    id: string,
    sessionId: string,
    cols: number,
    rows: number,
  ): TerminalMetadata {
    requireTerminalSessionId(sessionId);
    const session = this.getAttached(socketId, context, id, sessionId);
    if (session.resize(cols, rows)) this.emitMetadata(session);
    return session.describe();
  }

  /** Renames the logical terminal and its current presentation in the same synchronous operation. */
  rename(
    socketId: string,
    context: string,
    id: string,
    title: string,
  ): TerminalMetadata {
    const session = this.getAttached(socketId, context, id);
    const next = terminalTitle(title, session.metadata.shell);
    this.registry.rename(context, id, next);
    session.metadata.title = next;
    this.emitMetadata(session);
    return session.describe();
  }

  /** Exports the current physical session's retained output as plain text. */
  async download(
    socketId: string,
    context: string,
    id: string,
  ): Promise<{ filename: string; content: string }> {
    const session = this.getAttached(socketId, context, id);
    const download = await session.download();
    this.registry.requireOpen(context, id);
    return download;
  }

  /**
   * Revokes the logical identity before physical cleanup or acknowledgement.
   * Running, exited, missing and already closed terminals all reach this path;
   * attachment is not a prerequisite for revoking an authenticated identity.
   */
  close(_socketId: string, contextKey: string, terminalId: string): boolean {
    const context = normalizeTerminalContext(contextKey);
    this.registry.close(context, terminalId);
    const session = this.sessions.get(terminalId);
    const socketIds = session ? [...session.attachedSocketIds] : [];
    this.events.emit('closed', {
      terminalId,
      contextKey: context,
      socketIds,
    } satisfies TerminalClosedEvent);
    if (session) {
      this.dispose(session);
    }
    this.logger.log(`Closed logical terminal ${terminalId}`);
    return true;
  }

  /** Revalidates after awaited filesystem work; no await separates allocation from publication. */
  private async replace(
    row: TerminalIdentity,
    manual: boolean,
    connected: () => boolean,
  ): Promise<TerminalSession> {
    await resolveTerminalDirectory(
      this.filesService,
      row.contextKey,
      row.cwd,
      this.config.defaultCwd,
    );
    requireTerminalConnection(!this.destroying && connected());
    const current = this.registry.requireOpen(row.contextKey, row.id);
    assertTerminalCapacity(this.sessions.size, this.config.maxSessions);
    if (!manual) this.registry.chargeAutomaticAttempt(row.contextKey, row.id);
    const next = {
      ...current,
      generation: current.generation + 1,
      sessionId: randomUUID(),
    };
    const session = this.allocate(next);
    try {
      this.registry.publish(current, next.sessionId);
    } catch (error) {
      this.dispose(session);
      throw error;
    }
    this.publish(session);
    // Even an acknowledgement-losing or subsequently disconnected caller cannot strand a process.
    this.startGraceTimer(session);
    this.logger.log(
      `Replaced terminal ${row.id}, generation ${next.generation}, manual=${manual}`,
    );
    return session;
  }

  private allocate(
    row: TerminalIdentity,
    cols?: number,
    rows?: number,
  ): TerminalSession {
    assertTerminalCapacity(this.sessions.size, this.config.maxSessions);
    try {
      const session = new TerminalSession(
        row,
        terminalDimension(cols, 20, 300, 80),
        terminalDimension(rows, 5, 120, 24),
        this.config.scrollback,
      );
      this.sessions.set(row.id, session);
      return session;
    } catch (error) {
      this.logger.error(
        { terminalId: row.id, error: String(error) },
        'Terminal launch failed',
      );
      throw BusinessException.internal(
        ErrorCode.terminal.launchFailed,
        'Failed to start terminal shell',
      );
    }
  }

  private publish(session: TerminalSession): void {
    session.published = true;
    session.process.onData((data) =>
      session.mirror(
        data,
        (sequence) => {
          this.events.emit('output', {
            terminalId: session.metadata.id,
            sessionId: session.metadata.sessionId,
            sequence,
            data,
            socketIds: [...session.attachedSocketIds],
          } satisfies TerminalOutputEvent);
        },
        (error) =>
          this.logger.error({ error: String(error) }, 'Terminal mirror failed'),
      ),
    );
    session.process.onExit(({ exitCode, signal }) => {
      if (session.disposed) return;
      Object.assign(session.metadata, {
        status: 'exited',
        exitCode,
        signal: signal ?? null,
      });
      this.events.emit('exit', {
        terminal: session.describe(),
        socketIds: [...session.attachedSocketIds],
      } satisfies TerminalExitEvent);
      this.emitMetadata(session);
      if (!session.attachedSocketIds.size) this.startGraceTimer(session);
    });
  }

  private async attach(
    session: TerminalSession,
    socketId: string,
    connected: () => boolean,
  ): Promise<TerminalAttachment> {
    session.assertPublished();
    requireTerminalConnection(!this.destroying && connected());
    this.registry.requireOpen(session.metadata.contextKey, session.metadata.id);
    this.attachSocket(session, socketId);
    try {
      const snapshot = await session.snapshot();
      requireTerminalConnection(!this.destroying && connected());
      this.registry.requireOpen(
        session.metadata.contextKey,
        session.metadata.id,
      );
      if (this.sessions.get(session.metadata.id) !== session)
        throw BusinessException.conflict(
          ErrorCode.terminal.staleSession,
          'Terminal session changed',
        );
      return { terminal: session.describe(), ...snapshot };
    } catch (error) {
      if (!connected()) this.detach(socketId, session.metadata.id);
      throw error;
    }
  }

  private attachSocket(session: TerminalSession, socketId: string): void {
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = null;
    session.attachedSocketIds.add(socketId);
    this.emitMetadata(session);
  }

  private startGraceTimer(session: TerminalSession): void {
    if (session.graceTimer || session.disposed) return;
    session.graceTimer = setTimeout(() => {
      session.graceTimer = null;
      if (
        session.attachedSocketIds.size ||
        this.sessions.get(session.metadata.id) !== session
      )
        return;
      try {
        this.dispose(session);
        this.logger.log(
          `Reclaimed terminal PTY ${session.metadata.sessionId}; identity remains recoverable`,
        );
      } catch (error) {
        this.logger.error(
          { error: String(error) },
          'Terminal grace cleanup failed',
        );
      }
    }, this.config.graceMs);
  }

  private dispose(session: TerminalSession): void {
    try {
      session.dispose();
      this.sessions.delete(session.metadata.id);
    } catch (error) {
      this.logger.error(
        { terminalId: session.metadata.id, error: String(error) },
        'Terminal cleanup failed',
      );
      throw BusinessException.internal(
        ErrorCode.terminal.cleanupFailed,
        'Terminal process cleanup failed',
      );
    }
  }

  private getSession(contextKey: string, id: string): TerminalSession {
    const context = normalizeTerminalContext(contextKey);
    this.registry.requireOpen(context, id);
    const session = this.sessions.get(id);
    if (!session)
      throw BusinessException.notFound(
        ErrorCode.terminal.lost,
        'Terminal session was lost',
      );
    session.assertPublished();
    return session;
  }

  private getAttached(
    socketId: string,
    context: string,
    id: string,
    sessionId?: string,
  ): TerminalSession {
    const session = this.getSession(context, id);
    session.requireAttachment(socketId, sessionId);
    return session;
  }

  private emitMetadata(session: TerminalSession): void {
    this.events.emit('metadata', {
      terminal: session.describe(),
      socketIds: [...session.attachedSocketIds],
    } satisfies TerminalMetadataEvent);
  }

  private listen<T>(event: string, listener: (event: T) => void): () => void {
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }
}
