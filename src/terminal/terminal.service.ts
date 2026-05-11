/**
 * Manages node-pty terminal sessions.
 * Each session is identified by a UUID and tied to a Socket.IO client.
 */
import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { FilesService } from '../files/files.service';

export interface TerminalSession {
  id: string;
  process: pty.IPty;
  clientId: string;
}

@Injectable()
export class TerminalService implements OnModuleDestroy {
  private readonly logger = new Logger(TerminalService.name);
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly filesService: FilesService) {}

  onModuleDestroy(): void {
    for (const session of this.sessions.values()) {
      session.process.kill();
    }
    this.sessions.clear();
  }

  /**
   * Opens a new PTY session with workspace-root-validated cwd.
   *
   * @param clientId - Socket.IO client ID that owns this session
   * @param cwd - Working directory for the shell
   * @param cols - Terminal columns
   * @param rows - Terminal rows
   * @returns The terminal session
   */
  async open(
    clientId: string,
    cwd: string,
    cols: number,
    rows: number,
  ): Promise<TerminalSession> {
    let shell = process.env.SHELL;
    if (!shell) {
      const platform = os.platform();
      if (platform === 'win32') shell = 'powershell.exe';
      else if (platform === 'darwin') shell = '/bin/zsh';
      else if (platform === 'linux') shell = '/bin/bash';
      else shell = 'sh';
    }

    const safeCwd = await this.resolveTerminalCwd(cwd);

    this.logger.log(`Spawning shell: ${shell}, cwd: ${safeCwd}`);

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: safeCwd,
      env: { ...process.env },
    });

    const session: TerminalSession = {
      id: randomUUID(),
      process: proc,
      clientId,
    };

    this.sessions.set(session.id, session);
    this.logger.log(
      `Opened terminal ${session.id} (pid ${proc.pid}, cwd: ${safeCwd})`,
    );

    return session;
  }

  /**
   * Writes data to a terminal session owned by the given client.
   *
   * @param clientId - Socket.IO client ID
   * @param terminalId - The terminal session ID
   * @param data - Data to write (keystrokes)
   */
  write(clientId: string, terminalId: string, data: string): boolean {
    const session = this.getOwnedSession(clientId, terminalId);
    if (!session) return false;
    session.process.write(data);
    return true;
  }

  /**
   * Resizes a terminal session owned by the given client.
   *
   * @param clientId - Socket.IO client ID
   * @param terminalId - The terminal session ID
   * @param cols - New column count
   * @param rows - New row count
   */
  resize(
    clientId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): boolean {
    const session = this.getOwnedSession(clientId, terminalId);
    if (!session) return false;
    session.process.resize(cols, rows);
    return true;
  }

  /**
   * Closes and cleans up a terminal session owned by the given client.
   *
   * @param clientId - Socket.IO client ID
   * @param terminalId - The terminal session ID
   */
  close(clientId: string, terminalId: string): boolean {
    const session = this.getOwnedSession(clientId, terminalId);
    if (!session) return false;
    session.process.kill();
    this.sessions.delete(terminalId);
    this.logger.log(`Closed terminal ${terminalId}`);
    return true;
  }

  /**
   * Closes all terminal sessions owned by a specific client.
   *
   * @param clientId - The Socket.IO client ID
   */
  closeByClient(clientId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.clientId === clientId) {
        session.process.kill();
        this.sessions.delete(id);
        this.logger.log(`Cleaned up terminal ${id} for client ${clientId}`);
      }
    }
  }

  getSession(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  /** Returns the session only if owned by the given client. */
  private getOwnedSession(
    clientId: string,
    terminalId: string,
  ): TerminalSession | undefined {
    const session = this.sessions.get(terminalId);
    if (!session || session.clientId !== clientId) return undefined;
    return session;
  }

  /** Resolves cwd through workspace root validation, falling back to home dir. */
  private async resolveTerminalCwd(cwd: string): Promise<string> {
    try {
      const safeCwd = await this.filesService.resolveSafePath(cwd);
      if (fs.existsSync(safeCwd) && fs.statSync(safeCwd).isDirectory()) {
        return safeCwd;
      }
    } catch {
      // fall through to home directory
    }

    try {
      const home = await this.filesService.resolveSafePath(os.homedir());
      if (fs.existsSync(home) && fs.statSync(home).isDirectory()) {
        return home;
      }
    } catch {
      // handled below
    }

    throw new ForbiddenException(
      'Terminal cwd outside allowed workspace roots',
    );
  }
}
