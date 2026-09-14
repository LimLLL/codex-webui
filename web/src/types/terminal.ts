/** Shared frontend terminal socket types. */

export type TerminalStatus = 'running' | 'exited' | 'expired' | 'closed';

export interface TerminalConfig {
  maxSessions: number;
  graceMs: number;
  scrollback: number;
  defaultCwd: string | null;
}

export interface TerminalMetadata {
  id: string;
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
  error?: string | null;
  errorCode?: string | null;
}

export interface TerminalContextState {
  terminalIds: string[];
  activeTerminalId: string | null;
  hydrated: boolean;
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

/** Output is scoped to a physical shell and ordered relative to attachment snapshots. */
export interface TerminalOutput {
  terminalId: string;
  sessionId: string;
  sequence: number;
  data: string;
}

export interface TerminalDownloadPayload {
  filename: string;
  content: string;
}
