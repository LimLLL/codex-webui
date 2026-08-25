/** Unit tests for SkillsService JSON-RPC passthrough behavior. */
import { Test, type TestingModule } from '@nestjs/testing';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import { SkillsService } from './skills.service';

describe('SkillsService', () => {
  let moduleRef: TestingModule;
  let service: SkillsService;

  const codexService = { request: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    moduleRef = await Test.createTestingModule({
      providers: [
        SkillsService,
        { provide: CodexService, useValue: codexService },
      ],
    }).compile();
    service = moduleRef.get(SkillsService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('calls skills/list with the provided params and returns the raw response', async () => {
    const params: v2.SkillsListParams = { cwds: ['/repo'] };
    const response: v2.SkillsListResponse = {
      data: [{ cwd: '/repo', skills: [], errors: [] }],
    };
    codexService.request.mockResolvedValueOnce(response);

    const result = await service.listSkills(params);

    expect(result).toBe(response);
    expect(codexService.request).toHaveBeenCalledWith('skills/list', params);
  });
});
