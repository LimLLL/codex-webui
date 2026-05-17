/** Apps facade over Codex app-server JSON-RPC methods. */
import { Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';

@Injectable()
export class AppsService {
  constructor(private readonly codex: CodexService) {}

  /** Lists experimental apps/connectors from Codex app-server. */
  listApps(params: v2.AppsListParams = {}): Promise<v2.AppsListResponse> {
    return this.codex.request<v2.AppsListResponse>('app/list', params);
  }
}
