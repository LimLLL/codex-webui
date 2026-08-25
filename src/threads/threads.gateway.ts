/**
 * WebSocket gateway for real-time thread events.
 * Clients subscribe to specific threads and receive Codex app-server
 * notifications (deltas, item lifecycle, turn lifecycle, etc.) in real time.
 */
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification, ServerRequest } from '../codex/codex-schema';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { ActiveThreadRegistryService } from './active-thread-registry.service';

/** A server request held back while its thread was inside a delete. */
interface SuppressedServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export type CodexSocketLifecycleEvent =
  | { type: 'appServerRestarting'; generation: number; delayMs: number }
  | { type: 'appServerUnavailable'; generation: number; message: string }
  | { type: 'appServerReady'; generation: number; restarted: boolean }
  | {
      type: 'autoResumeCompleted';
      generation: number;
      resumedThreadIds: string[];
      failedThreadIds: string[];
    };

@WebSocketGateway({ namespace: '/ws', cors: { origin: '*' } })
export class ThreadsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ThreadsGateway.name);

  @WebSocketServer()
  server!: Server;

  /** Requests withheld per thread while a delete held that thread's guard. */
  private readonly suppressedRequests = new Map<
    string,
    SuppressedServerRequest[]
  >();

  constructor(
    private readonly codexManager: CodexProcessManager,
    private readonly authService: AuthService,
    private readonly activeThreads: ActiveThreadRegistryService,
    private readonly pendingApprovals: PendingApprovalsService,
    private readonly deletionRegistry: ThreadDeletionRegistryService,
  ) {}

  afterInit(): void {
    this.codexManager.addListener(
      'notification',
      (notification: ServerNotification) => {
        this.handleCodexNotification(notification);
      },
    );

    this.codexManager.addListener('serverRequest', (request: ServerRequest) => {
      this.handleCodexServerRequest(request);
    });

    this.deletionRegistry.onRelease((threadIds) => {
      this.replaySuppressedRequests(threadIds);
    });

    this.logger.log('ThreadsGateway initialized');
  }

  /** Validates auth token on connection; disconnects unauthorized clients. */
  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractSocketToken(client);

    if (!(await this.authService.authenticateToken(token, client.id)).ok) {
      this.logger.warn(`Rejected unauthenticated socket: ${client.id}`);
      client.disconnect(true);
      return;
    }

    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
    this.activeThreads.removeSocket(client.id);
  }

  /**
   * Client subscribes to a thread's real-time events.
   * Uses socket.io rooms keyed by threadId.
   */
  @SubscribeMessage('thread.subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId?: unknown } | null | undefined,
  ): { ok: boolean } {
    const threadId = this.parseThreadId(data);
    const room = `thread:${threadId}`;
    void client.join(room);
    this.activeThreads.subscribe(client.id, threadId);
    this.logger.debug(`Client ${client.id} subscribed to ${room}`);
    return { ok: true };
  }

  /** Client unsubscribes from a thread's events. */
  @SubscribeMessage('thread.unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId?: unknown } | null | undefined,
  ): { ok: boolean } {
    const threadId = this.parseThreadId(data);
    const room = `thread:${threadId}`;
    void client.leave(room);
    this.activeThreads.unsubscribe(client.id, threadId);
    this.logger.debug(`Client ${client.id} unsubscribed from ${room}`);
    return { ok: true };
  }

  /**
   * Routes Codex app-server notifications to subscribed clients.
   * Extracts threadId from notification params and emits to the room.
   */
  private handleCodexNotification(notification: ServerNotification): void {
    if (notification.method === 'serverRequest/resolved') {
      this.pendingApprovals.markResolved(notification);
    }

    const params = notification.params as Record<string, unknown> | undefined;
    const threadId = params?.['threadId'] as string | undefined;

    if (threadId) {
      this.server
        .to(`thread:${threadId}`)
        .emit('codex.notification', notification);
    } else {
      // Broadcast non-thread-scoped notifications to all connected clients
      this.server.emit('codex.notification', notification);
    }
  }

  /**
   * Re-emits requests withheld during a delete that did not destroy the thread.
   *
   * Without this the app-server is still blocked waiting on a request no client
   * ever saw, and nothing short of a page reload brings the card back. Requests
   * belonging to threads that really were destroyed are cancelled during local
   * cleanup, so filtering on rows that are still pending is what keeps this from
   * resurrecting cards for conversations that are gone.
   *
   * @param threadIds - Threads whose delete guard was just released
   */
  private replaySuppressedRequests(threadIds: string[]): void {
    for (const threadId of threadIds) {
      const held = this.suppressedRequests.get(threadId);
      if (!held) continue;
      this.suppressedRequests.delete(threadId);

      const stillPending = new Set(
        this.pendingApprovals
          .listPending([threadId])
          .map((row) => row.requestId),
      );
      for (const request of held) {
        if (!stillPending.has(String(request.id))) continue;
        this.server
          .to(`thread:${threadId}`)
          .emit('codex.serverRequest', request);
        this.logger.log(
          `Replayed suppressed server request ${String(request.id)} for thread ${threadId}`,
        );
      }
    }
  }

  /**
   * Routes Codex server-initiated requests (e.g. approval) to subscribed clients.
   * The first client to respond wins; response is forwarded back to app-server.
   */
  private handleCodexServerRequest(request: ServerRequest): void {
    const params = request.params as Record<string, unknown> | undefined;
    const threadId = params?.['threadId'] as string | undefined;
    const requestId = (request as unknown as { id: number | string }).id;

    this.pendingApprovals.recordServerRequest(request);

    // Suppressed rather than terminalized: the row stays pending so an aborted
    // delete leaves the request answerable, but there is no point surfacing a
    // card for a conversation the user just chose to destroy. Held here so the
    // guard's release can put it back on screen if the delete does abort.
    if (threadId && this.deletionRegistry.isDeleting(threadId)) {
      const held = this.suppressedRequests.get(threadId) ?? [];
      held.push({
        id: requestId,
        method: request.method,
        params: params ?? {},
      });
      this.suppressedRequests.set(threadId, held);
      return;
    }

    const target = threadId
      ? this.server.to(`thread:${threadId}`)
      : this.server;

    target.emit('codex.serverRequest', {
      id: requestId,
      method: request.method,
      params: request.params,
    });
  }

  /**
   * Client responds to a server-initiated request (e.g. approval decision).
   * Kept for backward compatibility; REST responses use persisted CAS semantics.
   */
  @SubscribeMessage('codex.serverResponse')
  handleServerResponse(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { id: number | string; result: unknown },
  ): void {
    this.pendingApprovals.respondToRequest(
      String(data.id),
      data.result,
      client.id,
    );
  }

  /** Emits WebUI lifecycle events that are not app-server notifications. */
  emitLifecycle(event: CodexSocketLifecycleEvent): void {
    this.server.emit('codex.lifecycle', event);
  }

  /** Validates thread room payloads from untrusted socket clients. */
  private parseThreadId(
    data: { threadId?: unknown } | null | undefined,
  ): string {
    const threadId =
      typeof data?.threadId === 'string' ? data.threadId.trim() : '';
    if (!threadId) {
      throw new WsException('threadId must be a non-empty string');
    }
    return threadId;
  }

  /** Extracts auth token from socket handshake (mirrors ApiKeyGuard logic). */
  private extractSocketToken(client: Socket): string | null {
    const authToken = (client.handshake.auth as Record<string, unknown>)?.[
      'token'
    ];
    if (typeof authToken === 'string' && authToken.trim()) {
      return authToken.startsWith('Bearer ')
        ? authToken.slice(7).trim()
        : authToken;
    }

    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7).trim();
    }

    return null;
  }
}
