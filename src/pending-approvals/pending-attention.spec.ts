/** Real ingress, persistence and gateway delivery across browser/deletion lifetimes. */
import { Subject } from 'rxjs';
import { createTestDatabase } from '../database/database.testing';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import type { AuthService } from '../auth/auth.service';
import { BusinessException } from '../common/business.exception';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { ThreadsGateway } from '../threads/threads.gateway';
import type { ThreadMetadataService } from '../threads/thread-metadata.service';
import type { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import type { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';
import { PendingApprovalsService } from './pending-approvals.service';
import { PendingApprovalsController } from './pending-approvals.controller';
import {
  fileApprovalFixture,
  permissionApprovalFixture,
} from './pending-approvals.testing';
import { createRequestManager } from './request-owner.testing';
import type { PendingServerRequestEvent } from './dto/pending-approvals.dto';

describe('global human attention', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let transport: ReturnType<typeof createRequestManager>;
  let service: PendingApprovalsService;
  let controller: PendingApprovalsController;
  let guard: ThreadDeletionRegistryService;
  let gateway: ThreadsGateway;
  let events: Array<{ room: string | null; event: string; payload: unknown }>;
  beforeEach(() => {
    database = createTestDatabase();
    transport = createRequestManager();
    guard = new ThreadDeletionRegistryService();
    events = [];
    service = new PendingApprovalsService(
      database.db,
      transport.manager,
      guard,
      new CatalogAdmissionService(),
    );
    service.onModuleInit();
    controller = new PendingApprovalsController(service);
    const changes = { changes: new Subject<void>() };
    gateway = new ThreadsGateway(
      transport.manager,
      {
        authenticateToken: () => Promise.resolve({ ok: true }),
      } as unknown as AuthService,
      service,
      guard,
      changes as unknown as ThreadMetadataService,
      changes as unknown as ConversationBranchesService,
      changes as unknown as ConversationBranchMutationsService,
    );
    gateway.server = {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) =>
          events.push({ room, event, payload }),
      }),
      emit: (event: string, payload: unknown) =>
        events.push({ room: null, event, payload }),
    } as unknown as ThreadsGateway['server'];
    gateway.afterInit();
  });
  afterEach(() => {
    transport.close();
    gateway.onModuleDestroy();
    database.sqlite.close();
  });
  /** Selects only globally actionable request delivery, not transcript events. */
  const requests = () =>
    events.filter((entry) => entry.event === 'codex.serverRequest');
  /** Publishes the measured item-before-approval sequence without a browser room. */
  function publishFile(id: number | string = 31) {
    const fixture = fileApprovalFixture(id);
    transport.notify(fixture.started);
    transport.receive(fixture.request);
    return fixture;
  }

  it('publishes a complete subject and immutable identity before browsers read the hint', () => {
    const snapshots: unknown[] = [];
    service.changes.subscribe(() =>
      snapshots.push(controller.listPending().requests),
    );
    const fixture = publishFile();
    const row = controller.listPending().requests[0];
    expect(requests()[0]).toMatchObject({
      room: 'webui:authenticated',
      payload: {
        id: '31',
        instanceId: row.instanceId,
        params: fixture.request.params,
        reviewSubject: { type: 'fileChange', changes: fixture.changes },
      },
    });
    expect(snapshots).toEqual([
      [
        expect.objectContaining({
          instanceId: row.instanceId,
          reviewSubject: row.reviewSubject,
        }),
      ],
    ]);
    expect(events).toContainEqual({
      room: 'thread:t1',
      event: 'codex.notification',
      payload: fixture.started,
    });
  });

  it('retains immutable file context after item completion and outgoing object mutation', () => {
    const fixture = publishFile();
    fixture.changes[0].diff = 'mutated upstream';
    const live = requests()[0].payload as PendingServerRequestEvent;
    live.reviewSubject!.changes[1].diff = 'mutated projection';
    transport.notify(fixture.completed);
    const subject = controller.listPending().requests[0].reviewSubject!;
    expect(subject.changes[0].diff).toContain('ALPHA_EDITED');
    expect(subject.changes[1].diff).toBe('-BETA\n');
  });

  it('offers denial without a file subject and enforces it on Socket.IO too', () => {
    const fixture = fileApprovalFixture();
    transport.receive(fixture.request);
    const row = controller.listPending().requests[0];
    transport.notify(fixture.started);
    expect(controller.listPending().requests[0].reviewSubject).toBeNull();
    expect(() =>
      gateway.handleServerResponse({ id: 'browser' } as never, {
        id: 31,
        instanceId: row.instanceId,
        result: { decision: 'accept' },
      }),
    ).toThrow('change set');
    expect(() =>
      gateway.handleServerResponse(
        { id: 'old-browser' } as never,
        { id: 31, result: { decision: 'decline' } } as never,
      ),
    ).toThrow('instanceId');
    gateway.handleServerResponse({ id: 'browser' } as never, {
      id: 31,
      instanceId: row.instanceId,
      result: { decision: 'decline' },
    });
    expect(transport.wire).toHaveBeenCalledWith({
      id: 31,
      result: { decision: 'decline' },
    });
  });

  it('does not cross-wire interleaved proposals with the same item ID', () => {
    const first = fileApprovalFixture('first');
    const second = fileApprovalFixture('second');
    second.started.params.threadId = 't2';
    second.request.params.threadId = 't2';
    second.changes[0].diff = 'second proposal';
    transport.notify(first.started);
    transport.notify(second.started);
    transport.receive(second.request);
    transport.receive(first.request);
    expect(
      controller.listPending('t1').requests[0].reviewSubject?.changes,
    ).toEqual(first.changes);
    expect(
      controller.listPending('t2').requests[0].reviewSubject?.changes,
    ).toEqual(second.changes);
  });

  it('withholds intersecting deletion reads and replays an aborted deletion with the same identity', () => {
    guard.begin(['t1']);
    publishFile();
    expect(requests()).toEqual([]);
    expect(() => controller.listPending()).toThrow(BusinessException);
    expect(controller.listPending('t2')).toMatchObject({
      requests: [],
      failures: [],
    });
    const row = service.listPending(['t1'])[0];
    expect(() =>
      service.respondToRequest('31', row.instanceId, { decision: 'accept' }),
    ).toThrow(BusinessException);
    guard.end(['t1']);
    expect(requests()).toHaveLength(1);
    expect(requests()[0].payload).toMatchObject({
      instanceId: row.instanceId,
      reviewSubject: row.reviewSubject,
    });
  });

  it('never replays a request after successful deletion', () => {
    guard.begin(['t1']);
    publishFile();
    service.cancelPendingForThreads(['t1'], 'deleted');
    guard.end(['t1']);
    expect(requests()).toEqual([]);
    expect(events).toContainEqual({
      room: 'webui:authenticated',
      event: 'conversation.pending.resolved',
      payload: expect.objectContaining({
        status: 'cancelled',
        instanceId: expect.any(String) as unknown,
      }) as unknown,
    });
    expect(controller.listPending().requests).toEqual([]);
  });

  it('cannot lend a new connection proposal to an old suppressed request', () => {
    guard.begin(['t1']);
    publishFile();
    const old = service.listPending()[0];
    transport.restart(1);
    const fresh = fileApprovalFixture();
    fresh.changes[0].diff = 'new proposal';
    transport.notify(fresh.started);
    transport.receive(fresh.request);
    guard.end(['t1']);
    expect(requests()).toHaveLength(1);
    expect(requests()[0].payload).toMatchObject({
      reviewSubject: { changes: fresh.changes },
    });
    expect(
      (requests()[0].payload as PendingServerRequestEvent).instanceId,
    ).not.toBe(old.instanceId);
  });

  it.each([
    'item/tool/call',
    'account/chatgptAuthTokens/refresh',
    'attestation/generate',
    'currentTime/read',
    'future/request',
    'applyPatchApproval',
    'execCommandApproval',
  ])(
    'refuses %s and retains a client-attributed explanation without creating attention',
    (method) => {
      transport.receive({
        id: 1,
        method,
        params: {
          threadId: 't1',
          turnId: 'turn1',
          accessToken: 'must-not-persist',
        },
      });
      expect(requests()).toEqual([]);
      expect(transport.wire).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          error: expect.any(Object) as unknown,
        }),
      );
      expect(controller.listPending().requests).toEqual([]);
      expect(controller.listPending('t1').failures[0].message).toContain(
        'WebUI',
      );
      expect(JSON.stringify(controller.listPending())).not.toContain(
        'must-not-persist',
      );
      expect(events).toContainEqual({
        room: 'webui:authenticated',
        event: 'codex.serverRequestFailed',
        payload: expect.objectContaining({
          instanceId: expect.any(String) as unknown,
          threadId: 't1',
        }) as unknown,
      });
    },
  );

  it('bounds replayed failures and drops those a restart already made unactionable', () => {
    const now = vi.spyOn(Date, 'now');
    const instances: string[] = [];
    const failures = service.failures.subscribe((failure) =>
      instances.push(failure.instanceId),
    );
    for (let id = 0; id < 25; id += 1) {
      now.mockReturnValue(1000 + id);
      transport.receive({
        id,
        method: 'item/tool/call',
        params: { threadId: 't1', turnId: 'turn1' },
      });
    }
    failures.unsubscribe();
    now.mockReturnValue(2000);
    transport.receive({
      id: 25,
      method: 'item/tool/call',
      params: { threadId: 't2' },
    });
    now.mockRestore();
    // Failure rows are never pruned, so an unbounded read would re-insert the
    // whole refusal history into the transcript on every reconnect.
    expect(
      controller
        .listPending('t1')
        .failures.map((failure) => failure.instanceId),
    ).toEqual(instances.slice(-20));
    transport.restart();
    expect(controller.listPending('t1').failures).toEqual([]);
  });

  it('delivers permissions as a complete selectable scope and restores the same presentation', () => {
    transport.receive({
      id: 'permissions',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 't1',
        turnId: 'turn1',
        itemId: 'permission1',
        cwd: '/workspace',
        permissions: {
          fileSystem:
            permissionApprovalFixture().params.additionalPermissions.fileSystem,
        },
      },
    });
    const row = controller.listPending().requests[0];
    expect(row.presentation).toMatchObject({
      kind: 'permissions',
      supported: true,
      permissions: [
        expect.objectContaining({ access: 'write', label: '/workspace/data' }),
        expect.objectContaining({ access: 'deny', required: true }),
      ],
    });
    expect(
      (requests()[0].payload as PendingServerRequestEvent).presentation,
    ).toEqual(row.presentation);
  });

  it('delivers an unsupported extended MCP form without a turn as Decline/Cancel-only', () => {
    transport.receive({
      id: 'form',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 't1',
        turnId: null,
        serverName: 'integration',
        message: 'Choose',
        mode: 'openaiForm',
        requestedSchema: {
          type: 'object',
          properties: {},
          'x-openai-unknown': true,
        },
      },
    });
    const row = controller.listPending().requests[0];
    expect(row.turnId).toBeNull();
    expect(row.presentation).toMatchObject({ supported: false, fields: [] });
    expect(() =>
      controller.respond('form', {
        instanceId: row.instanceId,
        result: { action: 'accept', content: {} },
      }),
    ).toThrow('unsupported');
    controller.respond('form', {
      instanceId: row.instanceId,
      result: { action: 'cancel', content: null },
    });
    expect(transport.wire).toHaveBeenCalledWith({
      id: 'form',
      result: { action: 'cancel', content: null, _meta: null },
    });
  });
});
