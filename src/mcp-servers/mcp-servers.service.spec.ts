/** Unit tests for McpServersService: list and reload operations. */
import { Test, type TestingModule } from '@nestjs/testing';
import { CodexService } from '../codex/codex.service';
import { McpServersService } from './mcp-servers.service';

describe('McpServersService', () => {
  let moduleRef: TestingModule;
  let service: McpServersService;

  const codexService = { request: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    moduleRef = await Test.createTestingModule({
      providers: [
        McpServersService,
        { provide: CodexService, useValue: codexService },
      ],
    }).compile();
    service = moduleRef.get(McpServersService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('lists MCP servers with default params', async () => {
    const response = { data: [{ name: 'context7' }], nextCursor: null };
    codexService.request.mockResolvedValueOnce(response);
    const result = await service.listServers();
    expect(result).toBe(response);
    expect(codexService.request).toHaveBeenCalledWith(
      'mcpServerStatus/list',
      {},
    );
  });

  it('passes pagination and detail params', async () => {
    const params = {
      cursor: 'next',
      limit: 25,
      detail: 'toolsAndAuthOnly' as const,
    };
    const response = { data: [], nextCursor: null };
    codexService.request.mockResolvedValueOnce(response);
    const result = await service.listServers(params);
    expect(result).toBe(response);
    expect(codexService.request).toHaveBeenCalledWith(
      'mcpServerStatus/list',
      params,
    );
  });

  it('reloads all MCP servers', async () => {
    codexService.request.mockResolvedValueOnce(undefined);
    await service.reloadAll();
    expect(codexService.request).toHaveBeenCalledWith(
      'config/mcpServer/reload',
    );
  });
});
