/** Invalidations describe committed pending-set changes, including expiry and failed writes. */
import { createTestDatabase } from '../database/database.testing';
import { PendingApprovalsService } from './pending-approvals.service';
import { permissionApprovalFixture } from './pending-approvals.testing';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';

describe('PendingApprovalsService changes', () => {
  const database = createTestDatabase();
  const respond = vi.fn();
  let service: PendingApprovalsService;
  let observedCounts: number[];
  let unsubscribe: () => void;
  beforeEach(() => {
    respond.mockReset();
    service = new PendingApprovalsService(
      database.db,
      {
        getGeneration: () => 1,
        addLifecycleListener: vi.fn(),
        getClient: () => ({ respondToServerRequest: respond }),
      } as unknown as CodexProcessManager,
      new ThreadDeletionRegistryService(),
      new CatalogAdmissionService(),
    );
    service.onModuleInit();
    observedCounts = [];
    const subscription = service.changes.subscribe(() =>
      observedCounts.push(service.listPending().length),
    );
    unsubscribe = () => subscription.unsubscribe();
  });
  afterEach(() => unsubscribe());
  afterAll(() => database.sqlite.close());

  it('publishes creation and exactly one committed response across devices', () => {
    service.recordServerRequest(permissionApprovalFixture());
    const id = service.listPending()[0].requestId;
    service.respondToRequest(id, { decision: 'accept' }, 'desktop');
    expect(() =>
      service.respondToRequest(id, { decision: 'accept' }, 'mobile'),
    ).toThrow('already been resolved');
    expect(observedCounts).toEqual([1, 0]);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('does not publish a response whose transport write rolled back', () => {
    service.recordServerRequest(permissionApprovalFixture());
    respond.mockImplementation(() => {
      throw new Error('transport closed');
    });
    expect(() =>
      service.respondToRequest(service.listPending()[0].requestId, {}),
    ).toThrow('transport closed');
    expect(observedCounts).toEqual([1]);
    expect(service.listPending()).toHaveLength(1);
  });

  it('publishes generation expiry, startup expiry and explicit cancellation', () => {
    service.recordServerRequest(permissionApprovalFixture());
    service.expireGeneration(1, 'child replaced');
    service.expireGeneration(1, 'duplicate lifecycle');
    service.recordServerRequest(permissionApprovalFixture());
    service.onModuleInit();
    service.recordServerRequest(permissionApprovalFixture());
    service.cancelPendingForThreads(['t1'], 'deleted');
    expect(observedCounts).toEqual([1, 0, 1, 0, 1, 0]);
  });

  it('publishes an upstream resolution only when it changes a pending row', () => {
    service.recordServerRequest(permissionApprovalFixture());
    const requestId = Number(service.listPending()[0].requestId);
    const note = {
      method: 'serverRequest/resolved' as const,
      params: { threadId: 't1', requestId },
    };
    service.markResolved(note);
    service.markResolved(note);
    expect(observedCounts).toEqual([1, 0]);
  });
});
