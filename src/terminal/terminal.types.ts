/** Shared backend terminal event and metadata types. */

export type TerminalStatus = 'running' | 'exited';

export interface TerminalConfig {
  maxSessions: number;
  graceMs: number;
  scrollback: number;
  defaultCwd: string | null;
}

export interface TerminalMetadata {
  /** Stable identity of the user's terminal; never reused after logical close. */
  id: string;
  /** Physical PTY identity, required for input and resize to reject stale packets. */
  sessionId: string;
  generation: number;
  contextKey: string;
  title: string;
  cwd: string;
  shell: string;
  status: TerminalStatus;
  exitCode: number | null;
  signal: number | null;
  attachedCount: number;
  cols: number;
  rows: number;
  createdAt: string;
}

export interface TerminalOpenParams {
  contextKey: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  title?: string;
}

export interface TerminalOutputEvent {
  terminalId: string;
  sessionId: string;
  sequence: number;
  data: string;
  socketIds: string[];
}

export interface TerminalMetadataEvent {
  terminal: TerminalMetadata;
  socketIds: string[];
}

export interface TerminalExitEvent {
  terminal: TerminalMetadata;
  socketIds: string[];
}

export interface TerminalClosedEvent {
  terminalId: string;
  contextKey: string;
  socketIds: string[];
}

/* ── Gateway DTO types ── */

export interface TerminalContextDto {
  contextKey: string;
}

export interface TerminalIdDto {
  contextKey: string;
  terminalId: string;
}

export interface TerminalDetachDto {
  terminalId?: string;
}

export interface TerminalInputDto {
  contextKey: string;
  terminalId: string;
  sessionId: string;
  data: string;
}

export interface TerminalResizeDto {
  contextKey: string;
  terminalId: string;
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalRenameDto {
  contextKey: string;
  terminalId: string;
  title: string;
}

export interface TerminalAck<T = unknown> {
  ok: boolean;
  error?: string;
  errorCode?: string;
  params?: Record<string, string | number>;
  terminal?: TerminalMetadata;
  terminals?: TerminalMetadata[];
  state?: string;
  sequence?: number;
  config?: TerminalConfig;
  data?: T;
}

/** Only an explicitly presented terminal may request creation through this endpoint. */
export interface TerminalRecoverDto extends TerminalIdDto {
  manual: boolean;
}

/** Exact snapshot boundary permits clients to discard already replayed live output. */
export interface TerminalAttachment {
  terminal: TerminalMetadata;
  state: string;
  sequence: number;
}
