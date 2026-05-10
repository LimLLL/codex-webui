/**
 * Manages node-pty terminal sessions.
 * Each session is identified by a UUID and tied to a Socket.IO client.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';

export interface TerminalSession {
  id: string;
  process: pty.IPty;
  clientId: string;
}

@Injectable()
export class TerminalService implements OnModuleDestroy {
  private readonly logger = new Logger(TerminalService.name);
  private readonly sessions = new Map<string, TerminalSession>();

  onModuleDestroy(): void {
    for (const session of this.sessions.values()) {
      session.process.kill();
    }
    this.sessions.clear();
  }

  /**
   * Opens a new PTY session.
   *
   * @param clientId - Socket.IO client ID that owns this session
   * @param cwd - Working directory for the shell
   * @param cols - Terminal columns
   * @param rows - Terminal rows
   * @returns The terminal session ID
   */
  open(
    clientId: string,
    cwd: string,
    cols: number,
    rows: number,
  ): TerminalSession {
    let shell = process.env.SHELL;
    if (!shell) {
      const platform = os.platform();
      if (platform === 'win32') shell = 'powershell.exe';
      else if (platform === 'darwin') shell = '/bin/zsh';
      else if (platform === 'linux') shell = '/bin/bash';
      else shell = 'sh';
    }

    // Fallback to home dir if cwd doesn't exist
    let safeCwd = cwd;
    try {
      if (!fs.existsSync(safeCwd) || !fs.statSync(safeCwd).isDirectory()) {
        safeCwd = os.homedir();
      }
    } catch {
      safeCwd = os.homedir();
    }

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
      `Opened terminal ${session.id} (pid ${proc.pid}, cwd: ${cwd})`,
    );

    return session;
  }

  /**
   * Writes data to a terminal session.
   *
   * @param terminalId - The terminal session ID
   * @param data - Data to write (keystrokes)
   */
  write(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.process.write(data);
    }
  }

  /**
   * Resizes a terminal session.
   *
   * @param terminalId - The terminal session ID
   * @param cols - New column count
   * @param rows - New row count
   */
  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.process.resize(cols, rows);
    }
  }

  /**
   * Closes and cleans up a terminal session.
   *
   * @param terminalId - The terminal session ID
   */
  close(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      session.process.kill();
      this.sessions.delete(terminalId);
      this.logger.log(`Closed terminal ${terminalId}`);
    }
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
}
