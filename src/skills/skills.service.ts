/** Skills facade over Codex app-server JSON-RPC methods. */
import { Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';

@Injectable()
export class SkillsService {
  constructor(private readonly codex: CodexService) {}

  /** Lists available skills for one or more working directories. */
  async listSkills(
    params: v2.SkillsListParams,
  ): Promise<v2.SkillsListResponse> {
    return this.codex.request<v2.SkillsListResponse>('skills/list', params);
  }

  /** Writes skill enablement config by path or name. */
  async writeSkillConfig(
    params: v2.SkillsConfigWriteParams,
  ): Promise<v2.SkillsConfigWriteResponse> {
    return this.codex.request<v2.SkillsConfigWriteResponse>(
      'skills/config/write',
      params,
    );
  }
}
