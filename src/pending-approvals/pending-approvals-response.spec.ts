/** Response authorization must survive missing context, duplicate delivery and corrupt persistence. */
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '../database/database.testing';
import { pendingServerRequests } from '../database/schema';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import type { CodexProcessManager } from '../codex/codex-process-manager.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { PendingApprovalsService } from './pending-approvals.service';
import { PendingApprovalsController } from './pending-approvals.controller';
import { fileApprovalFixture } from './pending-approvals.testing';

describe('pending response authorization', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let service: PendingApprovalsService;
  let controller: PendingApprovalsController;
  const respond = vi.fn();
  const retired = vi.fn();

  beforeEach(() => {
    database = createTestDatabase();
    respond.mockReset();
    retired.mockReset();
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
    service.resolvedRequests.subscribe(retired);
    controller = new PendingApprovalsController(service);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    database.sqlite.close();
  });

  it.each(['accept', 'acceptForSession', {}, undefined])(
    'rejects an unseen file decision %j without retiring the request',
    (decision) => {
      service.recordServerRequest(fileApprovalFixture().request);
      expect(() => controller.respond('31', { result: { decision } })).toThrow(
        'change set',
      );
      expect(respond).not.toHaveBeenCalled();
      expect(retired).not.toHaveBeenCalled();
      expect(service.readPending().requests[0]).toMatchObject({
        status: 'pending',
        reviewSubject: null,
      });
    },
  );

  it.each(['decline', 'cancel'])(
    'allows %s without a file subject',
    (decision) => {
      service.recordServerRequest(fileApprovalFixture().request);
      controller.respond('31', { result: { decision } });
      expect(respond).toHaveBeenCalledWith(31, { decision });
      expect(service.readPending().requests).toEqual([]);
    },
  );

  it('does not attach an old subject when an upsert replaces request identities and capture misses', () => {
    const original = fileApprovalFixture();
    service.observeNotification(original.started);
    service.recordServerRequest(original.request);
    const duplicate = fileApprovalFixture();
    duplicate.request.params.threadId = 'other-thread';
    duplicate.request.params.itemId = 'unseen-item';
    service.recordServerRequest(duplicate.request);
    expect(service.readPending().requests[0]).toMatchObject({
      threadId: 'other-thread',
      itemId: 'unseen-item',
      reviewSubject: null,
    });
    controller.respond('31', { result: { decision: 'decline' } });
    expect(service.readPending().requests).toEqual([]);
  });

  it('does not retain a staged subject when persistence fails before publication', () => {
    const original = fileApprovalFixture();
    service.observeNotification(original.started);
    database.sqlite.exec(
      "CREATE TRIGGER reject_request BEFORE INSERT ON pending_server_requests BEGIN SELECT RAISE(ABORT, 'write failed'); END",
    );
    expect(() => service.recordServerRequest(original.request)).toThrow(
      'write failed',
    );
    database.sqlite.exec('DROP TRIGGER reject_request');
    const replacement = fileApprovalFixture();
    replacement.request.params.itemId = 'unseen-item';
    service.recordServerRequest(replacement.request);
    expect(service.readPending().requests[0].reviewSubject).toBeNull();
    expect(() =>
      controller.respond('31', { result: { decision: 'accept' } }),
    ).toThrow('change set');
    expect(respond).not.toHaveBeenCalled();
  });

  it('fails projection before writing to app-server when stored parameters are corrupt', () => {
    const fixture = fileApprovalFixture();
    service.observeNotification(fixture.started);
    service.recordServerRequest(fixture.request);
    database.db
      .update(pendingServerRequests)
      .set({ paramsJson: '{' })
      .where(eq(pendingServerRequests.requestId, '31'))
      .run();
    expect(() =>
      controller.respond('31', { result: { decision: 'decline' } }),
    ).toThrow(SyntaxError);
    expect(respond).not.toHaveBeenCalled();
    expect(retired).not.toHaveBeenCalled();
    expect(database.db.select().from(pendingServerRequests).get()?.status).toBe(
      'pending',
    );
    service.onModuleInit();
    expect(service.readPending().requests).toEqual([]);
  });

  it('keeps the committed subject when a replacement upsert fails', () => {
    const original = fileApprovalFixture();
    service.observeNotification(original.started);
    service.recordServerRequest(original.request);
    const replacement = fileApprovalFixture();
    replacement.changes[0].diff = 'replacement proposal';
    service.observeNotification(replacement.started);
    database.sqlite.exec(
      "CREATE TRIGGER reject_request BEFORE INSERT ON pending_server_requests BEGIN SELECT RAISE(ABORT, 'write failed'); END",
    );
    expect(() => service.recordServerRequest(replacement.request)).toThrow(
      'write failed',
    );
    expect(service.readPending().requests[0].reviewSubject?.changes).toEqual(
      original.changes,
    );
  });

  it('clears file context when an upsert changes to a self-contained request', () => {
    const fixture = fileApprovalFixture();
    service.observeNotification(fixture.started);
    service.recordServerRequest(fixture.request);
    service.recordServerRequest({
      id: 31,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'input',
        questions: [],
        isBlocking: true,
        autoResolutionMs: null,
      },
    });
    expect(service.readPending().requests[0].reviewSubject).toBeNull();
  });
});
