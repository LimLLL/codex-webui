/** Immutable proposals, stale-browser refusal, and the SQLite/stdio delivery boundary. */
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../database/database.testing';
import { pendingServerRequests } from '../database/schema';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { PendingApprovalsService } from './pending-approvals.service';
import { PendingApprovalsController } from './pending-approvals.controller';
import {
  fileApprovalFixture,
  permissionApprovalFixture,
} from './pending-approvals.testing';
import { createRequestManager } from './request-owner.testing';

describe('pending response authorization', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let transport: ReturnType<typeof createRequestManager>;
  let service: PendingApprovalsService;
  let controller: PendingApprovalsController;
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
    controller = new PendingApprovalsController(service);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    transport.close();
    vi.restoreAllMocks();
    database.sqlite.close();
  });

  it.each(['accept', 'acceptForSession', {}, undefined])(
    'rejects unseen file decision %j before committing',
    (decision) => {
      transport.receive(fileApprovalFixture().request);
      const row = service.listPending()[0];
      expect(() =>
        controller.respond('31', {
          instanceId: row.instanceId,
          result: { decision },
        }),
      ).toThrow('change set');
      expect(transport.wire).not.toHaveBeenCalled();
      expect(service.listPending()[0].status).toBe('pending');
    },
  );

  it.each(['decline', 'cancel'])(
    'allows %s without a file subject',
    (decision) => {
      transport.receive(fileApprovalFixture().request);
      controller.respond('31', {
        instanceId: service.listPending()[0].instanceId,
        result: { decision },
      });
      expect(transport.wire).toHaveBeenCalledWith({
        id: 31,
        result: { decision },
      });
    },
  );

  it('rejects missing and mismatched instances without falling back to the current wire ID', () => {
    transport.receive(permissionApprovalFixture());
    expect(() =>
      controller.respond('17', { result: { decision: 'accept' } } as never),
    ).toThrow('instanceId');
    expect(() =>
      controller.respond('17', {
        instanceId: 'another-proposal',
        result: { decision: 'accept' },
      }),
    ).toThrow('instance not found');
    expect(transport.wire).not.toHaveBeenCalled();
  });

  it('cannot answer an unrelated request after the backend counter resets', () => {
    transport.receive(permissionApprovalFixture());
    const old = service.listPending()[0];
    transport.restart(1);
    transport.receive({
      ...permissionApprovalFixture(),
      params: {
        ...permissionApprovalFixture().params,
        command: 'different operation',
      },
    });
    const current = service.listPending()[0];
    expect(current.instanceId).not.toBe(old.instanceId);
    expect(current.generation).toBe(old.generation);
    expect(() =>
      controller.respond('17', {
        instanceId: old.instanceId,
        result: { decision: 'accept' },
      }),
    ).toThrow('already been handled');
    expect(transport.wire).not.toHaveBeenCalled();
    controller.respond('17', {
      instanceId: current.instanceId,
      result: { decision: 'decline' },
    });
    expect(transport.wire).toHaveBeenCalledOnce();
  });

  it('never replaces the proposal or resurrects a terminal instance on duplicate delivery', () => {
    const fixture = fileApprovalFixture();
    transport.notify(fixture.started);
    const owned = transport.receive(fixture.request)!;
    const original = service.listPending()[0];
    owned.request.params = {
      ...fixture.request.params,
      threadId: 'different-thread',
    };
    expect(service.recordServerRequest(owned)).toMatchObject({
      instanceId: original.instanceId,
      threadId: 't1',
      reviewSubject: original.reviewSubject,
    });
    controller.respond('31', {
      instanceId: original.instanceId,
      result: { decision: 'decline' },
    });
    transport.notify({
      method: 'serverRequest/resolved',
      params: { threadId: 't1', requestId: 31 },
    });
    expect(service.recordServerRequest(owned).status).toBe('resolved');
    expect(service.listPending()).toEqual([]);
    expect(transport.wire).toHaveBeenCalledOnce();
  });

  it('refuses an admission that fails to persist, without publishing a pending card', () => {
    const published = vi.fn();
    service.requests.subscribe(published);
    database.sqlite.exec(
      "CREATE TRIGGER reject_request BEFORE INSERT ON pending_server_requests BEGIN SELECT RAISE(ABORT, 'write failed'); END",
    );
    transport.receive(fileApprovalFixture().request);
    expect(published).not.toHaveBeenCalled();
    expect(transport.wire).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 31,
        error: {
          code: -32603,
          message: expect.stringContaining('could not admit') as unknown,
        },
      }),
    );
    expect(service.listPending()).toEqual([]);
  });

  it('commits the decision before the transport can observe it', () => {
    transport.receive(permissionApprovalFixture());
    const row = service.listPending()[0];
    transport.wire.mockImplementation(() => {
      expect(
        database.db
          .select()
          .from(pendingServerRequests)
          .where(eq(pendingServerRequests.instanceId, row.instanceId))
          .get()?.status,
      ).toBe('submitted');
    });
    controller.respond('17', {
      instanceId: row.instanceId,
      result: { decision: 'accept' },
    });
    expect(transport.wire).toHaveBeenCalledOnce();
  });

  it('sends no bytes if the local decision cannot be committed', () => {
    transport.receive(permissionApprovalFixture());
    const row = service.listPending()[0];
    database.sqlite.exec(
      "CREATE TRIGGER reject_decision BEFORE UPDATE ON pending_server_requests BEGIN SELECT RAISE(ABORT, 'commit failed'); END",
    );
    expect(() =>
      controller.respond('17', {
        instanceId: row.instanceId,
        result: { decision: 'accept' },
      }),
    ).toThrow('commit failed');
    expect(transport.wire).not.toHaveBeenCalled();
    database.sqlite.exec('DROP TRIGGER reject_decision');
    expect(service.listPending()[0].status).toBe('pending');
  });

  it('fails corrupt-parameter projection before committing or sending', () => {
    transport.receive(permissionApprovalFixture());
    const row = service.listPending()[0];
    database.db
      .update(pendingServerRequests)
      .set({ paramsJson: '{' })
      .where(eq(pendingServerRequests.instanceId, row.instanceId))
      .run();
    expect(() =>
      controller.respond('17', {
        instanceId: row.instanceId,
        result: { decision: 'decline' },
      }),
    ).toThrow(SyntaxError);
    expect(transport.wire).not.toHaveBeenCalled();
    expect(database.db.select().from(pendingServerRequests).get()?.status).toBe(
      'pending',
    );
  });
});
