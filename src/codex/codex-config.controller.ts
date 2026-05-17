/**
 * REST controller for Codex app-server config management.
 *
 * Provides structured config editing (curated allowlist via config/batchWrite)
 * and raw config.toml file editing for power users.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Patch,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { toJsonSafe, type JsonSafeValue } from '../common/json-safe';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { CodexStatusService } from './codex-status.service';
import { CodexService } from './codex.service';
import type { v2 } from './codex-schema';
import type { JsonValue } from './codex-schema/serde_json/JsonValue';
import {
  CodexConfigResponseDto,
  isCodexConfigEditableKey,
  RawConfigResponseDto,
  RawConfigWriteResponseDto,
  UpdateCodexConfigDto,
  UpdateRawConfigDto,
} from './dto/codex-config.dto';

type JsonRecord = Record<string, JsonSafeValue>;

/** Pattern matching sensitive key names that should be redacted in API output. */
const SENSITIVE_KEY_RE = /(?:token|password|api[_-]?key|secret|authorization)/i;

@ApiTags('codex')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@Controller('codex/config')
export class CodexConfigController {
  private readonly logger = new Logger(CodexConfigController.name);

  constructor(
    private readonly codex: CodexService,
    private readonly codexStatusService: CodexStatusService,
  ) {}

  // ---------------------------------------------------------------------------
  // Structured config endpoints
  // ---------------------------------------------------------------------------

  /** Returns the effective Codex config and origin metadata with secrets redacted. */
  @Get()
  @ApiOperation({ summary: 'Read Codex config with origin metadata' })
  @ApiOkResponse({ type: CodexConfigResponseDto })
  async readConfig(): Promise<CodexConfigResponseDto> {
    const response = await this.readConfigFromAppServer();
    return {
      config: redactSecrets(toJsonSafe(response.config)) as JsonRecord,
      origins: redactSecrets(toJsonSafe(response.origins)) as JsonRecord,
    };
  }

  /** Writes curated Codex config keys to user config.toml and hot-reloads. */
  @Patch()
  @ApiOperation({ summary: 'Update curated Codex config fields' })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiOkResponse({ type: CodexConfigResponseDto })
  async updateConfig(
    @Body() body: UpdateCodexConfigDto,
  ): Promise<CodexConfigResponseDto> {
    const edits = this.validateEdits(body);

    this.logger.log(
      `Updating ${edits.length} config field(s): ${edits.map((e) => e.keyPath).join(', ')}`,
    );
    await this.codex.request('config/batchWrite', {
      edits,
      reloadUserConfig: true,
    } satisfies v2.ConfigBatchWriteParams);
    this.codexStatusService.invalidateCache();

    return this.readConfig();
  }

  // ---------------------------------------------------------------------------
  // Raw config.toml endpoints
  // ---------------------------------------------------------------------------

  /** Reads the raw user-level config.toml content for Monaco editing. */
  @Get('raw')
  @ApiOperation({ summary: 'Read raw user config.toml' })
  @ApiOkResponse({ type: RawConfigResponseDto })
  async readRawConfig(): Promise<RawConfigResponseDto> {
    const filePath = await this.getUserConfigPath();
    if (!existsSync(filePath)) {
      return { filePath, content: '' };
    }
    return { filePath, content: readFileSync(filePath, 'utf8') };
  }

  /** Replaces raw user config.toml content and hot-reloads into loaded threads. */
  @Put('raw')
  @ApiOperation({
    summary: 'Write raw user config.toml and reload Codex config',
  })
  @ApiBadRequestResponse({ type: ApiErrorResponseDto })
  @ApiOkResponse({ type: RawConfigWriteResponseDto })
  async updateRawConfig(
    @Body() body: UpdateRawConfigDto,
  ): Promise<RawConfigWriteResponseDto> {
    if (!body || typeof body.content !== 'string') {
      throw new BadRequestException('Raw config content must be a string');
    }

    const filePath = await this.getUserConfigPath();

    this.logger.log(`Writing raw config.toml (${body.content.length} bytes)`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body.content, 'utf8');

    // Trigger hot-reload with an empty edit batch
    await this.codex.request('config/batchWrite', {
      edits: [],
      reloadUserConfig: true,
    } satisfies v2.ConfigBatchWriteParams);
    this.codexStatusService.invalidateCache();

    return { filePath };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async readConfigFromAppServer(): Promise<v2.ConfigReadResponse> {
    return this.codex.request<v2.ConfigReadResponse>('config/read', {
      includeLayers: true,
    } satisfies v2.ConfigReadParams);
  }

  /** Validates and normalizes incoming config edits against the allowlist. */
  private validateEdits(body: UpdateCodexConfigDto): v2.ConfigEdit[] {
    if (!body || !Array.isArray(body.edits)) {
      throw new BadRequestException('Config edits must be an array');
    }

    return body.edits.map((edit, index) => {
      if (!edit || typeof edit.keyPath !== 'string') {
        throw new BadRequestException(`Invalid config edit at index ${index}`);
      }

      const keyPath = edit.keyPath.trim();
      if (!isCodexConfigEditableKey(keyPath)) {
        throw new BadRequestException(`Unsupported config key: ${keyPath}`);
      }

      // V1: null/clear semantics for config/batchWrite are unverified
      if (edit.value === null) {
        throw new BadRequestException(
          'Clearing config values is not supported',
        );
      }

      if (!isJsonValue(edit.value)) {
        throw new BadRequestException(`Invalid JSON value for ${keyPath}`);
      }

      return {
        keyPath,
        value: edit.value,
        mergeStrategy: 'replace',
      } satisfies v2.ConfigEdit;
    });
  }

  /**
   * Resolves the user-level config.toml path from config/read layers.
   * The user layer has `{ type: 'user', file: AbsolutePathBuf }`.
   */
  private async getUserConfigPath(): Promise<string> {
    const response = await this.readConfigFromAppServer();
    for (const layer of response.layers ?? []) {
      if (layer.name.type === 'user') {
        const { file } = layer.name as { file: string };
        if (typeof file === 'string' && file.trim()) return file;
      }
    }
    throw new InternalServerErrorException(
      'Codex user config.toml path was not reported by config/read',
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (not on the class to avoid method overhead)
// ---------------------------------------------------------------------------

/** Recursively redacts sensitive config values while preserving object shape. */
function redactSecrets(value: JsonSafeValue, parentKey = ''): JsonSafeValue {
  if (SENSITIVE_KEY_RE.test(parentKey) && value !== null) {
    return '[redacted]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, parentKey));
  }

  if (value && typeof value === 'object') {
    const result: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = redactSecrets(child, key);
    }
    return result;
  }

  return value;
}

/**
 * Validates that a value is safe JSON (no bigint, symbol, function, undefined).
 * Also guards against prototype pollution keys.
 */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).every(
      ([key, child]) =>
        typeof key === 'string' &&
        key !== '__proto__' &&
        key !== 'constructor' &&
        key !== 'prototype' &&
        isJsonValue(child),
    );
  }

  return false;
}
