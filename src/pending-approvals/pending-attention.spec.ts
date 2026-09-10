/** Exercises attention delivery with the real pending service, SQLite and deletion guard. */
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { createTestDatabase } from '../database/database.testing';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import type {
  CodexProcessManager,
  CodexLifecycleEvent,
} from '../codex/codex-process-manager.service';
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
import type { PendingServerRequestEvent } from './dto/pending-approvals.dto';

describe('global human attention', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let service: PendingApprovalsService;
  let controller: PendingApprovalsController;
  let guard: ThreadDeletionRegistryService;
  let gateway: ThreadsGateway;
  let generation: number;
  let lifecycle: (event: CodexLifecycleEvent) => void;
  let listeners: Record<string, (value: unknown) => void>;
  let events: Array<{ room: string | null; event: string; payload: unknown }>;
  const respond = vi.fn();

  beforeEach(() => {
    database = createTestDatabase();
    guard = new ThreadDeletionRegistryService();
    generation = 1;
    listeners = {};
    events = [];
    respond.mockReset();
    const manager = {
      getGeneration: () => generation,
      getClient: () => ({ respondToServerRequest: respond }),
      addLifecycleListener: (listener: typeof lifecycle) => {
        lifecycle = listener;
      },
      addListener: (name: string, listener: (value: unknown) => void) => {
        listeners[name] = listener;
      },
    } as unknown as CodexProcessManager;
    service = new PendingApprovalsService(
      database.db,
      manager,
      guard,
      new CatalogAdmissionService(),
    );
    service.onModuleInit();
    controller = new PendingApprovalsController(service);
    const changes = { changes: new Subject<void>() };
    gateway = new ThreadsGateway(
      manager,
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
    vi.restoreAllMocks();
    gateway.onModuleDestroy();
    database.sqlite.close();
  });

  /** Reads only the live attention channel; transcript item forwarding is tested separately. */
  function requests() {
    return events.filter((entry) => entry.event === 'codex.serverRequest');
  }
  /** Committed retirement must reach the authenticated audience independently of transcript rooms. */
  function retirements() {
    return events.filter(
      (entry) => entry.event === 'conversation.pending.resolved',
    );
  }
  /**
   * Drives the item event ahead of its approval, which is the ordering the
   * probe observed but has not yet proven. The unaccompanied case below covers
   * the other side, so no test depends on this ordering holding.
   */
  function publishFile(id: number | string = 31) {
    const fixture = fileApprovalFixture(id);
    listeners.notification(fixture.started);
    listeners.serverRequest(fixture.request);
    return fixture;
  }

  it('publishes a complete change set before its hint, readable by a browser with no thread rooms', () => {
    const snapshots: unknown[] = [];
    const subscription = service.changes.subscribe(() =>
      snapshots.push(controller.listPending().requests),
    );
    const fixture = publishFile();
    const expectedSubject = { type: 'fileChange', changes: fixture.changes };
    expect(requests()).toEqual([
      {
        room: 'webui:authenticated',
        event: 'codex.serverRequest',
        payload: {
          ...fixture.request,
          generation: 1,
          reviewSubject: expectedSubject,
        },
      },
    ]);
    expect(snapshots).toEqual([
      [expect.objectContaining({ reviewSubject: expectedSubject })],
    ]);
    const read = controller.listPending();
    expect(read.generation).toBe(1);
    expect(read.requests[0].params).toEqual(fixture.request.params);
    expect(read.requests[0].reviewSubject).toEqual(expectedSubject);
    expect(events).toContainEqual({
      room: 'thread:t1',
      event: 'codex.notification',
      payload: fixture.started,
    });
    subscription.unsubscribe();
  });

  it('keeps request context after item completion and protects it from later mutations', () => {
    const fixture = publishFile();
    fixture.changes[0].diff = 'mutated upstream object';
    const live = requests()[0].payload as PendingServerRequestEvent;
    live.reviewSubject!.changes[1].diff = 'mutated outgoing object';
    listeners.notification({
      method: 'item/completed',
      params: fixture.started.params,
    });
    const subject = controller.listPending().requests[0].reviewSubject!;
    expect(subject.changes[0].diff).toContain('ALPHA_EDITED');
    expect(subject.changes[1].diff).toBe('-BETA\n');
  });

  it('publishes an unaccompanied file approval with a null subject rather than stranding it', () => {
    // No item/started, so nothing was retained. Dropping the request would
    // block app-server on an answer no browser was offered; publishing it with
    // no subject states plainly that the changes cannot be shown.
    const fixture = fileApprovalFixture();
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      /* asserted, not printed */
    });
    listeners.serverRequest(fixture.request);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('published without its change set'),
    );
    expect(requests()[0].payload).toMatchObject({
      method: 'item/fileChange/requestApproval',
      reviewSubject: null,
    });
    const stored = controller.listPending().requests;
    expect(stored).toHaveLength(1);
    expect(stored[0].reviewSubject).toBeNull();
    // A later item does not retroactively change the subject this request was
    // published with. The legacy socket response must enforce the same rule as REST.
    listeners.notification(fixture.started);
    expect(controller.listPending().requests[0].reviewSubject).toBeNull();
    expect(() =>
      gateway.handleServerResponse({ id: 'old-browser' } as never, {
        id: 31,
        result: { decision: 'accept' },
      }),
    ).toThrow('change set');
    expect(respond).not.toHaveBeenCalled();
    // Still answerable: declining is what unblocks the agent.
    service.respondToRequest('31', { decision: 'decline' });
    expect(respond).toHaveBeenCalledWith(31, { decision: 'decline' });
    error.mockRestore();
  });

  it('does not cross-wire interleaved proposals with the same item ID in different conversations', () => {
    const first = fileApprovalFixture('first');
    const second = fileApprovalFixture('second');
    second.started.params.threadId = 't2';
    second.request.params.threadId = 't2';
    second.changes[0].diff = 'second conversation proposal';
    listeners.notification(first.started);
    listeners.notification(second.started);
    listeners.serverRequest(second.request);
    listeners.serverRequest(first.request);
    expect(
      controller.listPending('t1').requests[0].reviewSubject?.changes,
    ).toEqual(first.changes);
    expect(
      controller.listPending('t2').requests[0].reviewSubject?.changes,
    ).toEqual(second.changes);
  });

  it('refuses intersecting deletion reads without hiding rows in a successful snapshot, then replays the full subject', () => {
    guard.begin(['t1']);
    const fixture = publishFile();
    expect(requests()).toEqual([]);
    expect(
      events.some((entry) => entry.event === 'conversation.pending.changed'),
    ).toBe(false);
    expect(() => controller.listPending()).toThrow(BusinessException);
    try {
      controller.listPending('t1');
    } catch (error) {
      expect((error as BusinessException).getStatus()).toBe(409);
      expect((error as BusinessException).errorCode).toBe(
        'threads.delete_in_progress',
      );
    }
    expect(controller.listPending(' t2 ')).toEqual({
      generation: 1,
      requests: [],
    });
    expect(service.listPending(['t1'])).toHaveLength(1);
    expect(() =>
      service.respondToRequest('31', { decision: 'accept' }),
    ).toThrow(BusinessException);
    guard.end(['t1']);
    expect(requests()).toEqual([
      {
        room: 'webui:authenticated',
        event: 'codex.serverRequest',
        payload: {
          ...fixture.request,
          generation: 1,
          reviewSubject: { type: 'fileChange', changes: fixture.changes },
        },
      },
    ]);
    expect(controller.listPending().requests).toHaveLength(1);
  });

  it('globally cancels suppressed requests and never replays them after a successful deletion', () => {
    guard.begin(['t1']);
    publishFile();
    service.cancelPendingForThreads(['t1'], 'deleted');
    guard.end(['t1']);
    expect(requests()).toEqual([]);
    expect(retirements()).toEqual([
      {
        room: 'webui:authenticated',
        event: 'conversation.pending.resolved',
        payload: {
          generation: 1,
          requestId: '31',
          threadId: 't1',
          status: 'cancelled',
        },
      },
    ]);
    expect(controller.listPending().requests).toEqual([]);
  });

  it('publishes exactly one neutral retirement for competing responses, after the transaction commits', () => {
    publishFile();
    const pendingCounts: number[] = [];
    const subscription = service.resolvedRequests.subscribe(() =>
      pendingCounts.push(controller.listPending().requests.length),
    );
    service.respondToRequest('31', { decision: 'decline' }, 'browser-a');
    expect(() =>
      service.respondToRequest('31', { decision: 'accept' }, 'browser-b'),
    ).toThrow('already been resolved');
    listeners.notification({
      method: 'serverRequest/resolved',
      params: { threadId: 't1', requestId: 31 },
    });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(31, { decision: 'decline' });
    expect(retirements()).toEqual([
      {
        room: 'webui:authenticated',
        event: 'conversation.pending.resolved',
        payload: {
          generation: 1,
          requestId: '31',
          threadId: 't1',
          status: 'resolved',
        },
      },
    ]);
    expect(pendingCounts).toEqual([0]);
    subscription.unsubscribe();
  });

  it('rolls back a failed response write without dropping the subject or publishing retirement', () => {
    const fixture = publishFile();
    respond.mockImplementation(() => {
      throw new Error('transport closed');
    });
    expect(() => service.respondToRequest('31', {})).toThrow(
      'transport closed',
    );
    expect(retirements()).toEqual([]);
    expect(controller.listPending().requests[0].reviewSubject?.changes).toEqual(
      fixture.changes,
    );
  });

  it('expires the old generation and cannot replay its subject under a reused request ID', () => {
    guard.begin(['t1']);
    publishFile();
    lifecycle({ type: 'appServerRestarting', generation: 1, delayMs: 0 });
    generation = 2;
    const fresh = fileApprovalFixture();
    fresh.changes[0].diff = 'new generation proposal';
    listeners.notification(fresh.started);
    listeners.serverRequest(fresh.request);
    guard.end(['t1']);
    expect(requests()).toHaveLength(1);
    expect(requests()[0].payload).toMatchObject({
      generation: 2,
      reviewSubject: { changes: fresh.changes },
    });
    expect(retirements()[0].payload).toEqual({
      generation: 1,
      requestId: '31',
      threadId: 't1',
      status: 'expired',
    });
  });

  it('publishes upstream resolution and startup expiry without a response from this browser', () => {
    listeners.serverRequest(permissionApprovalFixture());
    listeners.notification({
      method: 'serverRequest/resolved',
      params: { threadId: 't1', requestId: 17 },
    });
    publishFile();
    service.onModuleInit();
    expect(retirements().map((entry) => entry.payload)).toEqual([
      { generation: 1, requestId: '17', threadId: 't1', status: 'resolved' },
      { generation: 1, requestId: '31', threadId: 't1', status: 'expired' },
    ]);
    expect(controller.listPending()).toEqual({ generation: 1, requests: [] });
  });

  it.each([
    'item/tool/call',
    'account/chatgptAuthTokens/refresh',
    'attestation/generate',
    'currentTime/read',
    'future/request',
  ])('does not broadcast or persist machine/unknown request %s', (method) => {
    const request = { id: 1, method, params: { threadId: 't1' } };
    listeners.serverRequest(request);
    expect(events).toEqual([]);
    expect(controller.listPending().requests).toEqual([]);
  });

  it.each([
    'item/tool/requestUserInput',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request',
  ])(
    'delivers self-contained human request %s globally with its original parameters',
    (method) => {
      const params = {
        threadId: 't1',
        turnId: null,
        questions: [{ question: 'Choose' }],
        permissions: {},
        requestedSchema: { type: 'object' },
        isBlocking: false,
      };
      listeners.serverRequest({ id: 'opaque-id', method, params });
      expect(requests()[0]).toEqual({
        room: 'webui:authenticated',
        event: 'codex.serverRequest',
        payload: {
          id: 'opaque-id',
          method,
          params,
          generation: 1,
          reviewSubject: null,
        },
      });
      expect(controller.listPending().requests[0].params).toEqual(params);
    },
  );
});
