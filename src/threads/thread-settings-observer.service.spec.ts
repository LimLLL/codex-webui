import type { CodexLifecycleEvent } from '../codex/codex-process-manager.service';
import type { ServerNotification, v2 } from '../codex/codex-schema';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';

describe('ThreadSettingsObserverService', () => {
  let service: ThreadSettingsObserverService;
  let notificationHandler: ((notification: ServerNotification) => void) | null;
  let lifecycleHandler: ((event: CodexLifecycleEvent) => void) | null;

  const codexManager = {
    addListener: vi.fn(
      (_event: string, handler: (notification: ServerNotification) => void) => {
        notificationHandler = handler;
      },
    ),
    addLifecycleListener: vi.fn(
      (handler: (event: CodexLifecycleEvent) => void) => {
        lifecycleHandler = handler;
        return vi.fn();
      },
    ),
  };

  beforeEach(() => {
    notificationHandler = null;
    lifecycleHandler = null;
    vi.clearAllMocks();
    service = new ThreadSettingsObserverService(codexManager as never);
  });

  it('reports unknown before any observable thread settings arrive', () => {
    expect(service.readCollaborationMode('t1')).toEqual({
      observed: false,
      source: 'unknown',
      mode: null,
      model: null,
      reasoningEffort: null,
    });
  });

  it('records collaboration mode from thread settings notifications', () => {
    notificationHandler?.({
      method: 'thread/settings/updated',
      params: {
        threadId: 't1',
        threadSettings: threadSettings('plan', 'gpt-5', 'medium'),
      },
    });

    expect(service.readCollaborationMode('t1')).toEqual({
      observed: true,
      source: 'notification',
      mode: 'plan',
      model: 'gpt-5',
      reasoningEffort: 'medium',
    });
    expect(service.readObservedModel('t1')).toBe('gpt-5');
  });

  it('records accepted updates when app-server emits no settings change', () => {
    service.recordAcceptedCollaborationMode(
      't1',
      {
        mode: 'default',
        settings: {
          model: 'gpt-5',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
      null,
    );

    expect(service.readCollaborationMode('t1')).toEqual({
      observed: true,
      source: 'accepted',
      mode: 'default',
      model: 'gpt-5',
      reasoningEffort: null,
    });
  });

  // The thread-level effort is tracked separately from the collaboration
  // mode's own effort so switching to a preset that selects none can echo it
  // back instead of clearing it.
  it('tracks thread-level effort independently of the mode preset', () => {
    notificationHandler?.({
      method: 'thread/settings/updated',
      params: {
        threadId: 't1',
        threadSettings: threadSettings('default', 'gpt-5', 'xhigh'),
      },
    });

    expect(service.readObservedEffort('t1')).toBe('xhigh');
    expect(service.readObservedEffort('unknown-thread')).toBeNull();
  });

  // Notifications describe the present and say nothing about what preceded it,
  // so the displaced effort has to survive them to be restorable on exit.
  it('keeps the displaced effort while the thread stays in the mode', () => {
    service.recordAcceptedCollaborationMode(
      't1',
      {
        mode: 'plan',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
      { value: 'xhigh' },
    );

    notificationHandler?.({
      method: 'thread/settings/updated',
      params: {
        threadId: 't1',
        threadSettings: threadSettings('plan', 'gpt-5', 'medium'),
      },
    });

    expect(service.readObservedEffort('t1')).toBe('medium');
    expect(service.readDisplacedEffort('t1')).toEqual({ value: 'xhigh' });
  });

  // Without this the cache would outlive every thread the user ever deleted.
  it('drops observed settings when a thread is deleted', () => {
    notificationHandler?.({
      method: 'thread/settings/updated',
      params: {
        threadId: 't1',
        threadSettings: threadSettings('plan', 'gpt-5', 'medium'),
      },
    });
    expect(service.readCollaborationMode('t1').observed).toBe(true);

    notificationHandler?.({
      method: 'thread/deleted',
      params: { threadId: 't1' },
    });

    expect(service.readCollaborationMode('t1')).toEqual({
      observed: false,
      source: 'unknown',
      mode: null,
      model: null,
      reasoningEffort: null,
    });
  });

  it('clears observed settings after an app-server generation reset', () => {
    service.recordAcceptedCollaborationMode(
      't1',
      {
        mode: 'plan',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
      { value: 'xhigh' },
    );

    lifecycleHandler?.({
      type: 'appServerReady',
      generation: 2,
      restarted: true,
    });

    expect(service.readCollaborationMode('t1')).toEqual({
      observed: false,
      source: 'unknown',
      mode: null,
      model: null,
      reasoningEffort: null,
    });
    // Observed settings describe one generation, but the displaced effort is
    // still displaced: app-server persisted the imposed effort, so forgetting
    // the original would strand the thread at it.
    expect(service.readDisplacedEffort('t1')).toEqual({ value: 'xhigh' });
  });

  // Something outside this client can leave Plan mode without telling us. Once
  // the thread is out of the mode there is nothing left to restore, and keeping
  // the value would let a later exit overwrite the user's current effort.
  it('drops the displaced effort when the thread leaves the mode elsewhere', () => {
    service.recordAcceptedCollaborationMode(
      't1',
      {
        mode: 'plan',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
      { value: 'xhigh' },
    );

    notificationHandler?.({
      method: 'thread/settings/updated',
      params: {
        threadId: 't1',
        threadSettings: threadSettings('default', 'gpt-5', 'high'),
      },
    });

    expect(service.readDisplacedEffort('t1')).toBeNull();
  });

  // A thread that had no effort at all still displaced something, and "no
  // effort" must restore as no effort rather than as the imposed medium.
  it('distinguishes a displaced null from nothing displaced', () => {
    service.recordAcceptedCollaborationMode(
      't1',
      {
        mode: 'plan',
        settings: {
          model: 'gpt-5',
          reasoning_effort: 'medium',
          developer_instructions: null,
        },
      },
      { value: null },
    );

    expect(service.readDisplacedEffort('t1')).toEqual({ value: null });
    expect(service.readDisplacedEffort('never-touched')).toBeNull();
  });
});

function threadSettings(
  mode: 'plan' | 'default',
  model: string,
  effort: string | null,
): v2.ThreadSettings {
  return {
    cwd: '/workspace',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    activePermissionProfile: null,
    model,
    modelProvider: 'openai',
    serviceTier: null,
    effort,
    summary: null,
    collaborationMode: {
      mode,
      settings: {
        model,
        reasoning_effort: effort,
        developer_instructions: 'inlined',
      },
    },
    personality: null,
  };
}
