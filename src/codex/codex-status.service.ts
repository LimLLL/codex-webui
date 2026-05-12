/**
 * Aggregates Codex app-server readiness, account, config, provider, and model status.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CodexProcessManager } from './codex-process-manager.service';
import { CodexService } from './codex.service';
import type { v2 } from './codex-schema';

const READY_CACHE_TTL_MS = 30_000;
const UNAVAILABLE_CACHE_TTL_MS = 5_000;

const PROVIDER_ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
};

export type CodexRuntimeStatus = 'ready' | 'degraded' | 'unavailable';

export type JsonSafeValue =
  | string
  | number
  | boolean
  | null
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

export interface CodexStatusError {
  message: string;
  code?: string;
}

interface ProbeSuccess<T> {
  ok: true;
  data: T;
}

interface ProbeFailure {
  ok: false;
  error: CodexStatusError;
}

type ProbeResult<T> = ProbeSuccess<T> | ProbeFailure;

export interface CodexAppServerStatus {
  ok: boolean;
  connected: boolean;
  initialized: boolean;
  error?: CodexStatusError;
}

export interface CodexInitializeStatus {
  ok: boolean;
  data: JsonSafeValue | null;
  error?: CodexStatusError;
}

export interface CodexSectionStatus {
  ok: boolean;
  data?: JsonSafeValue;
  error?: CodexStatusError;
}

export interface CodexConfigSummary {
  sandboxMode: string | null;
  sandboxNetworkAccess: boolean | null;
  approvalPolicy: JsonSafeValue;
  model: string | null;
  modelProvider: string | null;
}

export interface CodexProviderStatus {
  ok: boolean;
  id: string | null;
  envKey: string | null;
  envPresent: boolean | null;
  error?: CodexStatusError;
}

export interface CodexModelsStatus {
  ok: boolean;
  listable: boolean;
  defaultModel: string | null;
  count: number;
  data?: JsonSafeValue;
  error?: CodexStatusError;
}

export interface CodexRuntimeStatusSection {
  status: CodexRuntimeStatus;
  reasons: string[];
  checkedAt: string;
  cacheTtlMs: number;
}

export interface CodexStatusResponse {
  appServer: CodexAppServerStatus;
  initialize: CodexInitializeStatus;
  account: CodexSectionStatus;
  config: CodexSectionStatus;
  provider: CodexProviderStatus;
  models: CodexModelsStatus;
  runtime: CodexRuntimeStatusSection;
}

interface CacheEntry {
  expiresAt: number;
  value: CodexStatusResponse;
}

@Injectable()
export class CodexStatusService {
  private readonly logger = new Logger(CodexStatusService.name);
  private cache: CacheEntry | null = null;
  private inFlight: Promise<CodexStatusResponse> | null = null;

  constructor(
    private readonly processManager: CodexProcessManager,
    private readonly codex: CodexService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns aggregated Codex status, using a short in-memory TTL cache.
   * Concurrent cache misses share a single in-flight probe batch.
   */
  async getStatus(): Promise<CodexStatusResponse> {
    const cached = this.getFreshCache();
    if (cached) return cached;

    if (this.inFlight) return this.inFlight;

    this.inFlight = this.refreshStatus();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /** Clears the status cache so the next query returns fresh data. */
  invalidateCache(): void {
    this.cache = null;
  }

  private getFreshCache(): CodexStatusResponse | null {
    if (!this.cache) return null;
    if (Date.now() >= this.cache.expiresAt) {
      this.cache = null;
      return null;
    }
    return this.cache.value;
  }

  private async refreshStatus(): Promise<CodexStatusResponse> {
    let value: CodexStatusResponse;
    try {
      value = await this.buildStatus();
    } catch (err) {
      value = this.buildUnexpectedFailureStatus(err);
    }

    this.cache = {
      value,
      expiresAt: Date.now() + value.runtime.cacheTtlMs,
    };
    return value;
  }

  private async buildStatus(): Promise<CodexStatusResponse> {
    const client = this.processManager.getClient();
    const initResult = this.processManager.getInitResult();
    const checkedAt = new Date().toISOString();

    if (!client || !initResult) {
      return this.buildUnavailableStatus({
        connected: Boolean(client),
        initialized: Boolean(initResult),
        checkedAt,
        reason: client ? 'appServerInitializing' : 'appServerUnavailable',
        message: client
          ? 'Codex app-server is connected but not initialized'
          : 'Codex app-server is not connected',
      });
    }

    const [accountProbe, configProbe, modelsProbe] = await Promise.all([
      this.probe<v2.GetAccountResponse>('account/read', {
        refreshToken: false,
      } satisfies v2.GetAccountParams),
      this.probe<v2.ConfigReadResponse>('config/read', {
        includeLayers: true,
      } satisfies v2.ConfigReadParams),
      this.probe<v2.ModelListResponse>(
        'model/list',
        {} satisfies v2.ModelListParams,
      ),
    ]);

    const account = this.toSection(accountProbe);
    const config = this.toConfigSection(configProbe);
    const provider = this.buildProviderStatus(configProbe);
    const models = this.buildModelsStatus(modelsProbe, configProbe);
    const runtime = this.buildRuntimeStatus({
      checkedAt,
      accountProbe,
      configProbe,
      provider,
      models,
    });

    return {
      appServer: {
        ok: true,
        connected: true,
        initialized: true,
      },
      initialize: {
        ok: true,
        data: this.toJsonSafe(initResult),
      },
      account,
      config,
      provider,
      models,
      runtime,
    };
  }

  private async probe<T>(
    method: string,
    params?: unknown,
  ): Promise<ProbeResult<T>> {
    try {
      const data = await this.codex.request<T>(method, params);
      return { ok: true, data };
    } catch (err) {
      const error = this.toStatusError(err, 'RPC_ERROR');
      this.logger.debug(
        `Codex status probe failed (${method}): ${error.message}`,
      );
      return { ok: false, error };
    }
  }

  private toSection<T>(probe: ProbeResult<T>): CodexSectionStatus {
    if (!probe.ok) {
      return {
        ok: false,
        error: probe.error,
      };
    }

    return {
      ok: true,
      data: this.toJsonSafe(probe.data),
    };
  }

  private toConfigSection(
    probe: ProbeResult<v2.ConfigReadResponse>,
  ): CodexSectionStatus {
    if (!probe.ok) {
      return {
        ok: false,
        error: probe.error,
      };
    }

    const config = probe.data.config;
    const summary: CodexConfigSummary = {
      sandboxMode: config.sandbox_mode ?? null,
      sandboxNetworkAccess:
        config.sandbox_workspace_write?.network_access ?? null,
      approvalPolicy: this.toJsonSafe(config.approval_policy),
      model: config.model ?? null,
      modelProvider: config.model_provider ?? null,
    };

    return { ok: true, data: this.toJsonSafe(summary) };
  }

  private buildProviderStatus(
    configProbe: ProbeResult<v2.ConfigReadResponse>,
  ): CodexProviderStatus {
    if (!configProbe.ok) {
      return {
        ok: false,
        id: null,
        envKey: null,
        envPresent: null,
        error: configProbe.error,
      };
    }

    const providerId = configProbe.data.config.model_provider;
    const envKey = this.lookupProviderEnvKey(
      providerId,
      configProbe.data.config,
    );
    return {
      ok: true,
      id: providerId,
      envKey,
      envPresent: envKey ? this.isEnvPresent(envKey) : null,
    };
  }

  private buildModelsStatus(
    modelsProbe: ProbeResult<v2.ModelListResponse>,
    configProbe: ProbeResult<v2.ConfigReadResponse>,
  ): CodexModelsStatus {
    if (!modelsProbe.ok) {
      return {
        ok: false,
        listable: false,
        defaultModel: null,
        count: 0,
        error: modelsProbe.error,
      };
    }

    return {
      ok: true,
      listable: true,
      defaultModel: this.findDefaultModel(modelsProbe.data, configProbe),
      count: modelsProbe.data.data.length,
      data: this.toJsonSafe(modelsProbe.data),
    };
  }

  private buildRuntimeStatus(args: {
    checkedAt: string;
    accountProbe: ProbeResult<v2.GetAccountResponse>;
    configProbe: ProbeResult<v2.ConfigReadResponse>;
    provider: CodexProviderStatus;
    models: CodexModelsStatus;
  }): CodexRuntimeStatusSection {
    const reasons = new Set<string>();
    let blocking = false;

    if (!args.accountProbe.ok) {
      reasons.add('accountReadFailed');
    }
    if (!args.configProbe.ok) {
      reasons.add('configReadFailed');
    }
    if (!args.models.ok) {
      reasons.add('modelListFailed');
      blocking = true;
    } else if (args.models.count === 0) {
      reasons.add('noModelsAvailable');
      blocking = true;
    }

    const hasAccount =
      args.accountProbe.ok && args.accountProbe.data.account !== null;
    const loginRequired =
      args.accountProbe.ok &&
      args.accountProbe.data.account === null &&
      args.accountProbe.data.requiresOpenaiAuth;

    const runtimeOverride = this.hasRuntimeOverride(args.provider, args.models);

    if (loginRequired && !runtimeOverride) {
      reasons.add('accountLoginRequired');
      blocking = true;
    }

    if (args.configProbe.ok && !hasAccount && !args.provider.id) {
      reasons.add('missingProviderConfig');
      blocking = true;
    }

    if (
      !hasAccount &&
      args.provider.envKey &&
      args.provider.envPresent === false
    ) {
      reasons.add('missingEnvKey');
      blocking = true;
    }

    if (args.provider.id && args.provider.envKey === null) {
      reasons.add('unknownProviderEnvKey');
    }

    const status: CodexRuntimeStatus = blocking
      ? 'unavailable'
      : reasons.size > 0
        ? 'degraded'
        : 'ready';

    return {
      status,
      reasons: [...reasons],
      checkedAt: args.checkedAt,
      cacheTtlMs:
        status === 'unavailable'
          ? UNAVAILABLE_CACHE_TTL_MS
          : READY_CACHE_TTL_MS,
    };
  }

  private hasRuntimeOverride(
    provider: CodexProviderStatus,
    models: CodexModelsStatus,
  ): boolean {
    return (
      models.ok &&
      models.listable &&
      Boolean(provider.id) &&
      (provider.envPresent === true || provider.envKey === null)
    );
  }

  private findDefaultModel(
    models: v2.ModelListResponse,
    configProbe: ProbeResult<v2.ConfigReadResponse>,
  ): string | null {
    const defaultModel = models.data.find((model) => model.isDefault);
    if (defaultModel) return defaultModel.model;

    if (configProbe.ok && configProbe.data.config.model) {
      return configProbe.data.config.model;
    }

    const visibleModel = models.data.find((model) => !model.hidden);
    return visibleModel?.model ?? models.data[0]?.model ?? null;
  }

  /**
   * Resolves provider env key. Reads from config.model_providers first,
   * falls back to hardcoded mapping for known built-in providers.
   */
  private lookupProviderEnvKey(
    providerId: string | null | undefined,
    config?: v2.Config,
  ): string | null {
    if (!providerId) return null;

    // Read from config's model_providers (covers custom providers)
    const providers = config?.model_providers as
      | Record<string, { env_key?: unknown }>
      | undefined;
    const providerConfig = providers?.[providerId];
    const configuredEnvKey = providerConfig?.env_key;
    if (typeof configuredEnvKey === 'string' && configuredEnvKey.trim())
      return configuredEnvKey;

    // Fallback to hardcoded mapping for built-in providers
    return PROVIDER_ENV_KEYS[providerId.trim().toLowerCase()] ?? null;
  }

  private isEnvPresent(envKey: string): boolean {
    const value = this.config.get<string>(envKey) ?? process.env[envKey];
    return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
  }

  private buildUnavailableStatus(args: {
    connected: boolean;
    initialized: boolean;
    checkedAt: string;
    reason: string;
    message: string;
  }): CodexStatusResponse {
    const error: CodexStatusError = {
      code: 'APP_SERVER_UNAVAILABLE',
      message: args.message,
    };
    const skipped: CodexStatusError = {
      code: 'SKIPPED',
      message: 'Skipped because Codex app-server is unavailable',
    };

    return {
      appServer: {
        ok: false,
        connected: args.connected,
        initialized: args.initialized,
        error,
      },
      initialize: {
        ok: false,
        data: null,
        error,
      },
      account: {
        ok: false,
        error: skipped,
      },
      config: {
        ok: false,
        error: skipped,
      },
      provider: {
        ok: false,
        id: null,
        envKey: null,
        envPresent: null,
        error: skipped,
      },
      models: {
        ok: false,
        listable: false,
        defaultModel: null,
        count: 0,
        error: skipped,
      },
      runtime: {
        status: 'unavailable',
        reasons: [args.reason],
        checkedAt: args.checkedAt,
        cacheTtlMs: UNAVAILABLE_CACHE_TTL_MS,
      },
    };
  }

  private buildUnexpectedFailureStatus(err: unknown): CodexStatusResponse {
    return this.buildUnavailableStatus({
      connected: Boolean(this.processManager.getClient()),
      initialized: Boolean(this.processManager.getInitResult()),
      checkedAt: new Date().toISOString(),
      reason: 'statusAggregationFailed',
      message: this.toStatusError(err, 'STATUS_AGGREGATION_FAILED').message,
    });
  }

  private toStatusError(err: unknown, code: string): CodexStatusError {
    if (err instanceof Error) {
      return { code, message: err.message };
    }
    return { code, message: String(err) };
  }

  /**
   * Recursively converts generated schema values into JSON-safe values.
   * Config currently contains bigint fields that Fastify cannot serialize.
   */
  private toJsonSafe(value: unknown): JsonSafeValue {
    if (value === null || value === undefined) return null;

    if (typeof value === 'bigint') {
      return Number(value);
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.toJsonSafe(item));
    }

    if (typeof value === 'object') {
      const result: Record<string, JsonSafeValue> = {};
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )) {
        result[key] = this.toJsonSafe(child);
      }
      return result;
    }

    // Remaining types (symbol, function) after all narrowing above
    if (typeof value === 'symbol') {
      return value.toString();
    }
    if (typeof value === 'function') {
      return value.name || 'anonymous';
    }
    return null;
  }
}
