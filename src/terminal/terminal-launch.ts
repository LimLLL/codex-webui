/** Shared launch selection: explicit context directories precede global defaults. */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import type { SettingsService } from '../settings/settings.service';
import { TERMINAL_SETTING_KEYS } from '../settings/settings.definitions';
import type { TerminalConfig } from './terminal.types';
import type { FilesService } from '../files/files.service';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';

/** Validates the context before consulting either runtime sessions or durable records. */
export function normalizeTerminalContext(contextKey: string): string {
  const value = typeof contextKey === 'string' ? contextKey.trim() : '';
  if (value === 'global' || (value.startsWith('thread:') && value.length > 7))
    return value;
  throw BusinessException.badRequest(
    ErrorCode.terminal.invalidContext,
    'contextKey must be global or thread:<id>',
  );
}

/** Resolves a new terminal's executable once; durable records retain the full launch value. */
export function resolveTerminalShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (os.platform() === 'win32') return 'powershell.exe';
  if (os.platform() === 'darwin') return '/bin/zsh';
  return '/bin/bash';
}

/** Clamps physical dimensions, keeping hidden views from supplying invalid PTY sizes. */
export function terminalDimension(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(max, Math.max(min, Math.floor(value)));
}

/** Normalizes user-controlled shared labels without changing the launch executable. */
export function terminalTitle(
  title: string | undefined,
  fallback: string,
): string {
  return title?.trim().slice(0, 80) || fallback;
}

/**
 * Selects exactly one directory, then validates it without a fallback on failure.
 * Conversation callers must supply their cwd. Replacement supplies its recorded
 * launch cwd through the same explicit-directory branch, including global terminals.
 */
export async function resolveTerminalDirectory(
  files: FilesService,
  context: string,
  requested: string | undefined,
  defaultCwd: string | null,
): Promise<string> {
  if (requested !== undefined && typeof requested !== 'string') {
    throw BusinessException.badRequest(
      ErrorCode.terminal.invalidCwd,
      'Explicit terminal cwd must be a string',
    );
  }
  if (requested === undefined && context.startsWith('thread:')) {
    throw BusinessException.badRequest(
      ErrorCode.terminal.cwdRequired,
      'Thread terminal cwd is required',
    );
  }
  const selected = requested ?? defaultCwd ?? files.getHomeDir();
  if (typeof selected !== 'string' || !selected.trim()) {
    throw BusinessException.badRequest(
      ErrorCode.terminal.cwdRequired,
      'Terminal cwd must not be empty',
    );
  }
  const cwd = await files.resolveSafePath(selected);
  if (!(await fs.stat(cwd)).isDirectory()) {
    throw BusinessException.badRequest(
      ErrorCode.terminal.cwdNotDirectory,
      'Terminal cwd must be an existing directory',
    );
  }
  return cwd;
}

/** Reads settings through the existing DB/environment/default priority chain. */
export function readTerminalConfig(settings: SettingsService): TerminalConfig {
  return {
    maxSessions: settings.getNumberSetting(TERMINAL_SETTING_KEYS.maxSessions),
    graceMs: settings.getNumberSetting(TERMINAL_SETTING_KEYS.graceMs),
    scrollback: settings.getNumberSetting(TERMINAL_SETTING_KEYS.scrollback),
    defaultCwd: settings.getStringSetting(TERMINAL_SETTING_KEYS.defaultCwd),
  };
}
/** Refuses legacy or malformed writes that cannot identify their physical shell. */
export function requireTerminalSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || !sessionId)
    throw BusinessException.conflict(
      ErrorCode.terminal.staleSession,
      'A physical terminal session id is required',
    );
}

/** Rejects physical attachment/allocation when its connection or server owner has ended. */
export function requireTerminalConnection(connected: boolean): void {
  if (!connected)
    throw BusinessException.conflict(
      ErrorCode.terminal.disconnected,
      'Terminal client disconnected',
    );
}

/** Checks allocation at the synchronous spawn boundary, including unpublished processes awaiting cleanup. */
export function assertTerminalCapacity(
  sessionCount: number,
  maxSessions: number,
): void {
  if (sessionCount >= maxSessions)
    throw BusinessException.badRequest(
      ErrorCode.terminal.maxSessionsReached,
      `Maximum terminal sessions reached (${maxSessions})`,
      { max: maxSessions },
    );
}
