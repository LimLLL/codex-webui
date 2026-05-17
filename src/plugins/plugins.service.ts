/** Plugins facade over Codex app-server JSON-RPC methods. */
import { Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';

@Injectable()
export class PluginsService {
  constructor(private readonly codex: CodexService) {}

  /** Lists plugin marketplaces and installation state. */
  listPlugins(
    params: v2.PluginListParams = {},
  ): Promise<v2.PluginListResponse> {
    return this.codex.request<v2.PluginListResponse>('plugin/list', params);
  }

  /** Reads detailed metadata for one plugin inside one marketplace. */
  readPlugin(params: v2.PluginReadParams): Promise<v2.PluginReadResponse> {
    return this.codex.request<v2.PluginReadResponse>('plugin/read', params);
  }

  /** Installs a plugin through the app-server plugin lifecycle. */
  installPlugin(
    params: v2.PluginInstallParams,
  ): Promise<v2.PluginInstallResponse> {
    return this.codex.request<v2.PluginInstallResponse>(
      'plugin/install',
      params,
    );
  }

  /** Uninstalls a user-installed plugin. */
  uninstallPlugin(
    params: v2.PluginUninstallParams,
  ): Promise<v2.PluginUninstallResponse> {
    return this.codex.request<v2.PluginUninstallResponse>(
      'plugin/uninstall',
      params,
    );
  }
}
