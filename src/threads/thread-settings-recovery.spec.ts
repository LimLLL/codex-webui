/** Tests the real observer/registry interaction across asynchronous open boundaries. */
import type { v2 } from '../codex/codex-schema';
import { makeThreadFixture } from './threads.testing';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';

describe('settings freshness across thread opens', () => {
  const manager = {
    addListener: vi.fn(),
    addLifecycleListener: vi.fn(),
    getGeneration: vi.fn(() => 1),
  };
  const history = {
    resumeMetadataFirst: vi.fn(),
    readThreadMetadata: vi.fn(),
    listTurns: vi.fn(),
  };
  let observer: ThreadSettingsObserverService;
  let registry: ThreadResumeRegistryService;
  const settings: v2.ThreadSettings = {
    cwd: '/new',
    model: 'new-model',
    modelProvider: 'openai',
    serviceTier: 'priority',
    effort: 'high',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'dangerFullAccess' },
    activePermissionProfile: null,
    summary: null,
    personality: null,
    collaborationMode: {
      mode: 'default',
      settings: {
        model: 'new-model',
        reasoning_effort: 'high',
        developer_instructions: null,
      },
    },
  };
  const response = () => ({
    thread: makeThreadFixture({ id: 't1' }),
    cwd: '/old',
    model: 'old-model',
    modelProvider: 'openai',
    serviceTier: null,
    reasoningEffort: null,
    approvalPolicy: 'on-request' as const,
    approvalsReviewer: 'user' as const,
    sandbox: { type: 'readOnly' as const, networkAccess: false },
    instructionSources: [],
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
    initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    manager.getGeneration.mockReturnValue(1);
    observer = new ThreadSettingsObserverService(manager as never);
    registry = new ThreadResumeRegistryService(
      history as never,
      manager as never,
      observer,
    );
    history.readThreadMetadata.mockResolvedValue({
      thread: makeThreadFixture({ id: 't1' }),
    });
    history.listTurns.mockResolvedValue({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });
  });

  it('uses a notification that arrives while the initial resume is in flight', async () => {
    history.resumeMetadataFirst.mockImplementation(() => {
      observer.recordThreadSettings('t1', settings);
      return Promise.resolve(response());
    });
    await expect(registry.ensureOpened('t1')).resolves.toMatchObject({
      approvalPolicy: 'never',
      sandbox: { type: 'dangerFullAccess' },
      model: 'new-model',
      serviceTier: 'priority',
    });
  });

  it('uses the latest observation after repeat-open history reads, not the original cache', async () => {
    registry.markResumed('t1');
    registry.cacheResponse('t1', response());
    history.listTurns.mockImplementation(() => {
      observer.recordThreadSettings('t1', settings);
      return Promise.resolve({
        data: [],
        nextCursor: null,
        backwardsCursor: null,
      });
    });
    await expect(registry.ensureOpened('t1')).resolves.toMatchObject({
      approvalPolicy: 'never',
      cwd: '/new',
      reasoningEffort: 'high',
    });
    expect(history.resumeMetadataFirst).not.toHaveBeenCalled();
  });

  it('seeds start/fork responses without replacing an earlier notification', () => {
    observer.recordThreadSettings('t1', settings);
    registry.cacheResponse('t1', response());
    expect(observer.readSettings('t1')?.settings).toEqual(settings);
  });

  it('does not seed a start/fork response from an obsolete generation', () => {
    manager.getGeneration.mockReturnValue(2);
    expect(() => registry.cacheResponse('t1', response(), 1)).toThrow(
      'obsolete',
    );
    expect(observer.readSecurityPolicy('t1').observed).toBe(false);
  });

  it('rejects a repeat-open result crossing a process generation', async () => {
    registry.markResumed('t1');
    registry.cacheResponse('t1', response());
    history.listTurns.mockImplementation(() => {
      manager.getGeneration.mockReturnValue(2);
      return Promise.resolve({
        data: [],
        nextCursor: null,
        backwardsCursor: null,
      });
    });
    await expect(registry.ensureOpened('t1')).rejects.toThrow('superseded');
  });
});
