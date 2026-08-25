import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { ThreadCommandsController } from './thread-commands.controller';

describe('ThreadCommandsController', () => {
  const threadsService = {
    listCollaborationModes: vi.fn(),
    readCollaborationMode: vi.fn(),
    setCollaborationMode: vi.fn(),
    readGoal: vi.fn(),
    setGoal: vi.fn(),
    clearGoal: vi.fn(),
    startReview: vi.fn(),
  };
  let controller: ThreadCommandsController;

  beforeEach(() => {
    vi.clearAllMocks();
    threadsService.listCollaborationModes.mockResolvedValue({ data: [] });
    threadsService.readCollaborationMode.mockReturnValue({
      observed: false,
      source: 'unknown',
      mode: null,
      model: null,
      reasoningEffort: null,
    });
    threadsService.setCollaborationMode.mockResolvedValue({
      observed: true,
      source: 'accepted',
      mode: 'plan',
      model: 'gpt-5',
      reasoningEffort: 'medium',
    });
    threadsService.readGoal.mockResolvedValue({ goal: null });
    threadsService.setGoal.mockResolvedValue({
      goal: { threadId: 'thread1', status: 'active' },
    });
    threadsService.clearGoal.mockResolvedValue({ cleared: true });
    threadsService.startReview.mockResolvedValue({
      turn: { id: 'turn1' },
      reviewThreadId: 'thread1',
    });
    controller = new ThreadCommandsController(threadsService as never);
  });

  it('validates collaboration mode before updating settings', async () => {
    await controller.setCollaborationMode('thread1', {
      mode: 'plan',
    });

    expect(threadsService.setCollaborationMode).toHaveBeenCalledWith(
      'thread1',
      'plan',
    );
  });

  it('rejects invalid collaboration modes', () => {
    expectBusinessError(
      () =>
        controller.setCollaborationMode('thread1', {
          mode: 'other',
        } as never),
      ErrorCode.threads.invalidCollaborationMode,
    );
  });

  it('normalizes goal update input', async () => {
    await controller.setGoal('thread1', {
      objective: '  ship slash backend  ',
      status: 'paused',
      tokenBudget: null,
    });

    expect(threadsService.setGoal).toHaveBeenCalledWith({
      threadId: 'thread1',
      objective: 'ship slash backend',
      status: 'paused',
      tokenBudget: null,
    });
  });

  // Codex caps goal text at 4000 characters; rejecting here turns an opaque
  // app-server rejection into an actionable field error.
  it('rejects goal objectives beyond the Codex length cap', () => {
    expectBusinessError(
      () => controller.setGoal('thread1', { objective: 'x'.repeat(4001) }),
      ErrorCode.threads.invalidGoal,
    );
  });

  it('accepts a goal objective at exactly the length cap', async () => {
    await controller.setGoal('thread1', { objective: 'x'.repeat(4000) });

    expect(threadsService.setGoal).toHaveBeenCalledWith({
      threadId: 'thread1',
      objective: 'x'.repeat(4000),
    });
  });

  it('rejects invalid goal status', () => {
    expectBusinessError(
      () =>
        controller.setGoal('thread1', {
          status: 'sleeping',
        } as never),
      ErrorCode.threads.invalidGoalStatus,
    );
  });

  it('starts review with normalized inline target', async () => {
    await controller.startReview('thread1', {
      target: { type: 'commit', sha: ' abc123 ', title: ' Subject ' },
    });

    expect(threadsService.startReview).toHaveBeenCalledWith('thread1', {
      type: 'commit',
      sha: 'abc123',
      title: 'Subject',
    });
  });

  it('rejects detached review requests', () => {
    expectBusinessError(
      () =>
        controller.startReview('thread1', {
          delivery: 'detached',
          target: { type: 'uncommittedChanges' },
        } as never),
      ErrorCode.threads.reviewDetachedUnsupported,
    );
  });
});

function expectBusinessError(action: () => unknown, errorCode: string): void {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(BusinessException);
    expect(err).toMatchObject({ errorCode });
    return;
  }
  throw new Error(`Expected ${errorCode}`);
}
