/** Reads structured application logs and builds sanitized diagnostic bundles. */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { CodexStatusService } from '../codex/codex-status.service';

const execFileAsync = promisify(execFile);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EXPORT_LIMIT = 100;
const MAX_ENTRIES_CAP = 10_000;
const LOG_DIR = join(process.cwd(), 'logs');
const LOG_FILE_PREFIX = 'app';
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|token|apikey|api_key|password|secret|credential)/i;

export interface LogEntry {
  timestamp: string;
  level: string;
  source: string;
  message: string;
  fields: Record<string, unknown>;
}

export interface LogsQuery {
  offset?: number | string;
  limit?: number | string;
  level?: string;
  source?: string;
}

export interface LogsResponse {
  data: LogEntry[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface LogsExportResponse {
  exportedAt: string;
  system: {
    nodeVersion: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
    codexVersion: string;
  };
  runtimeStatus: unknown;
  logs: LogEntry[];
}

@Injectable()
export class LogsService {
  private readonly logger = new Logger(LogsService.name);

  constructor(
    private readonly statusService: CodexStatusService,
    private readonly config: ConfigService,
  ) {}

  /** Returns paginated structured logs filtered by level and source. */
  async listLogs(query: LogsQuery): Promise<LogsResponse> {
    const offset = this.clampNumber(
      query.offset,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    );
    const limit = this.clampNumber(query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
    const level = this.normalizeFilter(query.level);
    const source = this.normalizeFilter(query.source);

    const entries = await this.readAllEntries();
    const filtered = entries.filter((entry) => {
      const levelMatches = !level || entry.level === level;
      const sourceMatches =
        !source || entry.source.toLowerCase().includes(source);
      return levelMatches && sourceMatches;
    });
    const page = filtered.slice(offset, offset + limit);

    return {
      data: page,
      offset,
      limit,
      total: filtered.length,
      hasMore: offset + limit < filtered.length,
    };
  }

  /** Builds a sanitized diagnostic bundle suitable for issue reports. */
  async exportDiagnostics(): Promise<LogsExportResponse> {
    const [{ data: logs }, runtimeStatus, codexVersion] = await Promise.all([
      this.listLogs({ offset: 0, limit: EXPORT_LIMIT }),
      this.statusService.getStatus(),
      this.getCodexVersion(),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptimeSeconds: Math.round(process.uptime()),
        codexVersion,
      },
      runtimeStatus: this.sanitizeValue(runtimeStatus),
      logs: logs.map((entry) => this.sanitizeEntry(entry)),
    };
  }

  private async readAllEntries(): Promise<LogEntry[]> {
    const files = this.getLogFiles();
    const entries: LogEntry[] = [];
    for (const file of files) {
      const remaining = MAX_ENTRIES_CAP - entries.length;
      if (remaining <= 0) break;
      entries.push(...(await this.readEntriesFromFile(file, remaining)));
    }
    return entries
      .slice(0, MAX_ENTRIES_CAP)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  private getLogFiles(): string[] {
    if (!existsSync(LOG_DIR)) return [];
    let dirEntries: string[];
    try {
      dirEntries = readdirSync(LOG_DIR);
    } catch {
      return [];
    }
    return dirEntries
      .filter(
        (file) =>
          file === LOG_FILE_PREFIX || file.startsWith(`${LOG_FILE_PREFIX}.`),
      )
      .flatMap((file) => {
        const path = join(LOG_DIR, file);
        try {
          return [{ path, mtimeMs: statSync(path).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((f) => f.path);
  }

  private async readEntriesFromFile(
    file: string,
    maxEntries: number,
  ): Promise<LogEntry[]> {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    const lines = content.split(/\r?\n/);
    const entries: LogEntry[] = [];

    // Read from tail so the most recent entries are captured first
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]?.trim();
      if (!trimmed) continue;
      const entry = this.parseLine(trimmed, file);
      if (entry) {
        entries.push(entry);
        if (entries.length >= maxEntries) break;
      }
    }

    return entries;
  }

  private parseLine(line: string, file: string): LogEntry | null {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const sanitized = this.sanitizeValue(record) as Record<string, unknown>;
      return {
        timestamp: this.toTimestamp(sanitized.time),
        level: this.toLevel(sanitized.level),
        source: this.toSource(sanitized, file),
        message: this.toMessage(sanitized),
        fields: sanitized,
      };
    } catch (err) {
      this.logger.debug(`Skipping unparsable log line: ${String(err)}`);
      return null;
    }
  }

  private sanitizeEntry(entry: LogEntry): LogEntry {
    return {
      ...entry,
      fields: this.sanitizeValue(entry.fields) as Record<string, unknown>,
    };
  }

  private sanitizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item));
    }

    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )) {
        result[key] = SENSITIVE_KEY_PATTERN.test(key)
          ? '[Redacted]'
          : this.sanitizeValue(child);
      }
      return result;
    }

    if (typeof value === 'string') {
      return value.replace(
        /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
        'Bearer [Redacted]',
      );
    }

    return value;
  }

  private toTimestamp(value: unknown): string {
    if (typeof value === 'number') return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    return new Date().toISOString();
  }

  private toLevel(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value !== 'number') return 'unknown';
    if (value >= 60) return 'fatal';
    if (value >= 50) return 'error';
    if (value >= 40) return 'warn';
    if (value >= 30) return 'info';
    if (value >= 20) return 'debug';
    if (value >= 10) return 'trace';
    return 'unknown';
  }

  private toSource(record: Record<string, unknown>, file: string): string {
    const context = record.context;
    if (typeof context === 'string') return context;
    const source = record.source;
    if (typeof source === 'string') return source;
    const name = record.name;
    if (typeof name === 'string') return name;
    return basename(file);
  }

  private toMessage(record: Record<string, unknown>): string {
    const msg = record.msg;
    if (typeof msg === 'string') return msg;
    const message = record.message;
    if (typeof message === 'string') return message;
    return '';
  }

  private clampNumber(
    value: number | string | undefined,
    min: number,
    max: number,
    fallback: number,
  ): number {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.trunc(parsed as number), min), max);
  }

  private normalizeFilter(value: string | undefined): string | null {
    const normalized = value?.trim().toLowerCase();
    return normalized ? normalized : null;
  }

  private async getCodexVersion(): Promise<string> {
    const bin = this.config.get<string>('CODEX_BIN') ?? 'codex';
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], {
        timeout: 2_000,
      });
      return stdout.trim() || 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
