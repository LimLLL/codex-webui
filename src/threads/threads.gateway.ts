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
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification, ServerRequest } from '../codex/codex-schema';

@WebSocketGateway({ namespace: '/ws', cors: { origin: '*' } })
export class ThreadsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ThreadsGateway.name);
  private readonly apiKey: string;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly codexManager: CodexProcessManager,
    configService: ConfigService,
  ) {
    this.apiKey = configService.getOrThrow<string>('WEBUI_API_KEY');
  }

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

    this.logger.log('ThreadsGateway initialized');
  }

  /** Validates auth token on connection; disconnects unauthorized clients. */
  handleConnection(client: Socket): void {
    const token = this.extractSocketToken(client);

    if (token !== this.apiKey) {
      this.logger.warn(`Rejected unauthenticated socket: ${client.id}`);
      client.disconnect(true);
      return;
    }

    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * Client subscribes to a thread's real-time events.
   * Uses socket.io rooms keyed by threadId.
   */
  @SubscribeMessage('thread.subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ): { ok: boolean } {
    const room = `thread:${data.threadId}`;
    void client.join(room);
    this.logger.debug(`Client ${client.id} subscribed to ${room}`);
    return { ok: true };
  }

  /** Client unsubscribes from a thread's events. */
  @SubscribeMessage('thread.unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { threadId: string },
  ): { ok: boolean } {
    const room = `thread:${data.threadId}`;
    void client.leave(room);
    this.logger.debug(`Client ${client.id} unsubscribed from ${room}`);
    return { ok: true };
  }

  /**
   * Routes Codex app-server notifications to subscribed clients.
   * Extracts threadId from notification params and emits to the room.
   */
  private handleCodexNotification(notification: ServerNotification): void {
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
   * Routes Codex server-initiated requests (e.g. approval) to subscribed clients.
   * The first client to respond wins; response is forwarded back to app-server.
   */
  private handleCodexServerRequest(request: ServerRequest): void {
    const params = request.params as Record<string, unknown> | undefined;
    const threadId = params?.['threadId'] as string | undefined;
    const requestId = (request as unknown as { id: number | string }).id;

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
   */
  @SubscribeMessage('codex.serverResponse')
  handleServerResponse(
    @MessageBody() data: { id: number | string; result: unknown },
  ): void {
    const client = this.codexManager.getClient();
    if (client) {
      client.respondToServerRequest(data.id, data.result);
    }
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
