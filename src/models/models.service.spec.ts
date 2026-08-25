import { Test, TestingModule } from '@nestjs/testing';
import { ModelsService } from './models.service';
import { CodexService } from '../codex/codex.service';

describe('ModelsService', () => {
  let service: ModelsService;
  const mockCodex = { request: vi.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelsService,
        { provide: CodexService, useValue: mockCodex },
      ],
    }).compile();

    service = module.get(ModelsService);
    mockCodex.request.mockReset();
  });

  it('should call model/list with default params', async () => {
    mockCodex.request.mockResolvedValue({
      data: [{ id: 'gpt-4' }],
      nextCursor: null,
    });

    const result = await service.listModels();

    expect(result.data).toHaveLength(1);
    expect(mockCodex.request).toHaveBeenCalledWith('model/list', {});
  });

  it('should pass pagination params', async () => {
    mockCodex.request.mockResolvedValue({ data: [], nextCursor: null });

    await service.listModels({ cursor: 'abc', limit: 5 });

    expect(mockCodex.request).toHaveBeenCalledWith('model/list', {
      cursor: 'abc',
      limit: 5,
    });
  });
});
