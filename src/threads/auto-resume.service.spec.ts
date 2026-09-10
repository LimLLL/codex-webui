/** Recovery claims admission, restores parent ownership first, and never submits a turn. */
import { AutoResumeService } from './auto-resume.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import type {
  CodexLifecycleEvent,
  CodexProcessManager,
} from '../codex/codex-process-manager.service';
import type { ActiveThreadRegistryService } from './active-thread-registry.service';
import type { ThreadsService } from './threads.service';
import type { ThreadsGateway } from './threads.gateway';

describe('AutoResumeService', () => {
  it('resumes the parent before its subscribed child and preserves active-branch selection', async () => {
    let listener: (event: CodexLifecycleEvent) => void = () => undefined;
    const admission = new CatalogAdmissionService();
    const order: string[] = [];
    let complete: () => void = () => undefined;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const readThread = vi.fn((id: string) =>
      Promise.resolve({
        thread: { parentThreadId: id === 'child' ? 'parent' : null },
      }),
    );
    const resumeThread = vi.fn((id: string) => {
      expect(() => admission.begin()).toThrow('Mutations');
      order.push(id);
      return Promise.resolve({});
    });
    const emitLifecycle = vi.fn((event: { type: string }) => {
      if (event.type === 'autoResumeCompleted') complete();
    });
    const service = new AutoResumeService(
      {
        addLifecycleListener: (handler: typeof listener) => {
          listener = handler;
        },
      } as unknown as CodexProcessManager,
      { snapshot: () => ['child'] } as unknown as ActiveThreadRegistryService,
      { readThread, resumeThread } as unknown as ThreadsService,
      { emitLifecycle } as unknown as ThreadsGateway,
      admission,
    );
    service.onModuleInit();
    listener({ type: 'appServerReady', generation: 2, restarted: true });
    await completed;
    expect(order).toEqual(['parent', 'child']);
    expect(resumeThread).toHaveBeenCalledWith('child', { recordActive: false });
    expect(emitLifecycle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resumedThreadIds: ['child'],
        failedThreadIds: [],
      }),
    );
    const release = admission.begin();
    release();
  });
});
