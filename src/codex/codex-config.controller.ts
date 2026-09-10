/**
 * REST controller for Codex app-server config management.
 *
 * Provides structured config editing (curated allowlist via config/batchWrite)
 * and raw config.toml file editing for power users.
 */
import { Body, Controller, Get, Logger, Patch, Put } from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { mkdirSync } from 'node:fs';
import { CatalogStorageService } from './catalog/catalog-storage.service';
import { CatalogService } from './catalog/catalog.service';
import { catalogPointer, readToml, writeAtomic } from './catalog/catalog-files';
import { CodexProcessManager } from './codex-process-manager.service';
import { toJsonSafe, type JsonSafeValue } from '../common/json-safe';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import { CodexRpcError } from './codex-errors';
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
    private readonly storage: CatalogStorageService,
    private readonly catalogs: CatalogService,
    private readonly manager: CodexProcessManager,
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
    try {
      await this.codex.request('config/batchWrite', {
        edits,
        reloadUserConfig: true,
      } satisfies v2.ConfigBatchWriteParams);
    } catch (error) {
      this.translateConfigWriteError(error, edits);
      throw error;
    }
    this.codexStatusService.invalidateCache();

    const result = await this.readConfig();
    result.warnings = await this.catalogs.configWarnings(result.config);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Raw config.toml endpoints
  // ---------------------------------------------------------------------------

  /** Reads the raw user-level config.toml content for Monaco editing. */
  @Get('raw')
  @ApiOperation({ summary: 'Read raw user config.toml' })
  @ApiOkResponse({ type: RawConfigResponseDto })
  readRawConfig(): RawConfigResponseDto {
    return {
      filePath: this.storage.paths.configFile,
      content: this.storage.config(),
    };
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
      throw BusinessException.badRequest(
        ErrorCode.codex.rawContentInvalid,
        'Raw config content must be a string',
      );
    }

    const filePath = this.storage.paths.configFile;
    const before = this.storage.config();
    if (body.expectedContent !== undefined && before !== body.expectedContent) {
      throw BusinessException.conflict(
        ErrorCode.codex.writeFailed,
        'Config changed; reload before saving',
      );
    }
    await this.catalogs.validateRawConfig(body.content);
    if (before !== this.storage.config())
      throw BusinessException.conflict(
        ErrorCode.codex.writeFailed,
        'Config changed during validation',
      );
    // Compared against what the child actually loaded, not against the previous
    // file. A pointer edited and then left alone still differs from the running
    // catalog, and diffing successive writes would report the second, unrelated
    // save as needing no restart while the child still serves the old list.
    const nextPointer = catalogPointer(body.content);
    const restartRequired =
      !this.manager.getClient() ||
      !this.storage.matchesRunningCatalog(nextPointer);
    this.manager.suspendRetries();
    mkdirSync(this.storage.paths.home, { recursive: true });
    writeAtomic(filePath, body.content);
    let reloaded = false;
    if (this.manager.getClient() && !restartRequired) {
      await this.codex.request('config/batchWrite', {
        edits: [],
        reloadUserConfig: true,
      } satisfies v2.ConfigBatchWriteParams);
      reloaded = true;
    }
    this.codexStatusService.invalidateCache();
    return {
      filePath,
      restartRequired,
      reloaded,
      warnings: await this.catalogs.configWarnings(readToml(body.content)),
    };
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
      throw BusinessException.badRequest(
        ErrorCode.codex.editsNotArray,
        'Config edits must be an array',
      );
    }

    return body.edits.map((edit, index) => {
      if (!edit || typeof edit.keyPath !== 'string') {
        throw BusinessException.badRequest(
          ErrorCode.codex.editInvalid,
          `Invalid config edit at index ${index}`,
          { index },
        );
      }

      const keyPath = edit.keyPath.trim();
      if (!isCodexConfigEditableKey(keyPath)) {
        throw BusinessException.badRequest(
          ErrorCode.codex.keyUnsupported,
          `Unsupported config key: ${keyPath}`,
          { key: keyPath },
        );
      }

      if (!isJsonValue(edit.value)) {
        throw BusinessException.badRequest(
          ErrorCode.codex.valueInvalidJson,
          `Invalid JSON value for ${keyPath}`,
          { key: keyPath },
        );
      }

      return {
        keyPath,
        value: edit.value,
        mergeStrategy: 'replace',
      } satisfies v2.ConfigEdit;
    });
  }

  /**
   * Rewrites known app-server config validation refusals into field-level API errors.
   *
   * The app-server already validates enum/value content and returns a structured
   * discriminator. We translate the single-edit case into a field-scoped
   * BusinessException so the UI can anchor the refusal to the edited control.
   */
  private translateConfigWriteError(
    error: unknown,
    edits: v2.ConfigEdit[],
  ): void {
    if (!this.isConfigValidationError(error) || edits.length !== 1) {
      return;
    }

    const [edit] = edits;
    throw BusinessException.badRequest(
      ErrorCode.codex.valueInvalid,
      error.rpcMessage,
      { key: edit.keyPath },
    );
  }

  /** Checks whether an RPC error is the app-server's structured config validation refusal. */
  private isConfigValidationError(error: unknown): error is CodexRpcError {
    if (!(error instanceof CodexRpcError)) return false;
    const data = error.data;
    if (!data || typeof data !== 'object') return false;
    return (
      (data as Record<string, unknown>).config_write_error_code ===
      'configValidationError'
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
