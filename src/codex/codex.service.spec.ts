import { Test, TestingModule } from '@nestjs/testing';
import { CodexService } from './codex.service';
import { CodexProcessManager } from './codex-process-manager.service';

describe('CodexService', () => {
  let service: CodexService;
  const mockClient = {
    request: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CodexService,
        {
          provide: CodexProcessManager,
          useValue: { getClient: () => mockClient },
        },
      ],
    }).compile();

    service = module.get(CodexService);
    mockClient.request.mockReset();
  });

  it('should delegate request to client', async () => {
    mockClient.request.mockResolvedValue({ data: [] });
    const result = await service.request('model/list', {});
    expect(result).toEqual({ data: [] });
    expect(mockClient.request).toHaveBeenCalledWith('model/list', {});
  });

  it('should throw when client is not connected', () => {
    const disconnectedService = new CodexService({
      getClient: () => null,
    } as unknown as CodexProcessManager);

    expect(() => disconnectedService.getClient()).toThrow(
      'Codex app-server is not connected',
    );
  });
});
