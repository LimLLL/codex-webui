/** Invalidation follows committed submission, retirement, and delivery failures. */
import { createTestDatabase } from '../database/database.testing';
import { PendingApprovalsService } from './pending-approvals.service';
import { permissionApprovalFixture } from './pending-approvals.testing';
import { createRequestManager } from './request-owner.testing';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';

describe('pending request transitions', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let transport: ReturnType<typeof createRequestManager>;
  let service: PendingApprovalsService;
  let states: string[];
  beforeEach(() => {
    database = createTestDatabase();
    transport = createRequestManager();
    service = new PendingApprovalsService(
      database.db,
      transport.manager,
      new ThreadDeletionRegistryService(),
      new CatalogAdmissionService(),
    );
    service.onModuleInit();
    states = [];
    service.resolvedRequests.subscribe((event) => states.push(event.status));
  });
  afterEach(() => {
    transport.close();
    database.sqlite.close();
  });

  it('separates a committed submission from app-server confirmation across two browsers', () => {
    transport.receive(permissionApprovalFixture());
    const row = service.listPending()[0];
    service.respondToRequest(
      row.requestId,
      row.instanceId,
      { decision: 'accept' },
      'desktop',
    );
    expect(service.listPending()).toEqual([]);
    expect(service.readPending().requests[0].status).toBe('submitted');
    expect(() =>
      service.respondToRequest(
        row.requestId,
        row.instanceId,
        { decision: 'accept' },
        'mobile',
      ),
    ).toThrow('already been handled');
    expect(transport.wire).toHaveBeenCalledOnce();
    expect(states).toEqual(['submitted']);
    transport.notify({
      method: 'serverRequest/resolved',
      params: { threadId: 't1', requestId: 17 },
    });
    transport.notify({
      method: 'serverRequest/resolved',
      params: { threadId: 't1', requestId: 17 },
    });
    expect(states).toEqual(['submitted', 'resolved']);
    expect(service.readPending().requests).toEqual([]);
  });

  it('does not reopen a committed decision after an ambiguous write', () => {
    transport.receive(permissionApprovalFixture());
    const row = service.listPending()[0];
    transport.wire.mockImplementation(() => {
      throw new Error('closed');
    });
    expect(() =>
      service.respondToRequest(row.requestId, row.instanceId, {
        decision: 'accept',
      }),
    ).toThrow('could not be confirmed');
    expect(service.listPending()).toEqual([]);
    expect(service.readPending().failures).toHaveLength(1);
    expect(() =>
      service.respondToRequest(row.requestId, row.instanceId, {
        decision: 'decline',
      }),
    ).toThrow('already been handled');
    expect(transport.wire).toHaveBeenCalledOnce();
    expect(states).toEqual(['failed']);
  });

  it('retires authority on connection replacement and confirmed deletion', () => {
    transport.receive(permissionApprovalFixture());
    transport.restart();
    transport.receive(permissionApprovalFixture());
    service.cancelPendingForThreads(['t1'], 'deleted');
    expect(states).toEqual(['expired', 'cancelled']);
    expect(service.readPending().requests).toEqual([]);
  });
});
