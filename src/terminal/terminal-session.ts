/** Owns one disposable PTY and its headless buffer; no durable lifecycle decisions live here. */
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import * as pty from 'node-pty';
import { basename } from 'node:path';
import type { TerminalIdentity } from '../database/schema';
import type { TerminalMetadata } from './terminal.types';
import { terminalDimension } from './terminal-launch';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';

/** Physical resources are created once and never reused for a replacement shell. */
export class TerminalSession {
  readonly process: pty.IPty;
  readonly headless: HeadlessTerminal;
  readonly serializeAddon = new SerializeAddon();
  readonly attachedSocketIds = new Set<string>();
  readonly metadata: TerminalMetadata;
  graceTimer: NodeJS.Timeout | null = null;
  disposed = false;
  published = false;
  private writes: Promise<void> = Promise.resolve();
  private writeError: Error | null = null;
  private sequence = 0;
  private releaseWaiters!: () => void;
  private readonly disposedSignal = new Promise<void>((resolve) => {
    this.releaseWaiters = resolve;
  });

  constructor(
    identity: TerminalIdentity,
    cols: number,
    rows: number,
    scrollback: number,
  ) {
    this.metadata = {
      id: identity.id,
      sessionId: identity.sessionId,
      generation: identity.generation,
      contextKey: identity.contextKey,
      title: identity.title,
      cwd: identity.cwd,
      shell: basename(identity.shell),
      status: 'running',
      exitCode: null,
      signal: null,
      attachedCount: 0,
      cols,
      rows,
      createdAt: new Date().toISOString(),
    };
    this.headless = new HeadlessTerminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback,
    });
    this.headless.loadAddon(this.serializeAddon);
    try {
      this.process = pty.spawn(identity.shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: identity.cwd,
        env: { ...process.env },
      });
    } catch (error) {
      this.headless.dispose();
      throw error;
    }
  }

  /** Returns a copy so delayed acknowledgements cannot mutate a shared metadata object. */
  describe(): TerminalMetadata {
    return { ...this.metadata, attachedCount: this.attachedSocketIds.size };
  }

  /** A failed publication whose cleanup failed still owns a process, but must never be exposed or replaced. */
  assertPublished(): void {
    if (!this.published)
      throw BusinessException.internal(
        ErrorCode.terminal.cleanupFailed,
        'An unpublished terminal process could not be cleaned up',
      );
  }

  /** Validates the physical shell and socket ownership before input, resize or buffer operations. */
  requireAttachment(socketId: string, sessionId?: string): void {
    if (sessionId !== undefined && sessionId !== this.metadata.sessionId) {
      throw BusinessException.conflict(
        ErrorCode.terminal.staleSession,
        'Terminal input belongs to a previous shell',
      );
    }
    if (!this.attachedSocketIds.has(socketId))
      throw BusinessException.forbidden(
        ErrorCode.terminal.socketNotAttached,
        'Socket is not attached to this terminal',
      );
  }

  /**
   * Broadcasts only after mirroring each chunk. The sequence and serialized state
   * therefore describe the same boundary, including output arriving during attach.
   * A mirror failure is retained and surfaces on snapshot reads, never hidden.
   */
  mirror(
    data: string,
    publish: (sequence: number) => void,
    onError: (error: unknown) => void,
  ): void {
    this.writes = this.writes
      .then(async () => {
        if (this.disposed || this.writeError) return;
        await Promise.race([
          new Promise<void>((resolve) => this.headless.write(data, resolve)),
          this.disposedSignal,
        ]);
        if (!this.disposed) publish(++this.sequence);
      })
      .catch((error: unknown) => {
        this.writeError =
          error instanceof Error ? error : new Error(String(error));
        onError(error);
      });
  }

  /** Returns the complete VT state and the last output chunk represented by it. */
  async snapshot(): Promise<{ state: string; sequence: number }> {
    await Promise.race([this.writes, this.disposedSignal]);
    if (this.writeError) throw this.writeError;
    if (this.disposed) throw new Error('Terminal disposed during snapshot');
    return { state: this.serializeAddon.serialize(), sequence: this.sequence };
  }

  /** Exports the retained active buffer without adding another history store. */
  async download(): Promise<{ filename: string; content: string }> {
    await this.snapshot();
    const buffer = this.headless.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (line) lines.push(line.translateToString(true));
    }
    const title = this.metadata.title
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-|-$/g, '');
    return {
      content: lines.join('\n'),
      filename: `${title || 'terminal'}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
    };
  }

  /** Validates process liveness and input size after the service checks ownership. */
  write(data: string): void {
    if (this.metadata.status !== 'running')
      throw BusinessException.badRequest(
        ErrorCode.terminal.exited,
        'Terminal process has exited',
      );
    if (
      typeof data !== 'string' ||
      Buffer.byteLength(data, 'utf8') > 1024 * 1024
    ) {
      throw BusinessException.badRequest(
        ErrorCode.terminal.inputTooLarge,
        'Invalid or oversized terminal input',
      );
    }
    this.process.write(data);
  }

  /** Updates physical and mirrored dimensions together; reports whether metadata changed. */
  resize(cols: number, rows: number): boolean {
    const nextCols = terminalDimension(cols, 20, 300, this.metadata.cols);
    const nextRows = terminalDimension(rows, 5, 120, this.metadata.rows);
    if (nextCols === this.metadata.cols && nextRows === this.metadata.rows)
      return false;
    if (this.metadata.status === 'running')
      this.process.resize(nextCols, nextRows);
    this.headless.resize(nextCols, nextRows);
    this.metadata.cols = nextCols;
    this.metadata.rows = nextRows;
    return true;
  }

  /** Terminates a running process and releases its buffer; kill failures propagate to the owner. */
  dispose(): void {
    if (this.disposed) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (this.metadata.status === 'running') this.process.kill();
    this.disposed = true;
    // Disposal can discard xterm callbacks; do not strand pending snapshot callers.
    this.releaseWaiters();
    this.attachedSocketIds.clear();
    this.headless.dispose();
  }
}
