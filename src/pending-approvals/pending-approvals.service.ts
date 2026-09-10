/** Persists app-server requests that require user decisions. */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { Subject } from 'rxjs';
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
  PendingRequestResolvedDto,
  PendingServerRequestsResponseDto,
  PendingServerRequestDto,
} from './dto/pending-approvals.dto';
import { PendingApprovalContext } from './pending-approval-context';
import { isHumanServerRequest } from './human-server-requests';

@Injectable()
export class PendingApprovalsService implements OnModuleInit {
  private readonly logger = new Logger(PendingApprovalsService.name);
  private readonly changed = new Subject<void>();
  /** Persisted pending-set changes, including cancellation and generation expiry. */
  readonly changes = this.changed.asObservable();
  private readonly retired = new Subject<PendingRequestResolvedDto>();
  /** Committed human-request retirements for authenticated-wide delivery. */
  readonly resolvedRequests = this.retired.asObservable();
  private readonly context = new PendingApprovalContext();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly codexManager: CodexProcessManager,
    private readonly deletionRegistry: ThreadDeletionRegistryService,
    private readonly catalogAdmission: CatalogAdmissionService,
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

  /** Old RPC requests cannot survive a complete backend restart. */
  onModuleInit(): void {
    this.expireAllPending('WebUI restarted');
    this.context.clear();
  }

  /** Captures approval subjects before forwarding item events and observes request retirement. */
  observeNotification(notification: ServerNotification): void {
    this.context.observe(notification, this.codexManager.getGeneration());
    if (notification.method === 'serverRequest/resolved')
      this.markResolved(notification);
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
      typeof params?.threadId === 'string'
        ? params.threadId
        : typeof params?.conversationId === 'string'
          ? params.conversationId
          : null;
    if (!threadId || !params || raw.id == null || !raw.method) return null;
    if (!isHumanServerRequest(raw.method)) return null;

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
      itemId:
        typeof params.itemId === 'string'
          ? params.itemId
          : typeof params.callId === 'string'
            ? params.callId
            : null,
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

    // SQLite writes and capture are synchronous: no browser read can interleave
    // before the hint/return below. Associate only after a successful write, so
    // a failed insert/upsert cannot overwrite the last committed subject.
    if (raw.method === 'item/fileChange/requestApproval') {
      if (
        !this.context.capture(
          generation,
          requestId,
          threadId,
          row.turnId,
          row.itemId,
        )
      ) {
        this.logger.error(
          `File approval published without its change set: request=${requestId} thread=${threadId} turn=${String(row.turnId)} item=${String(row.itemId)}`,
        );
      }
    } else {
      this.context.forgetRequest(generation, requestId);
    }

    // The gateway also withholds the live request while deletion is pending.
    // Its guard-release signal publishes requests belonging to surviving threads.
    if (!this.deletionRegistry.isDeleting(threadId)) this.changed.next();
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

  /**
   * Reads a complete pending set for a browser. A deletion conflict returns no
   * snapshot, preserving the existing rule that failed reads resolve nothing.
   * Internal deletion planning uses listPending so it can still see guarded rows.
   */
  readPending(threadIds?: string[]): PendingServerRequestsResponseDto {
    const scope = threadIds?.map((id) => id.trim()).filter(Boolean);
    this.deletionRegistry.assertPendingReadable(scope);
    return {
      generation: this.codexManager.getGeneration(),
      requests: this.listPending(scope),
    };
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
    // Projection must succeed before the irreversible transport write. A corrupt
    // params JSON must not roll back SQLite after app-server received a decision.
    const projected = this.toDto(row);
    if (
      row.method === 'item/fileChange/requestApproval' &&
      projected.reviewSubject === null
    ) {
      const decision =
        typeof result === 'object' && result !== null && 'decision' in result
          ? result.decision
          : undefined;
      // Enforce this at the common REST/socket boundary; old clients still draw
      // Accept buttons. Decline/cancel preserve liveness without approving unseen changes.
      if (decision !== 'decline' && decision !== 'cancel') {
        throw BusinessException.conflict(
          ErrorCode.approvals.subjectUnavailable,
          'Cannot approve a file change without its change set; decline or cancel the request.',
        );
      }
    }

    this.catalogAdmission.assertOpen();
    const client = this.codexManager.getClient();
    if (!client) {
      throw BusinessException.conflict(
        ErrorCode.approvals.serverNotConnected,
        'Codex app-server is not connected',
      );
    }

    const now = Date.now();
    const resolvedRequest = this.db.transaction((tx) => {
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

      return { ...projected, status: 'resolved' as const, updatedAt: now };
    });
    // Publish only after the transaction commits; rollback must emit nothing.
    this.publishRetired([resolvedRequest], 'resolved');
    return resolvedRequest;
  }

  /** Marks a server request resolved after app-server emits serverRequest/resolved. */
  markResolved(notification: ServerNotification): void {
    const params = notification.params as Record<string, unknown> | undefined;
    const requestId = params?.requestId;
    if (requestId == null) return;
    const generation = this.codexManager.getGeneration();
    const now = Date.now();
    const rows = this.db
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
      .returning()
      .all();
    this.publishRetired(rows, 'resolved');
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
    this.publishRetired(rows, 'cancelled');
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
    this.context.forgetGeneration(generation);
  }

  /** Expires rows left by the old backend before any new pending baseline is served. */
  private expireAllPending(reason: string): void {
    const now = Date.now();
    const rows = this.db
      .update(pendingServerRequests)
      .set({ status: 'expired', updatedAt: now, resolvedAt: now })
      .where(eq(pendingServerRequests.status, 'pending'))
      .returning()
      .all();
    this.publishRetired(rows, 'expired');
    this.logger.debug(`Expired stale pending requests: ${reason}`);
  }

  /** Retires one generation in SQLite before broadcasting its neutral terminal state. */
  private updatePendingStatus(
    generation: number,
    status: PendingRequestResolvedDto['status'],
    reason: string,
  ): void {
    const now = Date.now();
    const rows = this.db
      .update(pendingServerRequests)
      .set({ status, updatedAt: now, resolvedAt: now })
      .where(
        and(
          eq(pendingServerRequests.generation, generation),
          eq(pendingServerRequests.status, 'pending'),
        ),
      )
      .returning()
      .all();
    this.publishRetired(rows, status);
    this.logger.debug(
      `Marked pending requests ${status}: generation=${generation} reason=${reason}`,
    );
  }

  /** Publishes only committed transitions, then releases their request-specific subjects. */
  private publishRetired(
    rows: Array<{
      generation: number;
      requestId: string;
      threadId: string;
      method: string;
    }>,
    status: PendingRequestResolvedDto['status'],
  ): void {
    for (const row of rows) {
      this.context.forgetRequest(row.generation, row.requestId);
      if (isHumanServerRequest(row.method)) {
        this.retired.next({
          generation: row.generation,
          requestId: row.requestId,
          threadId: row.threadId,
          status,
        });
      }
    }
    if (rows.length > 0) this.changed.next();
  }

  /** Preserves the existing wire convention for numeric versus opaque request IDs. */
  private parseRequestId(requestId: string): string | number {
    return /^\d+$/.test(requestId) ? Number(requestId) : requestId;
  }

  /** Combines unchanged persisted parameters with the request's retained review subject. */
  private toDto(row: PendingServerRequestRow): PendingServerRequestDto {
    const params = JSON.parse(row.paramsJson) as Record<string, unknown>;
    return {
      generation: row.generation,
      requestId: row.requestId,
      threadId: row.threadId,
      turnId: row.turnId,
      itemId: row.itemId,
      method: row.method,
      params,
      reviewSubject: this.context.read(row.generation, row.requestId),
      status: row.status as PendingServerRequestDto['status'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
