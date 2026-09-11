/** Persists immutable human requests and binds decisions to their ingress owner. */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import { and, eq, inArray } from 'drizzle-orm';
import { CatalogAdmissionService } from '../codex/catalog/catalog-admission.service';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { CodexProcessManager } from '../codex/codex-process-manager.service';
import type {
  OwnedServerRequest,
  ServerRequestRetirement,
} from '../codex/server-request-owner';
import type { ServerNotification } from '../codex/codex-schema';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import {
  pendingServerRequests,
  type PendingServerRequestRow,
} from '../database/schema';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import type {
  PendingRequestResolvedDto,
  PendingServerRequestsResponseDto,
  PendingServerRequestDto,
} from './dto/pending-approvals.dto';
import type { ServerRequestFailureDto } from './dto/interaction.dto';
import { PendingApprovalContext } from './pending-approval-context';
import {
  encodeHumanResponse,
  validateHumanRequest,
} from './human-request-contract';
import { nonempty, record } from './request-validation';
import { projectPendingRequest } from './pending-request-projection';
import { readRecentRequestFailures } from './pending-request-failures';

@Injectable()
export class PendingApprovalsService implements OnModuleInit {
  private readonly logger = new Logger(PendingApprovalsService.name);
  private readonly changed = new Subject<void>();
  /** Committed changes to pending attention, independent of transcript rooms. */
  readonly changes = this.changed.asObservable();
  private readonly retired = new Subject<PendingRequestResolvedDto>();
  /** Local submission and terminal evidence are distinct browser transitions. */
  readonly resolvedRequests = this.retired.asObservable();
  private readonly admitted = new Subject<PendingServerRequestDto>();
  /** Only successfully admitted requests may be delivered to browsers. */
  readonly requests = this.admitted.asObservable();
  private readonly failed = new Subject<ServerRequestFailureDto>();
  /** Client failures never claim that the human declined or that the turn ended. */
  readonly failures = this.failed.asObservable();
  private readonly context = new PendingApprovalContext();
  private readonly owners = new Map<string, OwnedServerRequest>();
  private initialized = false;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
    private readonly codexManager: CodexProcessManager,
    private readonly deletionRegistry: ThreadDeletionRegistryService,
    private readonly catalogAdmission: CatalogAdmissionService,
  ) {
    this.codexManager.setServerRequestHandler((owned) => {
      if (!this.initialized) return false;
      this.recordServerRequest(owned);
      return true;
    });
    this.codexManager.addListener(
      'notification',
      (notification: ServerNotification) =>
        this.observeNotification(notification),
    );
    this.codexManager.addListener(
      'serverRequestRetired',
      (event: ServerRequestRetirement) => this.observeRetirement(event),
    );
    this.codexManager.addLifecycleListener((event) => {
      if (
        event.type === 'appServerRestarting' ||
        event.type === 'appServerUnavailable'
      )
        this.expireGeneration(event.generation, 'app-server restarted');
    });
  }

  /** Expires old response authority before this backend accepts human requests. */
  onModuleInit(): void {
    const rows = this.db
      .update(pendingServerRequests)
      .set({ status: 'expired', updatedAt: Date.now(), resolvedAt: Date.now() })
      .where(inArray(pendingServerRequests.status, ['pending', 'submitted']))
      .returning()
      .all();
    this.publishRetired(rows, 'expired');
    this.context.clear();
    this.initialized = true;
  }

  /** Captures file subjects before gateway delivery; RPC retirement belongs to ingress. */
  observeNotification(notification: ServerNotification): void {
    this.context.observe(notification, this.codexManager.getGeneration());
  }

  /**
   * Persists a single ingress-owned proposal before publishing it. Repeated
   * delivery returns the original row, including terminal state, without
   * replacing its parameters, subject, identity, or response authority.
   */
  recordServerRequest(owned: OwnedServerRequest): PendingServerRequestDto {
    const existing = this.db
      .select()
      .from(pendingServerRequests)
      .where(eq(pendingServerRequests.instanceId, owned.instanceId))
      .get();
    if (existing) return projectPendingRequest(existing, this.context);
    const { request } = owned;
    const params = validateHumanRequest(request);
    const generation = this.codexManager.getGeneration();
    const now = Date.now();
    const row = {
      instanceId: owned.instanceId,
      generation,
      requestId: String(request.id),
      threadId: params.threadId as string,
      turnId: typeof params.turnId === 'string' ? params.turnId : null,
      itemId: typeof params.itemId === 'string' ? params.itemId : null,
      method: request.method,
      paramsJson: JSON.stringify(params),
      status: 'pending',
      resolvedBy: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      failureReason: null,
    } satisfies typeof pendingServerRequests.$inferInsert;
    this.db.insert(pendingServerRequests).values(row).run();
    this.owners.set(owned.instanceId, owned);
    if (
      request.method === 'item/fileChange/requestApproval' &&
      !this.context.capture(
        generation,
        owned.instanceId,
        row.threadId,
        row.turnId,
        row.itemId,
      )
    )
      this.logger.error(
        `File approval subject unavailable: instance=${owned.instanceId}`,
      );
    const dto = projectPendingRequest(row, this.context);
    // Deletion withholds delivery, not ownership: an aborted delete must leave
    // the request answerable. The gateway replays it when the guard is released.
    if (!this.deletionRegistry.isDeleting(row.threadId)) this.changed.next();
    this.admitted.next(dto);
    return dto;
  }

  /** Returns actionable requests for attention counts and deletion planning. */
  listPending(threadIds?: string[]): PendingServerRequestDto[] {
    return this.selectRequests(threadIds, ['pending']).map((row) =>
      projectPendingRequest(row, this.context),
    );
  }

  /** Reads unresolved submissions too, so reconnect never re-enables their buttons. */
  readPending(threadIds?: string[]): PendingServerRequestsResponseDto {
    const scope = threadIds?.map((id) => id.trim()).filter(Boolean);
    this.deletionRegistry.assertPendingReadable(scope);
    const generation = this.codexManager.getGeneration();
    return {
      generation,
      requests: this.selectRequests(scope, ['pending', 'submitted']).map(
        (row) => projectPendingRequest(row, this.context),
      ),
      failures: readRecentRequestFailures(this.db, scope, generation),
    };
  }

  /**
   * Commits the first valid decision before attempting transmission on its
   * original connection. A committed or ambiguously delivered decision is
   * never reset to pending, and an instance ID is mandatory on both APIs.
   * @param requestId - Original wire ID as represented in the browser URL.
   * @param instanceId - Identity of the immutable proposal the user reviewed.
   * @param result - Method-specific browser selection, validated before encoding.
   * @param clientId - Optional attribution, never used as authorization.
   * @returns The committed state; submitted is not confirmed resolution.
   */
  respondToRequest(
    requestId: string,
    instanceId: unknown,
    result: unknown,
    clientId?: string,
  ): PendingServerRequestDto {
    if (!nonempty(instanceId))
      throw BusinessException.badRequest(
        ErrorCode.approvals.instanceRequired,
        'Request instanceId is required. Refresh this client.',
      );
    const row = this.db
      .select()
      .from(pendingServerRequests)
      .where(
        and(
          eq(pendingServerRequests.instanceId, instanceId),
          eq(pendingServerRequests.requestId, requestId),
        ),
      )
      .get();
    if (!row)
      throw BusinessException.notFound(
        ErrorCode.approvals.notFound,
        'Pending request instance not found',
      );
    if (row.status !== 'pending')
      throw BusinessException.conflict(
        ErrorCode.approvals.alreadyResolved,
        'Pending request has already been handled',
      );
    this.deletionRegistry.assertMutable(row.threadId);
    const projected = projectPendingRequest(row, this.context);
    const decision = record(result)?.decision;
    if (
      row.method === 'item/fileChange/requestApproval' &&
      projected.reviewSubject === null &&
      decision !== 'decline' &&
      decision !== 'cancel'
    )
      throw BusinessException.conflict(
        ErrorCode.approvals.subjectUnavailable,
        'Cannot approve a file change without its change set; decline or cancel the request.',
      );
    let encoded: unknown;
    try {
      encoded = encodeHumanResponse(row.method, projected.params, result);
    } catch (error) {
      throw BusinessException.badRequest(
        ErrorCode.approvals.invalidResponse,
        error instanceof Error
          ? error.message
          : 'Invalid server-request response',
      );
    }
    this.catalogAdmission.assertOpen();
    const owner = this.owners.get(instanceId);
    if (!owner?.isPending())
      throw BusinessException.conflict(
        ErrorCode.approvals.serverNotConnected,
        'The original server request is no longer connected',
      );
    const now = Date.now();
    // This autocommit is deliberately complete before any stdio bytes are sent.
    const update = this.db
      .update(pendingServerRequests)
      .set({
        status: 'submitted',
        resolvedBy: clientId ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(pendingServerRequests.instanceId, instanceId),
          eq(pendingServerRequests.status, 'pending'),
        ),
      )
      .run();
    if (update.changes !== 1)
      throw BusinessException.conflict(
        ErrorCode.approvals.alreadyHandled,
        'Pending request was already handled',
      );
    try {
      owner.respond(encoded);
    } catch {
      // A transport exception cannot prove that zero bytes reached app-server.
      const message =
        'The decision was committed but delivery could not be confirmed.';
      const failed = this.db
        .update(pendingServerRequests)
        .set({
          status: 'failed',
          failureReason: message,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(pendingServerRequests.instanceId, instanceId),
            eq(pendingServerRequests.status, 'submitted'),
          ),
        )
        .returning()
        .all();
      this.publishRetired(failed, 'failed');
      if (failed.length)
        this.failed.next({
          instanceId,
          threadId: row.threadId,
          turnId: row.turnId,
          message,
        });
      throw BusinessException.conflict(
        ErrorCode.approvals.deliveryUnknown,
        message,
      );
    }
    // A test transport or queued server notification can resolve synchronously.
    const current = this.db
      .select()
      .from(pendingServerRequests)
      .where(eq(pendingServerRequests.instanceId, instanceId))
      .get()!;
    if (current.status === 'submitted')
      this.publishRetired([current], 'submitted');
    return projectPendingRequest(current, this.context);
  }

  /** Applies only connection-bound retirement identities supplied by ingress. */
  observeRetirement(event: ServerRequestRetirement): void {
    const now = Date.now();
    const rows = this.db
      .update(pendingServerRequests)
      .set({
        status: event.status,
        failureReason: event.message ?? null,
        updatedAt: now,
        resolvedAt: now,
      })
      .where(
        and(
          eq(pendingServerRequests.instanceId, event.instanceId),
          inArray(pendingServerRequests.status, ['pending', 'submitted']),
        ),
      )
      .returning()
      .all();
    this.owners.delete(event.instanceId);
    this.publishRetired(rows, event.status);
    if (!event.message || event.status !== 'failed') return;
    const params = record(event.request.params);
    const threadId =
      rows[0]?.threadId ??
      (typeof params?.threadId === 'string'
        ? params.threadId
        : typeof params?.conversationId === 'string'
          ? params.conversationId
          : null);
    const turnId =
      rows[0]?.turnId ??
      (typeof params?.turnId === 'string' ? params.turnId : null);
    const failure = {
      instanceId: event.instanceId,
      threadId,
      turnId,
      message: event.message,
    };
    // Persist scoped refusal explanations without retaining machine credentials
    // or unsupported request payloads. Account-only refusals remain in the
    // redacted wire log and the ordinary app-server authentication error path.
    if (threadId && rows.length === 0) {
      try {
        this.db
          .insert(pendingServerRequests)
          .values({
            instanceId: event.instanceId,
            generation: this.codexManager.getGeneration(),
            requestId: String(event.request.id),
            threadId,
            turnId,
            itemId: null,
            method: event.request.method,
            paramsJson: '{}',
            status: 'failed',
            resolvedBy: null,
            createdAt: now,
            updatedAt: now,
            resolvedAt: now,
            failureReason: event.message,
          })
          .onConflictDoNothing()
          .run();
      } catch {
        this.logger.error(
          'Could not persist the client refusal; the RPC was already refused',
        );
      }
    }
    this.logger.warn(
      `Client refused server request: method=${event.request.method} instance=${event.instanceId}`,
    );
    this.failed.next(failure);
    this.changed.next();
  }

  /** Cancels request authority after the owning threads have been interrupted/deleted. */
  cancelPendingForThreads(
    threadIds: string[],
    reason: string,
  ): PendingServerRequestDto[] {
    if (!threadIds.length) return [];
    const rows = this.selectRequests(threadIds, ['pending', 'submitted']);
    const projected = rows.map((row) =>
      projectPendingRequest(row, this.context),
    );
    this.transition(rows, 'cancelled', reason);
    return projected.map((row) => ({ ...row, status: 'cancelled' }));
  }

  /** Expires an old child generation without borrowing a replacement connection. */
  expireGeneration(generation: number, reason: string): void {
    const rows = this.db
      .select()
      .from(pendingServerRequests)
      .where(
        and(
          eq(pendingServerRequests.generation, generation),
          inArray(pendingServerRequests.status, ['pending', 'submitted']),
        ),
      )
      .all();
    this.transition(rows, 'expired', reason);
    this.context.forgetGeneration(generation);
  }

  /** Reads a complete scoped set; absence is meaningful only after this succeeds. */
  private selectRequests(
    threadIds: string[] | undefined,
    statuses: string[],
  ): PendingServerRequestRow[] {
    const scope = threadIds?.map((id) => id.trim()).filter(Boolean);
    return this.db
      .select()
      .from(pendingServerRequests)
      .where(
        and(
          inArray(pendingServerRequests.status, statuses),
          scope?.length
            ? inArray(pendingServerRequests.threadId, scope)
            : undefined,
        ),
      )
      .all();
  }

  /** Commits lifecycle retirement before releasing in-memory response authority. */
  private transition(
    rows: PendingServerRequestRow[],
    status: 'cancelled' | 'expired',
    reason: string,
  ): void {
    for (const row of rows) {
      if (!row.instanceId) continue;
      this.db
        .update(pendingServerRequests)
        .set({ status, updatedAt: Date.now(), resolvedAt: Date.now() })
        .where(eq(pendingServerRequests.instanceId, row.instanceId))
        .run();
      const owner = this.owners.get(row.instanceId);
      this.owners.delete(row.instanceId);
      owner?.retire();
    }
    this.publishRetired(rows, status);
    if (rows.length)
      this.logger.debug(`Retired ${rows.length} requests: ${reason}`);
  }

  /** Publishes committed state without confusing submission with server confirmation. */
  private publishRetired(
    rows: Array<
      Pick<
        PendingServerRequestRow,
        'instanceId' | 'generation' | 'requestId' | 'threadId'
      >
    >,
    status: PendingRequestResolvedDto['status'],
  ): void {
    for (const row of rows) {
      if (!row.instanceId) continue;
      if (status !== 'submitted')
        this.context.forgetRequest(row.generation, row.instanceId);
      this.retired.next({
        instanceId: row.instanceId,
        generation: row.generation,
        requestId: row.requestId,
        threadId: row.threadId,
        status,
      });
    }
    if (rows.length) this.changed.next();
  }
}
