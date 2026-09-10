import { CodexAcceptedWork } from '../codex-accepted-work';
import type { Mock } from 'vitest';
/** Activity decisions use upstream runtime snapshots, including waits and unsubscribed children. */
import { CatalogActivityService } from './catalog-activity.service';
import { CatalogAdmissionService } from './catalog-admission.service';
import type { CodexProcessManager } from '../codex-process-manager.service';

describe('CatalogActivityService', () => {
  let admission: CatalogAdmissionService;
  let request: Mock<
    (method: string, params: Record<string, unknown>) => Promise<unknown>
  >;
  let manager: {
    getClient: Mock<
      () => { request: typeof request; acceptedWork: CodexAcceptedWork } | null
    >;
    getGeneration: Mock<() => number>;
  };
  let service: CatalogActivityService;
  beforeEach(() => {
    admission = new CatalogAdmissionService();
    request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'thread/loaded/list')
        return Promise.resolve(
          params.cursor
            ? { data: ['child'], nextCursor: null }
            : { data: ['unsubscribed'], nextCursor: 'next' },
        );
      if (method === 'thread/read')
        return Promise.resolve({
          thread: {
            id: params.threadId,
            name: String(params.threadId),
            status: { type: 'idle' },
          },
        });
      if (method === 'thread/goal/get') return Promise.resolve({ goal: null });
      return Promise.resolve({ data: [], nextCursor: null });
    });
    manager = {
      getClient: vi
        .fn()
        .mockReturnValue({ request, acceptedWork: new CodexAcceptedWork() }),
      getGeneration: vi.fn().mockReturnValue(3),
    };
    service = new CatalogActivityService(
      manager as unknown as CodexProcessManager,
      admission,
    );
  });
  it('checks all pages and children without any subscription registry', async () => {
    expect((await service.inspect()).canApply).toBe(true);
    expect(request).toHaveBeenCalledWith('thread/read', {
      threadId: 'child',
      includeTurns: false,
    });
    expect(request).not.toHaveBeenCalledWith(
      'thread/resume',
      expect.anything(),
    );
  });
  it.each([
    { activeFlags: [] },
    { activeFlags: ['waitingOnApproval'] },
    { activeFlags: ['waitingOnUserInput'] },
  ])('blocks active work with flags %j', async ({ activeFlags }) => {
    const original = request.getMockImplementation()!;
    request.mockImplementation(
      (method: string, params: Record<string, unknown>) =>
        method === 'thread/read'
          ? Promise.resolve({
              thread: {
                name: 'Busy',
                status: { type: 'active', activeFlags },
              },
            })
          : original(method, params),
    );
    const result = await service.inspect();
    expect(result.canApply).toBe(false);
    expect(result.blockers).toHaveLength(2);
    expect(result.blockers[0].reason).toBe(
      activeFlags.join(', ') || 'Running turn',
    );
  });
  it.each(['terminal', 'goal', 'queue', 'read failure'])(
    'refuses %s without assuming a queue is running',
    async (kind) => {
      const original = request.getMockImplementation()!;
      request.mockImplementation(
        (method: string, params: Record<string, unknown>) => {
          if (
            kind === 'terminal' &&
            method === 'thread/backgroundTerminals/list'
          )
            return Promise.resolve({
              data: [{ processId: '42' }],
              nextCursor: null,
            });
          if (kind === 'goal' && method === 'thread/goal/get')
            return Promise.resolve({ goal: { status: 'active' } });
          if (kind === 'queue' && method === 'thread/queue/list')
            return Promise.resolve({ data: [{}], nextCursor: null });
          if (kind === 'read failure' && method === 'thread/read')
            return Promise.reject(new Error('cannot read'));
          return original(method, params);
        },
      );
      const result = await service.inspect();
      expect(result.canApply).toBe(false);
      if (kind === 'queue')
        expect(result.blockers[0].reason).toContain('Cannot establish idle');
    },
  );
  it('does not treat a paused goal as work', async () => {
    const original = request.getMockImplementation()!;
    request.mockImplementation(
      (method: string, params: Record<string, unknown>) =>
        method === 'thread/goal/get'
          ? Promise.resolve({ goal: { status: 'paused' } })
          : original(method, params),
    );
    expect((await service.inspect()).canApply).toBe(true);
  });
  it('refuses generation changes and local in-flight mutations', async () => {
    manager.getGeneration.mockReturnValueOnce(3).mockReturnValue(4);
    const release = admission.enter('fork operation');
    const result = await service.inspect();
    release();
    expect(result.canApply).toBe(false);
    expect(
      result.blockers.some((entry) => entry.reason.includes('generation')),
    ).toBe(true);
  });
  it('cannot call an unavailable child idle', async () => {
    manager.getClient.mockReturnValue(null);
    expect((await service.inspect()).canApply).toBe(false);
  });

  it('combines retained local work with upstream reads and returns the scope limitation', async () => {
    const ledger = manager.getClient()!.acceptedWork;
    ledger.dispatch(1, 'turn/start', { threadId: 'unsubscribed' });
    ledger.response(1, { turn: { id: 'accepted', status: 'inProgress' } });
    const result = await service.inspect();
    expect(result.canApply).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        turnId: 'accepted',
        requestMethod: 'turn/start',
      }),
    );
    expect(request).toHaveBeenCalledWith(
      'thread/loaded/list',
      expect.anything(),
    );
    expect(result.scope).toBe('managedAppServer');
    expect(result.limitations[0]).toContain('External clients');
  });

  it('notices newly dispatched local work while status probes are in flight', async () => {
    const original = request.getMockImplementation()!;
    request.mockImplementation((method, params) => {
      if (method === 'thread/queue/list')
        manager.getClient()!.acceptedWork.dispatch(1, 'thread/compact/start', {
          threadId: 'child',
        });
      return original(method, params);
    });
    expect((await service.inspect()).canApply).toBe(false);
  });

  it('keeps system-error states unknown even without retained local work', async () => {
    const original = request.getMockImplementation()!;
    request.mockImplementation((method, params) =>
      method === 'thread/read'
        ? Promise.resolve({
            thread: { name: 'unknown', status: { type: 'systemError' } },
          })
        : original(method, params),
    );
    expect((await service.inspect()).canApply).toBe(false);
  });
});
