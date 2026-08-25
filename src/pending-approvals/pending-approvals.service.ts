/** Persists app-server requests that require user decisions. */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { and, eq, inArray } from 'drizzle-orm';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  pendingServerRequests,
  type PendingServerRequestRow,
} from '../database/schema';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import type { ServerNotification, ServerRequest } from '../codex/codex-schema';
import type {
  PendingServerRequestDto,
  PendingServerRequestStatus,
} from './dto/pending-approvals.dto';

@Injectable()
export class PendingApprovalsService implements OnModuleInit {
  private readonly logger = new Logger(PendingApprovalsService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly codexManager: CodexProcessManager,
    private readonly deletionRegistry: ThreadDeletionRegistryService,
  ) {
    this.codexManager.addLifecycleListener((event) => {
      if (
        event.type === 'appServerRestarting' ||
        event.type === 'appServerUnavailable'
      ) {
        this.expireGeneration(event.generation, 'app-server restarted');
      }
    });
  }

  onModuleInit(): void {
    this.expireAllPending('WebUI restarted');
  }

  /** Persists a server request before it is emitted to WebSocket subscribers. */
  recordServerRequest(request: ServerRequest): PendingServerRequestDto | null {
    const raw = request as unknown as {
      id?: string | number;
      params?: unknown;
      method?: string;
    };
    const params = raw.params as Record<string, unknown> | undefined;
    const threadId =
      typeof params?.threadId === 'string' ? params.threadId : null;
    if (!threadId || !params || raw.id == null || !raw.method) return null;

    const now = Date.now();
    const generation = this.codexManager.getGeneration();
    const requestId = String(raw.id);
    // Recorded as pending even while the thread is being deleted. Terminalizing
    // here would strand the request if the delete then aborts: the UI never saw
    // it, `respond` would refuse an already-resolved row, and app-server would
    // still be waiting. Deletion cancels these explicitly once it has actually
    // interrupted or removed the thread; late clicks are refused by `respond`.
    const row = {
      generation,
      requestId,
      threadId,
      turnId: typeof params.turnId === 'string' ? params.turnId : null,
      itemId: typeof params.itemId === 'string' ? params.itemId : null,
      method: raw.method,
      paramsJson: JSON.stringify(params),
      status: 'pending',
      resolvedBy: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    } satisfies typeof pendingServerRequests.$inferInsert;

    this.db
      .insert(pendingServerRequests)
      .values(row)
      .onConflictDoUpdate({
        target: [
          pendingServerRequests.generation,
          pendingServerRequests.requestId,
        ],
        set: {
          threadId: row.threadId,
          turnId: row.turnId,
          itemId: row.itemId,
          method: row.method,
          paramsJson: row.paramsJson,
          status: row.status,
          updatedAt: now,
          resolvedAt: null,
          resolvedBy: null,
        },
      })
      .run();

    return this.toDto(row);
  }

  /** Lists pending requests, optionally filtered to specific thread IDs. */
  listPending(threadIds?: string[]): PendingServerRequestDto[] {
    const normalized = threadIds?.map((id) => id.trim()).filter(Boolean) ?? [];
    const statusFilter = eq(pendingServerRequests.status, 'pending');
    const rows =
      normalized.length > 0
        ? this.db
            .select()
            .from(pendingServerRequests)
            .where(
              and(
                statusFilter,
                inArray(pendingServerRequests.threadId, normalized),
              ),
            )
            .all()
        : this.db
            .select()
            .from(pendingServerRequests)
            .where(statusFilter)
            .all();
    return rows.map((row) => this.toDto(row));
  }

  /** Responds to one pending request. First writer wins across devices. */
  respondToRequest(
    requestId: string,
    result: unknown,
    clientId?: string,
  ): PendingServerRequestDto {
    const generation = this.codexManager.getGeneration();
    const row = this.db
      .select()
      .from(pendingServerRequests)
      .where(
        and(
          eq(pendingServerRequests.generation, generation),
          eq(pendingServerRequests.requestId, requestId),
        ),
      )
      .get();

    if (!row) {
      throw BusinessException.notFound(
        ErrorCode.approvals.notFound,
        'Pending request not found',
      );
    }
    if (row.status !== 'pending') {
      throw BusinessException.conflict(
        ErrorCode.approvals.alreadyResolved,
        'Pending request has already been resolved',
      );
    }
    this.deletionRegistry.assertMutable(row.threadId);

    const client = this.codexManager.getClient();
    if (!client) {
      throw BusinessException.conflict(
        ErrorCode.approvals.serverNotConnected,
        'Codex app-server is not connected',
      );
    }

    const now = Date.now();
    return this.db.transaction((tx) => {
      const updateResult = tx
        .update(pendingServerRequests)
        .set({
          status: 'resolved',
          resolvedBy: clientId ?? null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(pendingServerRequests.generation, generation),
            eq(pendingServerRequests.requestId, requestId),
            eq(pendingServerRequests.status, 'pending'),
          ),
        )
        .run();

      if (updateResult.changes !== 1) {
        throw BusinessException.conflict(
          ErrorCode.approvals.alreadyHandled,
          'Pending approval was already handled',
        );
      }

      client.respondToServerRequest(this.parseRequestId(row.requestId), result);

      return this.toDto({
        ...row,
        status: 'resolved',
        resolvedBy: clientId ?? null,
        resolvedAt: now,
        updatedAt: now,
      });
    });
  }

  /** Marks a server request resolved after app-server emits serverRequest/resolved. */
  markResolved(notification: ServerNotification): void {
    const params = notification.params as Record<string, unknown> | undefined;
    const requestId = params?.requestId;
    if (requestId == null) return;
    const generation = this.codexManager.getGeneration();
    const now = Date.now();
    this.db
      .update(pendingServerRequests)
      .set({ status: 'resolved', updatedAt: now, resolvedAt: now })
      .where(
        and(
          eq(pendingServerRequests.generation, generation),
          eq(
            pendingServerRequests.requestId,
            String(requestId as string | number),
          ),
          eq(pendingServerRequests.status, 'pending'),
        ),
      )
      .run();
  }

  /** Marks pending requests cancelled because their thread is being interrupted/deleted. */
  cancelPendingForThreads(
    threadIds: string[],
    reason: string,
  ): PendingServerRequestDto[] {
    const normalized = [...new Set(threadIds.map((id) => id.trim()))].filter(
      Boolean,
    );
    if (normalized.length === 0) return [];
    const generation = this.codexManager.getGeneration();
    const rows = this.db
      .select()
      .from(pendingServerRequests)
      .where(
        and(
          eq(pendingServerRequests.generation, generation),
          eq(pendingServerRequests.status, 'pending'),
          inArray(pendingServerRequests.threadId, normalized),
        ),
      )
      .all();
    if (rows.length === 0) return [];

    const now = Date.now();
    this.db
      .update(pendingServerRequests)
      .set({ status: 'cancelled', updatedAt: now, resolvedAt: now })
      .where(
        and(
          eq(pendingServerRequests.generation, generation),
          eq(pendingServerRequests.status, 'pending'),
          inArray(pendingServerRequests.threadId, normalized),
        ),
      )
      .run();
    this.logger.debug(
      `Cancelled pending requests for deleting threads: count=${rows.length} reason=${reason}`,
    );
    return rows.map((row) =>
      this.toDto({
        ...row,
        status: 'cancelled',
        updatedAt: now,
        resolvedAt: now,
      }),
    );
  }

  /** Expires all pending rows for an app-server generation. */
  expireGeneration(generation: number, reason: string): void {
    this.updatePendingStatus(generation, 'expired', reason);
  }

  private expireAllPending(reason: string): void {
    const now = Date.now();
    this.db
      .update(pendingServerRequests)
      .set({ status: 'expired', updatedAt: now, resolvedAt: now })
      .where(eq(pendingServerRequests.status, 'pending'))
      .run();
    this.logger.debug(`Expired stale pending requests: ${reason}`);
  }

  private updatePendingStatus(
    generation: number,
    status: PendingServerRequestStatus,
    reason: string,
  ): void {
    const now = Date.now();
    this.db
      .update(pendingServerRequests)
      .set({ status, updatedAt: now, resolvedAt: now })
      .where(
        and(
          eq(pendingServerRequests.generation, generation),
          eq(pendingServerRequests.status, 'pending'),
        ),
      )
      .run();
    this.logger.debug(
      `Marked pending requests ${status}: generation=${generation} reason=${reason}`,
    );
  }

  private parseRequestId(requestId: string): string | number {
    return /^\d+$/.test(requestId) ? Number(requestId) : requestId;
  }

  private toDto(row: PendingServerRequestRow): PendingServerRequestDto {
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.paramsJson) as Record<string, unknown>;
    } catch {
      params = {};
    }
    return {
      generation: row.generation,
      requestId: row.requestId,
      threadId: row.threadId,
      turnId: row.turnId,
      itemId: row.itemId,
      method: row.method,
      params,
      status: row.status as PendingServerRequestStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
