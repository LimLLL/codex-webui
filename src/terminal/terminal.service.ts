/**
 * Manages shared node-pty terminal sessions.
 *
 * Terminals are grouped by context (`global` or `thread:<threadId>`). Multiple
 * authenticated sockets may attach to the same terminal, while the service keeps
 * a headless xterm mirror as the authoritative VT state for reconnection and
 * download snapshots.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { basename } from 'node:path';
import { FilesService } from '../files/files.service';
import {
  isTerminalSettingKey,
  TERMINAL_SETTING_DEFAULTS,
  TERMINAL_SETTING_KEYS,
} from '../settings/settings.definitions';
import { SettingsService } from '../settings/settings.service';
import type {
  TerminalClosedEvent,
  TerminalConfig,
  TerminalExitEvent,
  TerminalMetadata,
  TerminalMetadataEvent,
  TerminalOpenParams,
  TerminalOutputEvent,
  TerminalStatus,
} from './terminal.types';

const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
  maxSessions: TERMINAL_SETTING_DEFAULTS.maxSessions,
  graceMs: TERMINAL_SETTING_DEFAULTS.graceMs,
  scrollback: TERMINAL_SETTING_DEFAULTS.scrollback,
  defaultCwd: null,
};
const MIN_COLS = 20;
const MAX_COLS = 300;
const MIN_ROWS = 5;
const MAX_ROWS = 120;
const MAX_TITLE_LENGTH = 80;
const MAX_INPUT_BYTES = 1024 * 1024;

type TerminalEventName = 'output' | 'metadata' | 'exit' | 'closed';

interface TerminalSession {
  id: string;
  contextKey: string;
  process: pty.IPty;
  headless: HeadlessTerminal;
  serializeAddon: SerializeAddon;
  attachedSocketIds: Set<string>;
  title: string;
  cwd: string;
  shell: string;
  status: TerminalStatus;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
  createdAt: string;
  graceTimer: NodeJS.Timeout | null;
  headlessWriteQueue: Promise<void>;
  closed: boolean;
}

@Injectable()
export class TerminalService implements OnModuleDestroy {
  private readonly logger = new Logger(TerminalService.name);
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly events = new EventEmitter();
  private config: TerminalConfig = { ...DEFAULT_TERMINAL_CONFIG };
  private unregisterSettingsChange: (() => void) | null = null;

  constructor(
    private readonly filesService: FilesService,
    private readonly settingsService: SettingsService,
  ) {
    this.config = this.loadConfig();
    this.unregisterSettingsChange = this.settingsService.onChange((event) => {
      if (!isTerminalSettingKey(event.key)) return;
      this.config = this.loadConfig();
      this.logger.log(
        'Terminal config updated; changes apply to new terminals and future detach timers.',
      );
    });
    this.events.setMaxListeners(20);
  }

  onModuleDestroy(): void {
    for (const session of this.sessions.values()) {
      this.cleanupSession(session, 'module destroy');
    }
    this.sessions.clear();
    if (this.unregisterSettingsChange) {
      this.unregisterSettingsChange();
      this.unregisterSettingsChange = null;
    }
    this.events.removeAllListeners();
  }

  /** Returns terminal runtime limits derived from settings/env/defaults. */
  getConfig(): TerminalConfig {
    return { ...this.config };
  }

  /** Registers a listener for PTY output events. */
  onOutput(listener: (event: TerminalOutputEvent) => void): () => void {
    return this.registerListener('output', listener);
  }

  /** Registers a listener for terminal metadata changes. */
  onMetadata(listener: (event: TerminalMetadataEvent) => void): () => void {
    return this.registerListener('metadata', listener);
  }

  /** Registers a listener for PTY exit events. */
  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    return this.registerListener('exit', listener);
  }

  /** Registers a listener for terminal close/delete events. */
  onClosed(listener: (event: TerminalClosedEvent) => void): () => void {
    return this.registerListener('closed', listener);
  }

  /** Lists terminal metadata for a single context. */
  list(contextKey: string): TerminalMetadata[] {
    const normalizedContext = this.normalizeContextKey(contextKey);
    return Array.from(this.sessions.values())
      .filter((session) => session.contextKey === normalizedContext)
      .map((session) => this.toMetadata(session));
  }

  /** Opens a new shared terminal and attaches the requesting socket. */
  async open(
    socketId: string,
    params: TerminalOpenParams,
  ): Promise<TerminalMetadata> {
    if (this.sessions.size >= this.config.maxSessions) {
      throw new BadRequestException(
        `Maximum terminal sessions reached (${this.config.maxSessions})`,
      );
    }

    const contextKey = this.normalizeContextKey(params.contextKey);
    const cols = this.clampDimension(params.cols, MIN_COLS, MAX_COLS, 80);
    const rows = this.clampDimension(params.rows, MIN_ROWS, MAX_ROWS, 24);
    const shell = this.resolveShell();
    const cwd = await this.resolveTerminalCwd(contextKey, params.cwd);

    this.logger.log(`Spawning shell: ${shell}, cwd: ${cwd}`);

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env },
    });

    const headless = new HeadlessTerminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: this.config.scrollback,
    });
    const serializeAddon = new SerializeAddon();
    headless.loadAddon(serializeAddon);

    const session: TerminalSession = {
      id: randomUUID(),
      contextKey,
      process: proc,
      headless,
      serializeAddon,
      attachedSocketIds: new Set([socketId]),
      title: this.normalizeTitle(params.title, basename(shell)),
      cwd,
      shell: basename(shell),
      status: 'running',
      exitCode: null,
      signal: null,
      cols,
      rows,
      createdAt: new Date().toISOString(),
      graceTimer: null,
      headlessWriteQueue: Promise.resolve(),
      closed: false,
    };

    this.sessions.set(session.id, session);
    proc.onData((output) => this.mirrorAndBroadcast(session.id, output));
    proc.onExit(({ exitCode, signal }) => {
      this.handleExit(session.id, exitCode, signal ?? null);
    });

    this.logger.log(
      `Opened terminal ${session.id} (pid ${proc.pid}, cwd: ${cwd})`,
    );
    this.emitMetadata(session);
    return this.toMetadata(session);
  }

  /** Attaches a socket to an existing terminal and returns serialized VT state. */
  async reconnect(
    socketId: string,
    contextKey: string,
    terminalId: string,
  ): Promise<{ terminal: TerminalMetadata; state: string }> {
    const session = this.getContextSession(contextKey, terminalId);
    this.attachSocket(session, socketId);
    const state = await this.serializeState(session);
    return { terminal: this.toMetadata(session), state };
  }

  /** Detaches a socket from one terminal, or every terminal if no id is passed. */
  detach(socketId: string, terminalId?: string): void {
    for (const session of this.sessions.values()) {
      if (terminalId && session.id !== terminalId) continue;
      this.detachFromSession(session, socketId);
    }
  }

  /** Writes input from an attached socket to a terminal. */
  write(
    socketId: string,
    contextKey: string,
    terminalId: string,
    data: string,
  ): void {
    const session = this.getAttachedSession(socketId, contextKey, terminalId);
    if (session.status !== 'running') {
      throw new BadRequestException('Terminal process has exited');
    }
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) {
      throw new BadRequestException('Terminal input is too large');
    }
    session.process.write(data);
  }

  /** Resizes a terminal from any attached socket. Last resize wins. */
  resize(
    socketId: string,
    contextKey: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): TerminalMetadata {
    const session = this.getAttachedSession(socketId, contextKey, terminalId);
    const nextCols = this.clampDimension(
      cols,
      MIN_COLS,
      MAX_COLS,
      session.cols,
    );
    const nextRows = this.clampDimension(
      rows,
      MIN_ROWS,
      MAX_ROWS,
      session.rows,
    );

    if (nextCols === session.cols && nextRows === session.rows) {
      return this.toMetadata(session);
    }

    session.cols = nextCols;
    session.rows = nextRows;
    if (session.status === 'running') {
      session.process.resize(nextCols, nextRows);
    }
    session.headless.resize(nextCols, nextRows);
    this.emitMetadata(session);
    return this.toMetadata(session);
  }

  /** Renames a terminal tab shared by all attached clients. */
  rename(
    socketId: string,
    contextKey: string,
    terminalId: string,
    title: string,
  ): TerminalMetadata {
    const session = this.getAttachedSession(socketId, contextKey, terminalId);
    session.title = this.normalizeTitle(title, session.shell);
    this.emitMetadata(session);
    return this.toMetadata(session);
  }

  /** Returns a plain-text snapshot of the active headless terminal buffer. */
  async download(
    socketId: string,
    contextKey: string,
    terminalId: string,
  ): Promise<{ filename: string; content: string }> {
    const session = this.getAttachedSession(socketId, contextKey, terminalId);
    await this.flushHeadless(session);
    const content = this.readActiveBuffer(session.headless);
    const safeTitle = session.title
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-|-$/g, '');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return {
      filename: `${safeTitle || 'terminal'}-${timestamp}.txt`,
      content,
    };
  }

  /** Explicitly closes a terminal tab and kills the PTY for every attached socket. */
  close(socketId: string, contextKey: string, terminalId: string): boolean {
    const session = this.getAttachedSession(socketId, contextKey, terminalId);
    const socketIds = Array.from(session.attachedSocketIds);
    const context = session.contextKey;
    this.cleanupSession(session, 'explicit close');
    this.sessions.delete(terminalId);
    this.events.emit('closed', {
      terminalId,
      contextKey: context,
      socketIds,
    } satisfies TerminalClosedEvent);
    this.logger.log(`Closed terminal ${terminalId}`);
    return true;
  }

  private registerListener<T>(
    eventName: TerminalEventName,
    listener: (event: T) => void,
  ): () => void {
    this.events.on(eventName, listener);
    return () => this.events.off(eventName, listener);
  }

  /** Builds terminal config from runtime settings (DB > env > default). */
  private loadConfig(): TerminalConfig {
    return {
      maxSessions: this.settingsService.getNumberSetting(
        TERMINAL_SETTING_KEYS.maxSessions,
      ),
      graceMs: this.settingsService.getNumberSetting(
        TERMINAL_SETTING_KEYS.graceMs,
      ),
      scrollback: this.settingsService.getNumberSetting(
        TERMINAL_SETTING_KEYS.scrollback,
      ),
      defaultCwd: this.settingsService.getStringSetting(
        TERMINAL_SETTING_KEYS.defaultCwd,
      ),
    };
  }

  private resolveShell(): string {
    if (process.env.SHELL) return process.env.SHELL;
    const platform = os.platform();
    if (platform === 'win32') return 'powershell.exe';
    if (platform === 'darwin') return '/bin/zsh';
    if (platform === 'linux') return '/bin/bash';
    return 'sh';
  }

  private normalizeContextKey(contextKey: string): string {
    const value = contextKey.trim();
    if (value === 'global') return value;
    if (value.startsWith('thread:') && value.length > 'thread:'.length) {
      return value;
    }
    throw new BadRequestException('contextKey must be global or thread:<id>');
  }

  private normalizeTitle(value: string | undefined, fallback: string): string {
    const title = value?.trim() ?? '';
    if (!title) return fallback;
    return title.slice(0, MAX_TITLE_LENGTH);
  }

  private clampDimension(
    value: number | undefined,
    min: number,
    max: number,
    fallback: number,
  ): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
  }

  private async resolveTerminalCwd(
    contextKey: string,
    requestedCwd: string | undefined,
  ): Promise<string> {
    if (this.config.defaultCwd) {
      try {
        return await this.resolveDirectory(this.config.defaultCwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BadRequestException(
          `DEFAULT_TERMINAL_CWD is invalid or outside workspace roots: ${message}`,
        );
      }
    }

    if (contextKey.startsWith('thread:')) {
      if (!requestedCwd?.trim()) {
        throw new BadRequestException('Thread terminal cwd is required');
      }
      return this.resolveDirectory(requestedCwd);
    }

    return this.resolveDirectory(this.filesService.getHomeDir());
  }

  private async resolveDirectory(inputPath: string): Promise<string> {
    const safeCwd = await this.filesService.resolveSafePath(inputPath);
    if (fs.existsSync(safeCwd) && fs.statSync(safeCwd).isDirectory()) {
      return safeCwd;
    }
    throw new ForbiddenException('Terminal cwd must be an existing directory');
  }

  private attachSocket(session: TerminalSession, socketId: string): void {
    if (session.closed) {
      throw new BadRequestException('Terminal is closed');
    }
    if (session.graceTimer) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }
    session.attachedSocketIds.add(socketId);
    this.emitMetadata(session);
  }

  private detachFromSession(session: TerminalSession, socketId: string): void {
    if (!session.attachedSocketIds.delete(socketId)) return;
    this.emitMetadata(session);
    if (session.attachedSocketIds.size === 0) {
      this.startGraceTimer(session);
    }
  }

  private startGraceTimer(session: TerminalSession): void {
    if (session.graceTimer || session.closed) return;
    session.graceTimer = setTimeout(() => {
      const current = this.sessions.get(session.id);
      if (!current || current.attachedSocketIds.size > 0) return;
      this.cleanupSession(current, 'reconnect grace expired');
      this.sessions.delete(current.id);
      this.events.emit('closed', {
        terminalId: current.id,
        contextKey: current.contextKey,
        socketIds: [],
      } satisfies TerminalClosedEvent);
      this.logger.log(`Expired detached terminal ${current.id}`);
    }, this.config.graceMs);
    this.logger.debug(
      `Terminal ${session.id} detached; cleanup in ${this.config.graceMs}ms`,
    );
  }

  private getContextSession(
    contextKey: string,
    terminalId: string,
  ): TerminalSession {
    const normalizedContext = this.normalizeContextKey(contextKey);
    const session = this.sessions.get(terminalId);
    if (!session) throw new BadRequestException('Terminal not found');
    if (session.contextKey !== normalizedContext) {
      throw new ForbiddenException('Terminal context mismatch');
    }
    return session;
  }

  private getAttachedSession(
    socketId: string,
    contextKey: string,
    terminalId: string,
  ): TerminalSession {
    const session = this.getContextSession(contextKey, terminalId);
    if (!session.attachedSocketIds.has(socketId)) {
      throw new ForbiddenException('Socket is not attached to this terminal');
    }
    return session;
  }

  private mirrorAndBroadcast(terminalId: string, output: string): void {
    const session = this.sessions.get(terminalId);
    if (!session || session.closed) return;

    // Broadcast output immediately for real-time UX
    this.events.emit('output', {
      terminalId,
      data: output,
      socketIds: Array.from(session.attachedSocketIds),
    } satisfies TerminalOutputEvent);

    // Write to headless mirror asynchronously (for reconnection/download state)
    session.headlessWriteQueue = session.headlessWriteQueue
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            session.headless.write(output, () => resolve());
          }),
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to mirror terminal output: ${message}`);
      });
  }

  private handleExit(
    terminalId: string,
    exitCode: number,
    signal: number | null,
  ): void {
    const session = this.sessions.get(terminalId);
    if (!session || session.closed) return;
    session.status = 'exited';
    session.exitCode = exitCode;
    session.signal = signal;
    const event = {
      terminal: this.toMetadata(session),
      socketIds: Array.from(session.attachedSocketIds),
    } satisfies TerminalExitEvent;
    this.events.emit('exit', event);
    this.emitMetadata(session);
    if (session.attachedSocketIds.size === 0) {
      this.startGraceTimer(session);
    }
  }

  private emitMetadata(session: TerminalSession): void {
    this.events.emit('metadata', {
      terminal: this.toMetadata(session),
      socketIds: Array.from(session.attachedSocketIds),
    } satisfies TerminalMetadataEvent);
  }

  private async serializeState(session: TerminalSession): Promise<string> {
    await this.flushHeadless(session);
    return session.serializeAddon.serialize();
  }

  private async flushHeadless(session: TerminalSession): Promise<void> {
    await session.headlessWriteQueue.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to flush terminal state: ${message}`);
    });
  }

  private readActiveBuffer(headless: HeadlessTerminal): string {
    const lines: string[] = [];
    const buffer = headless.buffer.active;
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  }

  private cleanupSession(session: TerminalSession, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = null;
    try {
      if (session.status === 'running') session.process.kill();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to kill terminal ${session.id}: ${message}`);
    }
    session.headless.dispose();
    session.attachedSocketIds.clear();
    this.logger.debug(`Cleaned up terminal ${session.id}: ${reason}`);
  }

  private toMetadata(session: TerminalSession): TerminalMetadata {
    return {
      id: session.id,
      contextKey: session.contextKey,
      title: session.title,
      cwd: session.cwd,
      shell: session.shell,
      status: session.status,
      exitCode: session.exitCode,
      signal: session.signal,
      attachedCount: session.attachedSocketIds.size,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
    };
  }
}
