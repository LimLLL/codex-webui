import { Test, TestingModule } from '@nestjs/testing';
import { ThreadsGateway } from './threads.gateway';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { AuthService } from '../auth/auth.service';
import { ActiveThreadRegistryService } from './active-thread-registry.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';

describe('ThreadsGateway', () => {
  let gateway: ThreadsGateway;
  const listeners: Record<string, (...args: unknown[]) => void> = {};

  const mockManager = {
    addListener: jest.fn(
      (event: string, handler: (...args: unknown[]) => void) => {
        listeners[event] = handler;
      },
    ),
    getClient: jest.fn(),
  };

  const mockAuthService = {
    authenticateToken: jest.fn(),
  };

  const mockActiveThreads = {
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    removeSocket: jest.fn(),
  };

  const mockPendingApprovals = {
    recordServerRequest: jest.fn(),
    markResolved: jest.fn(),
    respondToRequest: jest.fn(),
    listPending: jest.fn().mockReturnValue([]),
  };

  /** Captures the gateway's release listener so tests can fire it directly. */
  let releaseListener: ((threadIds: string[]) => void) | null = null;

  const mockDeletionRegistry = {
    isDeleting: jest.fn().mockReturnValue(false),
    onRelease: jest.fn((listener: (threadIds: string[]) => void) => {
      releaseListener = listener;
      return () => undefined;
    }),
  };

  const mockServer = {
    to: jest.fn().mockReturnThis(),
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadsGateway,
        { provide: CodexProcessManager, useValue: mockManager },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ActiveThreadRegistryService, useValue: mockActiveThreads },
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

    jest.clearAllMocks();
    mockServer.to.mockReturnThis();
    mockDeletionRegistry.isDeleting.mockReturnValue(false);
  });

  it('should join room on subscribe', () => {
    const client = { id: 'c1', join: jest.fn() };
    const result = gateway.handleSubscribe(client as never, {
      threadId: 't1',
    });
    expect(client.join).toHaveBeenCalledWith('thread:t1');
    expect(mockActiveThreads.subscribe).toHaveBeenCalledWith('c1', 't1');
    expect(result).toEqual({ ok: true });
  });

  it('should leave room on unsubscribe', () => {
    const client = { id: 'c1', leave: jest.fn() };
    const result = gateway.handleUnsubscribe(client as never, {
      threadId: 't1',
    });
    expect(client.leave).toHaveBeenCalledWith('thread:t1');
    expect(mockActiveThreads.unsubscribe).toHaveBeenCalledWith('c1', 't1');
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

    expect(mockServer.emit).not.toHaveBeenCalled();
  });

  it('should accept connection with valid token', async () => {
    mockAuthService.authenticateToken.mockResolvedValue({
      ok: true,
      authType: 'apiKey',
    });
    const client = {
      id: 'c1',
      handshake: { auth: { token: 'test-api-key' }, headers: {} },
      disconnect: jest.fn(),
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
      disconnect: jest.fn(),
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
      disconnect: jest.fn(),
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
      disconnect: jest.fn(),
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
      disconnect: jest.fn(),
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
});
