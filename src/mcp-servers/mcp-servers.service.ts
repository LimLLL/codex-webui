/** MCP server status facade over Codex app-server JSON-RPC methods. */
import { Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';

@Injectable()
export class McpServersService {
  constructor(private readonly codex: CodexService) {}

  /** Lists MCP server inventory and auth metadata. */
  async listServers(
    params: v2.ListMcpServerStatusParams = {},
  ): Promise<v2.ListMcpServerStatusResponse> {
    return this.codex.request<v2.ListMcpServerStatusResponse>(
      'mcpServerStatus/list',
      params,
    );
  }

  /** Reloads all configured MCP servers. The protocol does not support per-server toggles. */
  async reloadAll(): Promise<void> {
    await this.codex.request<v2.McpServerRefreshResponse>(
      'config/mcpServer/reload',
    );
  }

  /** Starts an OAuth login flow for an MCP server and returns the browser URL. */
  startOauthLogin(
    params: v2.McpServerOauthLoginParams,
  ): Promise<v2.McpServerOauthLoginResponse> {
    return this.codex.request<v2.McpServerOauthLoginResponse>(
      'mcpServer/oauth/login',
      params,
    );
  }
}
