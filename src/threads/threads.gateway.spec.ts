import { Subject } from 'rxjs';
import { ThreadMetadataService } from './thread-metadata.service';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';
import { Test, TestingModule } from '@nestjs/testing';
import { ThreadsGateway } from './threads.gateway';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { AuthService } from '../auth/auth.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { permissionApprovalFixture } from '../pending-approvals/pending-approvals.testing';

describe('ThreadsGateway', () => {
  let gateway: ThreadsGateway;
  const metadataChanges = new Subject<void>();
  const pendingChanges = new Subject<void>();
  const branchChanges = new Subject<void>();
  const listeners: Record<string, (...args: unknown[]) => void> = {};

  const mockManager = {
    addListener: vi.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        listeners[event] = handler;
      },
    ),
    getClient: vi.fn(),
    getGeneration: () => 1,
  };

  const mockAuthService = {
    authenticateToken: vi.fn(),
  };

  const mockPendingApprovals = {
    changes: pendingChanges,
    recordServerRequest: vi.fn(),
    markResolved: vi.fn(),
    respondToRequest: vi.fn(),
    listPending: vi.fn().mockReturnValue([]),
  };

  /** Captures the gateway's release listener so tests can fire it directly. */
  let releaseListener: ((threadIds: string[]) => void) | null = null;

  const mockDeletionRegistry = {
    isDeleting: vi.fn().mockReturnValue(false),
    onRelease: vi.fn((listener: (threadIds: string[]) => void) => {
      releaseListener = listener;
      return () => undefined;
    }),
  };

  const mockServer = {
    to: vi.fn().mockReturnThis(),
    emit: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadsGateway,
        {
          provide: ThreadMetadataService,
          useValue: { changes: metadataChanges },
        },
        {
          provide: ConversationBranchesService,
          useValue: { changes: branchChanges },
        },
        {
          provide: ConversationBranchMutationsService,
          useValue: { changes: branchChanges },
        },
        { provide: CodexProcessManager, useValue: mockManager },
        { provide: AuthService, useValue: mockAuthService },
        { provide: PendingApprovalsService, useValue: mockPendingApprovals },
        {
          provide: ThreadDeletionRegistryService,
          useValue: mockDeletionRegistry,
        },
      ],
    }).compile();

    gateway = module.get(ThreadsGateway);
    gateway.server = mockServer as never;
    gateway.afterInit();

    vi.clearAllMocks();
    mockServer.to.mockReturnThis();
    mockDeletionRegistry.isDeleting.mockReturnValue(false);
  });

  afterEach(() => gateway.onModuleDestroy());

  it('should join room on subscribe', () => {
    const client = { id: 'c1', join: vi.fn() };
    const result = gateway.handleSubscribe(client as never, {
      threadId: 't1',
    });
    expect(client.join).toHaveBeenCalledWith('thread:t1');
    expect(result).toEqual({ ok: true });
  });

  it('forwards network-only context and structured additional permissions intact', () => {
    const request = permissionApprovalFixture();
    listeners.serverRequest(request);
    expect(mockPendingApprovals.recordServerRequest).toHaveBeenCalledWith(
      request,
    );
    expect(mockServer.emit).toHaveBeenCalledWith(
      'codex.serverRequest',
      request,
    );
    expect(request.params).not.toHaveProperty('additionalPermissions.network');
  });

  it('should leave room on unsubscribe', () => {
    const client = { id: 'c1', leave: vi.fn() };
    const result = gateway.handleUnsubscribe(client as never, {
      threadId: 't1',
    });
    expect(client.leave).toHaveBeenCalledWith('thread:t1');
    expect(result).toEqual({ ok: true });
  });

  it('should route thread-scoped notification to room', () => {
    const notification = {
      method: 'item/agentMessage/delta',
      params: { threadId: 't1', text: 'hello' },
    };

    listeners['notification'](notification);

    expect(mockServer.to).toHaveBeenCalledWith('thread:t1');
    expect(mockServer.emit).toHaveBeenCalledWith(
      'codex.notification',
      notification,
    );
  });

  it('removes misalignment steering before emitting an error to clients', () => {
    listeners['notification']({
      method: 'error',
      params: {
        threadId: 't1',
        turnId: 'turn1',
        willRetry: false,
        error: {
          message: 'blocked',
          codexErrorInfo: 'misalignmentPolicyViolation',
          additionalDetails: null,
          misalignment: {
            errorType: 'policy',
            detailedExplanation: 'display this',
            steer: { message: 'do not send this' },
          },
        },
      },
    });

    expect(mockServer.emit).toHaveBeenCalledWith('codex.notification', {
      method: 'error',
      params: {
        threadId: 't1',
        turnId: 'turn1',
        willRetry: false,
        error: {
          message: 'blocked',
          codexErrorInfo: 'misalignmentPolicyViolation',
          additionalDetails: null,
          misalignment: {
            errorType: 'policy',
            detailedExplanation: 'display this',
          },
        },
      },
    });
  });

  it('should broadcast non-thread notifications', () => {
    const notification = {
      method: 'error',
      params: { message: 'something broke' },
    };

    listeners['notification'](notification);

    expect(mockServer.to).not.toHaveBeenCalled();
    expect(mockServer.emit).toHaveBeenCalledWith(
      'codex.notification',
      notification,
    );
  });

  it('withholds server requests for a thread being deleted', () => {
    mockDeletionRegistry.isDeleting.mockReturnValue(true);

    listeners['serverRequest']({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't1', turnId: 'turn1', itemId: 'item1' },
    });

    expect(mockPendingApprovals.recordServerRequest).toHaveBeenCalled();
    expect(mockServer.emit).not.toHaveBeenCalled();
  });

  it('replays a withheld request when the delete releases without destroying it', () => {
    mockDeletionRegistry.isDeleting.mockReturnValue(true);
    listeners['serverRequest']({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't1', turnId: 'turn1', itemId: 'item1' },
    });

    // Still pending means the delete aborted: cleanup cancels these rows for
    // threads it actually destroyed.
    mockPendingApprovals.listPending.mockReturnValue([{ requestId: '7' }]);
    releaseListener?.(['t1']);

    expect(mockServer.to).toHaveBeenCalledWith('thread:t1');
    expect(mockServer.emit).toHaveBeenCalledWith('codex.serverRequest', {
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't1', turnId: 'turn1', itemId: 'item1' },
    });
  });

  it('does not replay a withheld request whose thread was destroyed', () => {
    mockDeletionRegistry.isDeleting.mockReturnValue(true);
    listeners['serverRequest']({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't1', turnId: 'turn1', itemId: 'item1' },
    });

    mockPendingApprovals.listPending.mockReturnValue([]);
    releaseListener?.(['t1']);

    expect(mockServer.emit).not.toHaveBeenCalledWith(
      'codex.serverRequest',
      expect.anything(),
    );
    expect(mockServer.emit).toHaveBeenCalledWith(
      'conversation.pending.changed',
      { generation: 1 },
    );
  });

  it('should accept connection with valid token', async () => {
    mockAuthService.authenticateToken.mockResolvedValue({
      ok: true,
      authType: 'apiKey',
    });
    const client = {
      id: 'c1',
      handshake: { auth: { token: 'test-api-key' }, headers: {} },
      join: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    await gateway.handleConnection(client as never);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('should reject connection with invalid token', async () => {
    mockAuthService.authenticateToken.mockResolvedValue({
      ok: false,
      reason: 'invalidToken',
    });
    const client = {
      id: 'c2',
      handshake: { auth: { token: 'wrong-key' }, headers: {} },
      join: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    await gateway.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('should reject connection with no token', async () => {
    mockAuthService.authenticateToken.mockResolvedValue({
      ok: false,
      reason: 'missingToken',
    });
    const client = {
      id: 'c3',
      handshake: { auth: {}, headers: {} },
      join: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    await gateway.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('should accept connection with Bearer authorization header', async () => {
    mockAuthService.authenticateToken.mockResolvedValue({
      ok: true,
      authType: 'jwt',
    });
    const client = {
      id: 'c4',
      handshake: {
        auth: {},
        headers: { authorization: 'Bearer some-jwt-token' },
      },
      join: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    await gateway.handleConnection(client as never);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('should accept connection with Bearer-prefixed auth token', async () => {
    mockAuthService.authenticateToken.mockResolvedValue({
      ok: true,
      authType: 'jwt',
    });
    const client = {
      id: 'c5',
      handshake: { auth: { token: 'Bearer some-jwt-token' }, headers: {} },
      join: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    await gateway.handleConnection(client as never);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('should forward server response through pending approval service', () => {
    gateway.handleServerResponse({ id: 'socket-1' } as never, {
      id: 42,
      result: { approved: true },
    });

    expect(mockPendingApprovals.respondToRequest).toHaveBeenCalledWith(
      '42',
      { approved: true },
      'socket-1',
    );
  });
  it('broadcasts content-free overview and pending invalidations only to authenticated sockets', () => {
    metadataChanges.next();
    expect(mockServer.to).toHaveBeenLastCalledWith('webui:authenticated');
    expect(mockServer.emit).toHaveBeenLastCalledWith(
      'conversation.overview.changed',
      { generation: 1 },
    );
    pendingChanges.next();
    expect(mockServer.emit).toHaveBeenCalledWith(
      'conversation.pending.changed',
      { generation: 1 },
    );
  });

  it('does not turn item output into overview refreshes', () => {
    listeners.notification({
      method: 'item/agentMessage/delta',
      params: { threadId: 't', delta: 'output' },
    });
    expect(mockServer.emit).not.toHaveBeenCalledWith(
      'conversation.overview.changed',
      expect.anything(),
    );
  });
});
