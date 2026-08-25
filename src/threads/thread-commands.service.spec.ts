import { CodexService } from '../codex/codex.service';
import { ErrorCode } from '../common/error-codes';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { ThreadCommandsService } from './thread-commands.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';

describe('ThreadCommandsService', () => {
  let service: ThreadCommandsService;
  const codex = { request: vi.fn() };
  const resumeRegistry = {
    readCachedModel: vi.fn(),
    readCachedEffort: vi.fn(),
  };
  const deletionRegistry = { assertMutable: vi.fn() };
  const settingsObserver = {
    readCollaborationMode: vi.fn(),
    readObservedModel: vi.fn(),
    readObservedEffort: vi.fn(),
    readDisplacedEffort: vi.fn(),
    recordAcceptedCollaborationMode: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ThreadCommandsService(
      codex as unknown as CodexService,
      resumeRegistry as unknown as ThreadResumeRegistryService,
      deletionRegistry as unknown as ThreadDeletionRegistryService,
      settingsObserver as unknown as ThreadSettingsObserverService,
    );
    settingsObserver.readCollaborationMode.mockReturnValue({
      observed: false,
      source: 'unknown',
      mode: null,
      model: null,
      reasoningEffort: null,
    });
    settingsObserver.readObservedModel.mockReturnValue(null);
    settingsObserver.recordAcceptedCollaborationMode.mockImplementation(
      (_threadId: string, collaborationMode: unknown) => ({
        observed: true,
        source: 'accepted',
        mode: (collaborationMode as { mode: string }).mode,
        model: (collaborationMode as { settings: { model: string } }).settings
          .model,
        reasoningEffort: (
          collaborationMode as {
            settings: { reasoning_effort: string | null };
          }
        ).settings.reasoning_effort,
      }),
    );
    settingsObserver.readObservedEffort.mockReturnValue(null);
    settingsObserver.readDisplacedEffort.mockReturnValue(null);
    resumeRegistry.readCachedModel.mockReturnValue(null);
    resumeRegistry.readCachedEffort.mockReturnValue(null);
    // clearAllMocks keeps queued mockResolvedValueOnce values, so one failing
    // test would otherwise feed its leftovers to the next one.
    codex.request.mockReset();
  });

  it('lists collaboration mode presets', async () => {
    codex.request.mockResolvedValue({
      data: [
        {
          name: 'Plan',
          mode: 'plan',
          model: null,
          reasoning_effort: 'medium',
        },
      ],
    });

    await expect(service.listCollaborationModes()).resolves.toEqual({
      data: [
        {
          name: 'Plan',
          mode: 'plan',
          model: null,
          reasoningEffort: 'medium',
        },
      ],
    });
    // The empty params object is required: app-server rejects the call with
    // "missing field `params`" when it is omitted.
    expect(codex.request).toHaveBeenCalledWith('collaborationMode/list', {});
  });

  it('sets collaboration mode by echoing the current cached model', async () => {
    codex.request
      .mockResolvedValueOnce({
        data: [
          {
            name: 'Plan',
            mode: 'plan',
            model: null,
            reasoning_effort: 'medium',
          },
        ],
      })
      .mockResolvedValueOnce({});
    resumeRegistry.readCachedModel.mockReturnValue('gpt-5');

    await expect(service.setCollaborationMode('t1', 'plan')).resolves.toEqual({
      observed: true,
      source: 'accepted',
      mode: 'plan',
      model: 'gpt-5',
      reasoningEffort: 'medium',
    });

    expect(codex.request).toHaveBeenNthCalledWith(2, 'thread/settings/update', {
      threadId: 't1',
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
    });
  });

  // Regression: the Default preset reports a null effort meaning "this preset
  // does not select one", but app-server treats a written null as clearing the
  // thread's effort. Echoing the preset verbatim silently downgraded a user
  // from xhigh to unset when switching back from Plan.
  it('preserves the current reasoning effort for presets that select none', async () => {
    codex.request
      .mockResolvedValueOnce({
        data: [
          {
            name: 'Default',
            mode: 'default',
            model: null,
            reasoning_effort: null,
          },
        ],
      })
      .mockResolvedValueOnce({});
    resumeRegistry.readCachedModel.mockReturnValue('gpt-5');
    settingsObserver.readObservedEffort.mockReturnValue('xhigh');

    await service.setCollaborationMode('t1', 'default');

    expect(codex.request).toHaveBeenNthCalledWith(2, 'thread/settings/update', {
      threadId: 't1',
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'xhigh',
          developer_instructions: null,
        },
      },
    });
  });

  it('falls back to the start/resume cached effort when none was observed', async () => {
    codex.request
      .mockResolvedValueOnce({
        data: [
          {
            name: 'Default',
            mode: 'default',
            model: null,
            reasoning_effort: null,
          },
        ],
      })
      .mockResolvedValueOnce({});
    resumeRegistry.readCachedModel.mockReturnValue('gpt-5');
    resumeRegistry.readCachedEffort.mockReturnValue('high');

    await service.setCollaborationMode('t1', 'default');

    expect(codex.request).toHaveBeenNthCalledWith(2, 'thread/settings/update', {
      threadId: 't1',
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'high',
          developer_instructions: null,
        },
      },
    });
  });

  // Entering Plan overwrites the thread effort with the preset's medium and
  // app-server keeps no history of what it replaced, so leaving Plan can only
  // restore xhigh if the value was remembered on the way in.
  it('remembers the effort displaced by an effort-dictating preset', async () => {
    codex.request
      .mockResolvedValueOnce({
        data: [
          {
            name: 'Plan',
            mode: 'plan',
            model: null,
            reasoning_effort: 'medium',
          },
        ],
      })
      .mockResolvedValueOnce({});
    resumeRegistry.readCachedModel.mockReturnValue('gpt-5');
    settingsObserver.readObservedEffort.mockReturnValue('xhigh');

    await service.setCollaborationMode('t1', 'plan');

    expect(
      settingsObserver.recordAcceptedCollaborationMode,
    ).toHaveBeenCalledWith('t1', expect.anything(), { value: 'xhigh' });
  });

  it('restores the displaced effort when leaving the mode', async () => {
    codex.request
      .mockResolvedValueOnce({
        data: [
          {
            name: 'Default',
            mode: 'default',
            model: null,
            reasoning_effort: null,
          },
        ],
      })
      .mockResolvedValueOnce({});
    resumeRegistry.readCachedModel.mockReturnValue('gpt-5');
    // Thread currently sits at the Plan-imposed medium...
    settingsObserver.readObservedEffort.mockReturnValue('medium');
    // ...but xhigh was what the user had before entering Plan.
    settingsObserver.readDisplacedEffort.mockReturnValue({ value: 'xhigh' });

    await service.setCollaborationMode('t1', 'default');

    expect(codex.request).toHaveBeenNthCalledWith(2, 'thread/settings/update', {
      threadId: 't1',
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'xhigh',
          developer_instructions: null,
        },
      },
    });
  });

  it('fails collaboration mode updates when no concrete model is known', async () => {
    codex.request.mockResolvedValueOnce({
      data: [
        {
          name: 'Plan',
          mode: 'plan',
          model: null,
          reasoning_effort: 'medium',
        },
      ],
    });

    await expect(
      service.setCollaborationMode('t1', 'plan'),
    ).rejects.toMatchObject({
      errorCode: ErrorCode.threads.collaborationModeModelRequired,
    });
  });

  it('reads collaboration mode from the observer cache', () => {
    const state = {
      observed: true,
      source: 'notification',
      mode: 'default',
      model: 'gpt-5',
      reasoningEffort: null,
    };
    settingsObserver.readCollaborationMode.mockReturnValue(state);

    expect(service.readCollaborationMode('t1')).toBe(state);
  });

  it('reads, sets, and clears goals through app-server', async () => {
    codex.request
      .mockResolvedValueOnce({ goal: null })
      .mockResolvedValueOnce({ goal: { threadId: 't1', status: 'active' } })
      .mockResolvedValueOnce({ cleared: true });

    await service.readGoal('t1');
    await service.setGoal({
      threadId: 't1',
      objective: 'Finish backend',
      tokenBudget: 1000,
    });
    await service.clearGoal('t1');

    expect(codex.request).toHaveBeenNthCalledWith(1, 'thread/goal/get', {
      threadId: 't1',
    });
    expect(codex.request).toHaveBeenNthCalledWith(2, 'thread/goal/set', {
      threadId: 't1',
      objective: 'Finish backend',
      tokenBudget: 1000,
    });
    expect(codex.request).toHaveBeenNthCalledWith(3, 'thread/goal/clear', {
      threadId: 't1',
    });
  });

  it('starts inline review turns only', async () => {
    codex.request.mockResolvedValue({
      turn: { id: 'turn1' },
      reviewThreadId: 't1',
    });

    await service.startReview('t1', {
      type: 'commit',
      sha: 'abc123',
      title: null,
    });

    expect(codex.request).toHaveBeenCalledWith('review/start', {
      threadId: 't1',
      target: { type: 'commit', sha: 'abc123', title: null },
      delivery: 'inline',
    });
  });
});
