/**
 * WebSocket gateway for real-time thread events.
 * Clients subscribe to specific threads and receive Codex app-server
 * notifications (deltas, item lifecycle, turn lifecycle, etc.) in real time.
 */
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { merge, Subscription } from 'rxjs';
import { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type { ServerNotification, ServerRequest } from '../codex/codex-schema';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { isHumanServerRequest } from '../pending-approvals/human-server-requests';
import type { PendingServerRequestEvent } from '../pending-approvals/dto/pending-approvals.dto';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { projectNotificationForClient } from '../turn-errors/turn-error-projection';
import { ThreadMetadataService } from './thread-metadata.service';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';

/** Only sockets whose asynchronous authentication completed join this room. */
const AUTHENTICATED_ROOM = 'webui:authenticated';

/** Invalidation only. Read the corresponding REST resource for authoritative data. */
export interface ConversationChangeSignal {
  generation: number;
}

/** A server request held back while its thread was inside a delete. */
type SuppressedServerRequest = PendingServerRequestEvent;

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
  implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy
{
  private readonly logger = new Logger(ThreadsGateway.name);
  private readonly changes = new Subscription();

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
    private readonly pendingApprovals: PendingApprovalsService,
    private readonly deletionRegistry: ThreadDeletionRegistryService,
    private readonly metadata: ThreadMetadataService,
    private readonly branches: ConversationBranchesService,
    private readonly branchMutations: ConversationBranchMutationsService,
  ) {}

  afterInit(): void {
    this.changes.add(
      merge(
        this.metadata.changes,
        this.branches.changes,
        this.branchMutations.changes,
      ).subscribe(() => {
        this.emitChange('conversation.overview.changed');
      }),
    );
    this.changes.add(
      this.pendingApprovals.changes.subscribe(() => {
        this.emitChange('conversation.pending.changed');
        // Pending counts are local inputs to the overview, so no metadata walk is needed.
        this.emitChange('conversation.overview.changed');
      }),
    );
    this.changes.add(
      this.pendingApprovals.resolvedRequests.subscribe((request) => {
        // Retire withheld copies too: an old generation's request ID can be
        // reused, and replay must never borrow that newer request's liveness.
        const held = this.suppressedRequests.get(request.threadId);
        if (held) {
          const remaining = held.filter(
            (entry) =>
              entry.generation !== request.generation ||
              String(entry.id) !== request.requestId,
          );
          if (remaining.length)
            this.suppressedRequests.set(request.threadId, remaining);
          else this.suppressedRequests.delete(request.threadId);
        }
        this.server
          .to(AUTHENTICATED_ROOM)
          .emit('conversation.pending.resolved', request);
      }),
    );
    this.codexManager.addListener(
      'notification',
      (notification: ServerNotification) => {
        this.handleCodexNotification(notification);
      },
    );

    this.codexManager.addListener('serverRequest', (request: ServerRequest) => {
      this.handleCodexServerRequest(request);
    });

    this.changes.add(
      this.deletionRegistry.onRelease((threadIds) => {
        this.replaySuppressedRequests(threadIds);
        this.emitChange('conversation.pending.changed');
      }),
    );

    this.logger.log('ThreadsGateway initialized');
  }

  /** Releases observable subscriptions when the gateway is destroyed. */
  onModuleDestroy(): void {
    this.changes.unsubscribe();
  }

  /** Broadcasts a content-free invalidation to authenticated clients, independent of thread rooms. */
  private emitChange(
    event: 'conversation.overview.changed' | 'conversation.pending.changed',
  ): void {
    this.server.to(AUTHENTICATED_ROOM).emit(event, {
      generation: this.codexManager.getGeneration(),
    } satisfies ConversationChangeSignal);
  }

  /** Validates auth token on connection; disconnects unauthorized clients. */
  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractSocketToken(client);

    if (!(await this.authService.authenticateToken(token, client.id)).ok) {
      this.logger.warn(`Rejected unauthenticated socket: ${client.id}`);
      client.disconnect(true);
      return;
    }

    if (client.disconnected) return;
    await client.join(AUTHENTICATED_ROOM);
    // A reconnect may have missed every lifecycle event. These initial signals
    // request current baselines without replaying events or restoring transcripts.
    const signal: ConversationChangeSignal = {
      generation: this.codexManager.getGeneration(),
    };
    client.emit('conversation.overview.changed', signal);
    client.emit('conversation.pending.changed', signal);
    this.logger.debug(`Client connected: ${client.id}`);
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
    this.logger.debug(`Client ${client.id} unsubscribed from ${room}`);
    return { ok: true };
  }

  /**
   * Routes Codex app-server notifications to subscribed clients.
   * Extracts threadId from notification params and emits to the room.
   */
  private handleCodexNotification(notification: ServerNotification): void {
    this.pendingApprovals.observeNotification(notification);

    const params = notification.params as Record<string, unknown> | undefined;
    const threadId = params?.['threadId'] as string | undefined;
    const projected = projectNotificationForClient(notification);

    if (threadId) {
      this.server
        .to(`thread:${threadId}`)
        .emit('codex.notification', projected);
    } else {
      // Broadcast non-thread-scoped notifications to all connected clients
      this.server.emit('codex.notification', projected);
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
          .map((row) => `${row.generation}:${row.requestId}`),
      );
      for (const request of held) {
        if (!stillPending.has(`${request.generation}:${String(request.id)}`))
          continue;
        this.server.to(AUTHENTICATED_ROOM).emit('codex.serverRequest', request);
        this.logger.log(
          `Replayed suppressed server request ${String(request.id)} for thread ${threadId}`,
        );
      }
    }
  }

  /**
   * Publishes complete human requests to every authenticated browser, once.
   * Machine-facing requests are not user decisions and never enter this channel.
   * The first client to respond still wins through the persisted CAS operation.
   */
  private handleCodexServerRequest(request: ServerRequest): void {
    if (!isHumanServerRequest(request.method)) {
      this.logger.debug(
        `Excluded machine-facing server request: ${request.method}`,
      );
      return;
    }
    const pending = this.pendingApprovals.recordServerRequest(request);
    if (!pending) return;
    const threadId = pending.threadId;
    const event: PendingServerRequestEvent = {
      id: request.id,
      method: request.method,
      params: pending.params,
      generation: pending.generation,
      reviewSubject: pending.reviewSubject,
    };

    // Suppressed rather than terminalized: the row stays pending so an aborted
    // delete leaves the request answerable, but there is no point surfacing a
    // card for a conversation the user just chose to destroy. Held here so the
    // guard's release can put it back on screen if the delete does abort.
    if (threadId && this.deletionRegistry.isDeleting(threadId)) {
      const held = this.suppressedRequests.get(threadId) ?? [];
      held.push(event);
      this.suppressedRequests.set(threadId, held);
      return;
    }

    this.server.to(AUTHENTICATED_ROOM).emit('codex.serverRequest', event);
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
