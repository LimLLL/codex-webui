/** Unit tests for ThreadsController rich user input validation. */
import { BadRequestException } from '@nestjs/common';
import { ThreadsController } from './threads.controller';

describe('ThreadsController rich input validation', () => {
  let controller: ThreadsController;

  const threadsService = {
    startTurn: jest.fn(),
    steerTurn: jest.fn(),
    listLoadedThreads: jest.fn(),
  };
  const filesService = {
    resolveSafePath: jest.fn(),
  };
  const chatUploadService = {
    resolveStoredUploadPath: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    threadsService.startTurn.mockResolvedValue({
      turn: { id: 'turn1' },
    });
    threadsService.steerTurn.mockResolvedValue({ turnId: 'turn1' });
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
    ).rejects.toBeInstanceOf(BadRequestException);
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

  it('rejects malformed image URLs', async () => {
    await expect(
      controller.startTurn('thread1', {
        input: [{ type: 'image', url: 'not a url' }],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects image URLs with file: scheme', async () => {
    await expect(
      controller.startTurn('thread1', {
        input: [{ type: 'image', url: 'file:///tmp/image.png' }],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
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
