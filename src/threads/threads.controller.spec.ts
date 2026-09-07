/** Unit tests for ThreadsController rich user input validation. */
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { ThreadsController } from './threads.controller';

describe('ThreadsController rich input validation', () => {
  let controller: ThreadsController;

  const threadsService = {
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    listLoadedThreads: vi.fn(),
    forkThread: vi.fn(),
  };
  const filesService = {
    resolveSafePath: vi.fn(),
  };
  const chatUploadService = {
    resolveStoredUploadPath: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    threadsService.startTurn.mockResolvedValue({
      turn: { id: 'turn1' },
    });
    threadsService.steerTurn.mockResolvedValue({ turnId: 'turn1' });
    threadsService.forkThread.mockResolvedValue({
      thread: { id: 'thread2' },
    });
    threadsService.listLoadedThreads.mockResolvedValue({
      data: ['thread1'],
      nextCursor: null,
    });
    filesService.resolveSafePath.mockResolvedValue('/workspace/file.ts');
    chatUploadService.resolveStoredUploadPath.mockResolvedValue(
      '/tmp/webui-uploads/image.png',
    );
    controller = new ThreadsController(
      threadsService as never,
      filesService as never,
      chatUploadService as never,
    );
  });

  it('lists loaded thread ids with pagination params', async () => {
    await expect(
      controller.listLoadedThreads('cursor-1', '20'),
    ).resolves.toEqual({ data: ['thread1'], nextCursor: null });

    expect(threadsService.listLoadedThreads).toHaveBeenCalledWith({
      cursor: 'cursor-1',
      limit: 20,
    });
  });

  it('rejects invalid loaded thread limit', async () => {
    await expect(
      controller.listLoadedThreads(undefined, '0'),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('passes fork goal carry explicitly', async () => {
    await controller.forkThread('thread1', { carryGoal: true });

    expect(threadsService.forkThread).toHaveBeenCalledWith('thread1', {
      carryGoal: true,
    });
  });

  it('rejects unsupported ephemeral fork bodies', async () => {
    await expect(
      controller.forkThread('thread1', {
        ephemeral: true,
      } as never),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.threads.invalidForkOptions,
    });
  });

  it('normalizes missing text_elements to an empty array', async () => {
    await controller.startTurn('thread1', {
      input: [{ type: 'text', text: 'hello' }],
    } as never);

    expect(threadsService.startTurn).toHaveBeenCalledWith({
      threadId: 'thread1',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
  });

  it('resolves localImage paths through ChatUploadService', async () => {
    await controller.startTurn('thread1', {
      input: [{ type: 'localImage', path: '/tmp/webui-uploads/image.png' }],
    } as never);

    expect(chatUploadService.resolveStoredUploadPath).toHaveBeenCalledWith(
      '/tmp/webui-uploads/image.png',
    );
    expect(threadsService.startTurn).toHaveBeenCalledWith({
      threadId: 'thread1',
      input: [{ type: 'localImage', path: '/tmp/webui-uploads/image.png' }],
    });
  });

  it('resolves mention paths through FilesService workspace validation', async () => {
    await controller.steerTurn('thread1', 'turn1', {
      input: [{ type: 'mention', name: 'file.ts', path: '/workspace/file.ts' }],
    } as never);

    expect(filesService.resolveSafePath).toHaveBeenCalledWith(
      '/workspace/file.ts',
    );
    expect(threadsService.steerTurn).toHaveBeenCalledWith({
      threadId: 'thread1',
      expectedTurnId: 'turn1',
      input: [{ type: 'mention', name: 'file.ts', path: '/workspace/file.ts' }],
    });
  });

  it('passes skill inputs by validated shape', async () => {
    await controller.startTurn('thread1', {
      input: [{ type: 'skill', name: 'review', path: '/skills/review' }],
    } as never);

    expect(threadsService.startTurn).toHaveBeenCalledWith({
      threadId: 'thread1',
      input: [{ type: 'skill', name: 'review', path: '/skills/review' }],
    });
  });

  // `serviceTier` mirrors the app-server's `Option<Option<String>>`: absent,
  // explicit null and a value are three distinct instructions. Collapsing null
  // into absent — the obvious "simplification" — silently removes the only way
  // to switch a thread back to standard speed.
  describe('service tier three-state forwarding', () => {
    it('omits serviceTier when the caller did not supply one', async () => {
      await controller.startTurn('thread1', {
        input: [{ type: 'text', text: 'hi' }],
      } as never);

      const params = threadsService.startTurn.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(params).not.toHaveProperty('serviceTier');
    });

    it('forwards an explicit null so the thread tier is cleared', async () => {
      await controller.startTurn('thread1', {
        input: [{ type: 'text', text: 'hi' }],
        serviceTier: null,
      } as never);

      expect(threadsService.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({ serviceTier: null }),
      );
    });

    it('forwards a model-advertised tier id verbatim', async () => {
      await controller.startTurn('thread1', {
        input: [{ type: 'text', text: 'hi' }],
        serviceTier: '  priority  ',
      } as never);

      expect(threadsService.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({ serviceTier: 'priority' }),
      );
    });

    it('rejects a blank tier rather than silently treating it as absent', async () => {
      await expect(
        controller.startTurn('thread1', {
          input: [{ type: 'text', text: 'hi' }],
          serviceTier: '   ',
        } as never),
      ).rejects.toBeInstanceOf(BusinessException);
    });
  });

  it('rejects malformed image URLs', async () => {
    await expect(
      controller.startTurn('thread1', {
        input: [{ type: 'image', url: 'not a url' }],
      } as never),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('rejects image URLs with file: scheme', async () => {
    await expect(
      controller.startTurn('thread1', {
        input: [{ type: 'image', url: 'file:///tmp/image.png' }],
      } as never),
    ).rejects.toBeInstanceOf(BusinessException);
  });

  it('validates inline absolute file mentions in text', async () => {
    await controller.startTurn('thread1', {
      input: [{ type: 'text', text: 'check @/workspace/file.ts' }],
    } as never);

    expect(filesService.resolveSafePath).toHaveBeenCalledWith(
      '/workspace/file.ts',
    );
  });

  it('validates inline absolute file mentions with escaped spaces', async () => {
    await controller.startTurn('thread1', {
      input: [{ type: 'text', text: 'check @/workspace/my\\ file.ts' }],
    } as never);

    expect(filesService.resolveSafePath).toHaveBeenCalledWith(
      '/workspace/my file.ts',
    );
  });
});
