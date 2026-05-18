import { Test, TestingModule } from '@nestjs/testing';
import { ThreadsService } from './threads.service';
import { CodexService } from '../codex/codex.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';

describe('ThreadsService', () => {
  let service: ThreadsService;
  const mockCodex = { request: jest.fn() };
  const mockResumeRegistry = {
    ensureResumed: jest.fn(),
    markResumed: jest.fn(),
    cacheResponse: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadsService,
        { provide: CodexService, useValue: mockCodex },
        { provide: ThreadResumeRegistryService, useValue: mockResumeRegistry },
      ],
    }).compile();

    service = module.get(ThreadsService);
    mockCodex.request.mockReset();
    mockResumeRegistry.ensureResumed.mockReset();
    mockResumeRegistry.markResumed.mockReset();
  });

  it('should call thread/start', async () => {
    const response = { thread: { id: 't1' }, model: 'gpt-4' };
    mockCodex.request.mockResolvedValue(response);

    const result = await service.startThread({
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });

    expect(result).toEqual(response);
    expect(mockCodex.request).toHaveBeenCalledWith('thread/start', {
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    expect(mockResumeRegistry.markResumed).toHaveBeenCalledWith('t1');
  });

  it('should call thread/list with params', async () => {
    mockCodex.request.mockResolvedValue({ data: [], nextCursor: null });

    await service.listThreads({ limit: 10 });

    expect(mockCodex.request).toHaveBeenCalledWith('thread/list', {
      limit: 10,
    });
  });

  it('should call thread/loaded/list with params', async () => {
    mockCodex.request.mockResolvedValue({ data: ['t1'], nextCursor: null });

    await service.listLoadedThreads({ cursor: 'cursor-1', limit: 20 });

    expect(mockCodex.request).toHaveBeenCalledWith('thread/loaded/list', {
      cursor: 'cursor-1',
      limit: 20,
    });
  });

  it('should call thread/read with includeTurns', async () => {
    mockCodex.request.mockResolvedValue({ thread: { id: 't1' } });

    await service.readThread('t1', true);

    expect(mockCodex.request).toHaveBeenCalledWith('thread/read', {
      threadId: 't1',
      includeTurns: true,
    });
  });

  it('should ensure resume via registry', async () => {
    const response = { thread: { id: 't1' }, cwd: '/tmp' };
    mockResumeRegistry.ensureResumed.mockResolvedValue(response);

    await expect(service.resumeThread('t1')).resolves.toBe(response);
    expect(mockResumeRegistry.ensureResumed).toHaveBeenCalledWith('t1');
  });

  it('should call turn/start', async () => {
    mockCodex.request.mockResolvedValue({ turn: { id: 'turn1' } });

    await service.startTurn({
      threadId: 't1',
      input: [{ type: 'text', text: 'hello' }] as never,
    });

    expect(mockCodex.request).toHaveBeenCalledWith('turn/start', {
      threadId: 't1',
      input: [{ type: 'text', text: 'hello' }],
    });
  });

  it('should call turn/steer', async () => {
    mockCodex.request.mockResolvedValue({ turnId: 'turn1' });

    await service.steerTurn({
      threadId: 't1',
      expectedTurnId: 'turn1',
      input: [{ type: 'text', text: 'keep going' }] as never,
    });

    expect(mockCodex.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 't1',
      expectedTurnId: 'turn1',
      input: [{ type: 'text', text: 'keep going' }],
    });
  });

  it('should call turn/interrupt', async () => {
    mockCodex.request.mockResolvedValue({});

    await service.interruptTurn('t1', 'turn1');

    expect(mockCodex.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 't1',
      turnId: 'turn1',
    });
  });
});
