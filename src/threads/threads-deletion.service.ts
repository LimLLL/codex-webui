/** Executes destructive thread deletion after a confirmed preview id set. */
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import {
  ConversationBranchMutationsService,
  OrphanedLocalTopologyError,
} from '../conversation-branches/conversation-branch-mutations.service';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { tokenUsageSnapshots, turnDiffs, turnErrors } from '../database/schema';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import { ThreadSettingsObserverService } from './thread-settings-observer.service';
import {
  isDescendantRejectedError,
  isThreadNotFoundError,
  isUnmaterializedThreadReadError,
} from './thread-errors';
import { ThreadsDeletePlannerService } from './threads-delete-planner.service';
import type {
  DeleteFailureStage,
  ThreadDeleteFailureDto,
  ThreadDeletePreviewDto,
  ThreadDeleteRequestDto,
  ThreadDeleteResultDto,
} from './dto/thread-deletion.dto';

@Injectable()
export class ThreadsDeletionService {
  private readonly logger = new Logger(ThreadsDeletionService.name);

  constructor(
    private readonly codex: CodexService,
    private readonly planner: ThreadsDeletePlannerService,
    private readonly branchMutations: ConversationBranchMutationsService,
    private readonly branches: ConversationBranchesService,
    private readonly pendingApprovals: PendingApprovalsService,
    private readonly resumeRegistry: ThreadResumeRegistryService,
    private readonly settingsObserver: ThreadSettingsObserverService,
    private readonly deletionRegistry: ThreadDeletionRegistryService,
    @Inject(DRIZZLE_DB) private readonly db: AppDatabase,
  ) {}

  /** Builds the exact cascade set the frontend must show before confirmation. */
  async previewDelete(threadId: string): Promise<ThreadDeletePreviewDto> {
    return this.planner.buildPlan(threadId);
  }

  /** Deletes a thread and all fork descendants, stopping at the first failure. */
  async deleteThread(
    threadId: string,
    body: ThreadDeleteRequestDto,
  ): Promise<ThreadDeleteResultDto> {
    const expectedThreadIds = this.readExpectedThreadIds(body);
    const expectedRunningThreadIds = this.readOptionalThreadIds(
      body.expectedRunningThreadIds,
    );
    const expectedPendingApprovalRequestIds = this.readOptionalThreadIds(
      body.expectedPendingApprovalRequestIds,
    );
    const expectedPendingApprovalThreadIds = this.readOptionalThreadIds(
      body.expectedPendingApprovalThreadIds,
    );
    const expectedSet = new Set(expectedThreadIds);
    const initialPlan = await this.planner.buildPlan(threadId);
    if (!this.sameSet(expectedThreadIds, initialPlan.threadIds)) {
      return this.conflictResult(
        threadId,
        expectedThreadIds,
        initialPlan,
        'The delete plan changed since it was previewed',
        'drift',
      );
    }
    const initialStateFailure = this.confirmedDestructiveStateFailure(
      initialPlan,
      expectedRunningThreadIds,
      expectedPendingApprovalRequestIds,
      expectedPendingApprovalThreadIds,
    );
    if (initialStateFailure) {
      return this.conflictResult(
        threadId,
        expectedThreadIds,
        initialPlan,
        initialStateFailure.message,
        'drift',
      );
    }
    if (!initialPlan.canDelete) {
      return this.conflictResult(
        threadId,
        expectedThreadIds,
        initialPlan,
        'The delete plan is blocked by branch topology diagnostics',
        'planning',
      );
    }

    const interruptedThreadIds: string[] = [];
    const cancelledApprovalRequestIds: string[] = [];
    const deletedThreadIds: string[] = [];
    const reapedThreadIds: string[] = [];
    let destructiveStarted = false;

    this.deletionRegistry.begin(initialPlan.threadIds);
    try {
      const guardedPlan = await this.planner.buildPlan(threadId);
      if (
        !guardedPlan.canDelete ||
        !this.sameSet(expectedThreadIds, guardedPlan.threadIds)
      ) {
        return this.conflictResult(
          threadId,
          expectedThreadIds,
          guardedPlan,
          'The delete plan changed while acquiring the delete guard',
          'drift',
        );
      }
      const guardedStateFailure = this.confirmedDestructiveStateFailure(
        guardedPlan,
        expectedRunningThreadIds,
        expectedPendingApprovalRequestIds,
        expectedPendingApprovalThreadIds,
      );
      if (guardedStateFailure) {
        return this.conflictResult(
          threadId,
          expectedThreadIds,
          guardedPlan,
          guardedStateFailure.message,
          'drift',
        );
      }

      const interruptFailure = await this.interruptRunningThreads(
        guardedPlan.runningThreadIds,
        interruptedThreadIds,
        cancelledApprovalRequestIds,
      );
      destructiveStarted =
        interruptedThreadIds.length > 0 ||
        cancelledApprovalRequestIds.length > 0;
      if (interruptFailure) {
        return this.failureResult({
          targetThreadId: threadId,
          expectedThreadIds,
          plannedThreadIds: guardedPlan.threadIds,
          deleteOrder: guardedPlan.deleteOrder,
          destructiveStarted,
          interruptedThreadIds,
          cancelledApprovalRequestIds,
          deletedThreadIds,
          reapedThreadIds,
          failure: interruptFailure,
          treeRootThreadId: guardedPlan.treeRootThreadId,
        });
      }

      const finalPlan = await this.planner.buildPlan(threadId);
      if (
        !finalPlan.canDelete ||
        !this.sameSet(expectedThreadIds, finalPlan.threadIds)
      ) {
        return this.failureResult({
          targetThreadId: threadId,
          expectedThreadIds,
          plannedThreadIds: finalPlan.threadIds,
          deleteOrder: finalPlan.deleteOrder,
          destructiveStarted,
          interruptedThreadIds,
          cancelledApprovalRequestIds,
          deletedThreadIds,
          reapedThreadIds,
          failure: {
            stage: 'drift',
            code: ErrorCode.threads.deletePlanChanged,
            message:
              'The delete plan changed after active turns were interrupted',
          },
          latestPreview: finalPlan,
          treeRootThreadId: finalPlan.treeRootThreadId,
        });
      }
      const finalStateFailure = this.confirmedDestructiveStateFailure(
        finalPlan,
        expectedRunningThreadIds,
        expectedPendingApprovalRequestIds,
        expectedPendingApprovalThreadIds,
      );
      if (finalStateFailure) {
        return this.failureResult({
          targetThreadId: threadId,
          expectedThreadIds,
          plannedThreadIds: finalPlan.threadIds,
          deleteOrder: finalPlan.deleteOrder,
          destructiveStarted,
          interruptedThreadIds,
          cancelledApprovalRequestIds,
          deletedThreadIds,
          reapedThreadIds,
          failure: finalStateFailure,
          latestPreview: finalPlan,
          treeRootThreadId: finalPlan.treeRootThreadId,
        });
      }

      for (const deletingThreadId of finalPlan.deleteOrder) {
        const failure = await this.deleteOneThread(
          deletingThreadId,
          expectedSet,
          deletedThreadIds,
          reapedThreadIds,
          cancelledApprovalRequestIds,
        );
        // Derived from what actually happened rather than from "we entered the
        // loop": a first `thread/delete` that fails outright destroys nothing,
        // and reporting that as `partial` tells the user their tree is now
        // half-removed when it is entirely intact.
        destructiveStarted =
          destructiveStarted ||
          deletedThreadIds.length > 0 ||
          reapedThreadIds.length > 0 ||
          cancelledApprovalRequestIds.length > 0;
        if (failure) {
          this.logger.warn(
            `Thread delete stopped at ${deletingThreadId}: ${failure.message}`,
          );
          return this.failureResult({
            targetThreadId: threadId,
            expectedThreadIds,
            plannedThreadIds: finalPlan.threadIds,
            deleteOrder: finalPlan.deleteOrder,
            destructiveStarted,
            interruptedThreadIds,
            cancelledApprovalRequestIds,
            deletedThreadIds,
            reapedThreadIds,
            failure,
            treeRootThreadId: finalPlan.treeRootThreadId,
          });
        }
      }

      return {
        targetThreadId: threadId,
        status: 'completed',
        destructiveStarted,
        expectedThreadIds,
        plannedThreadIds: finalPlan.threadIds,
        deleteOrder: finalPlan.deleteOrder,
        interruptedThreadIds,
        cancelledApprovalRequestIds,
        deletedThreadIds,
        reapedThreadIds,
        remainingThreadIds: [],
        updatedTree: this.readUpdatedTree(finalPlan.treeRootThreadId, [
          ...deletedThreadIds,
          ...reapedThreadIds,
        ]),
        diagnostics: [],
      };
    } finally {
      this.deletionRegistry.end(initialPlan.threadIds);
    }
  }

  private async interruptRunningThreads(
    runningThreadIds: string[],
    interruptedThreadIds: string[],
    cancelledApprovalRequestIds: string[],
  ): Promise<ThreadDeleteFailureDto | null> {
    for (const threadId of runningThreadIds) {
      let turnId: string | null;
      try {
        turnId = await this.readInProgressTurnId(threadId);
      } catch (err) {
        return this.failure(
          'interrupt',
          ErrorCode.threads.deleteInterruptFailed,
          err,
          threadId,
        );
      }
      if (!turnId) continue;
      try {
        await this.codex.request('turn/interrupt', { threadId, turnId });
        interruptedThreadIds.push(threadId);
        this.appendCancelledRequestIds(
          cancelledApprovalRequestIds,
          this.pendingApprovals.cancelPendingForThreads(
            [threadId],
            'thread delete interrupted turn',
          ),
        );
      } catch (err) {
        if (!(await this.isThreadStillActive(threadId))) continue;
        return this.failure(
          'interrupt',
          ErrorCode.threads.deleteInterruptFailed,
          err,
          threadId,
        );
      }
    }
    return null;
  }

  private async deleteOneThread(
    threadId: string,
    expectedSet: Set<string>,
    deletedThreadIds: string[],
    reapedThreadIds: string[],
    cancelledApprovalRequestIds: string[],
  ): Promise<ThreadDeleteFailureDto | null> {
    try {
      await this.codex.request<v2.ThreadDeleteResponse>('thread/delete', {
        threadId,
      });
      deletedThreadIds.push(threadId);
    } catch (err) {
      if (!isThreadNotFoundError(err)) {
        return this.failure(
          'delete',
          isDescendantRejectedError(err)
            ? ErrorCode.threads.deleteTopologyConflict
            : ErrorCode.threads.deleteFailed,
          err,
          threadId,
        );
      }
    }

    // Terminated here rather than inside local cleanup: the conversation is gone
    // on the server from this point on, so its pending requests can never be
    // answered no matter what happens next. Leaving them to cleanup meant a
    // cleanup failure left them `pending`, and anything keyed on "still pending"
    // — the gateway's suppressed-request replay — would then surface a card for
    // a conversation that no longer exists.
    this.appendCancelledRequestIds(
      cancelledApprovalRequestIds,
      this.pendingApprovals.cancelPendingForThreads(
        [threadId],
        'thread deleted',
      ),
    );

    const cleanupFailure = this.reapLocalThread(threadId, expectedSet);
    if (cleanupFailure) return cleanupFailure;
    // The observer normally evicts on `thread/deleted`, but a thread that was
    // already gone app-server side never emits one, so drop it explicitly here
    // to keep observed settings from outliving the thread.
    this.settingsObserver.forget(threadId);
    reapedThreadIds.push(threadId);
    return null;
  }

  private reapLocalThread(
    threadId: string,
    expectedSet: Set<string>,
  ): ThreadDeleteFailureDto | null {
    try {
      this.branches.clearActiveMemberForDeletedThread(threadId);
      this.branchMutations.reapDeletedThread(threadId, expectedSet);
      this.db
        .delete(tokenUsageSnapshots)
        .where(eq(tokenUsageSnapshots.threadId, threadId))
        .run();
      this.db.delete(turnDiffs).where(eq(turnDiffs.threadId, threadId)).run();
      this.db.delete(turnErrors).where(eq(turnErrors.threadId, threadId)).run();
      this.resumeRegistry.forget(threadId);
      return null;
    } catch (err) {
      return this.failure(
        'local_cleanup',
        err instanceof OrphanedLocalTopologyError
          ? ErrorCode.threads.deleteOrphanedLocalTopology
          : ErrorCode.threads.deleteLocalCleanupFailed,
        err,
        threadId,
      );
    }
  }

  private async readInProgressTurnId(threadId: string): Promise<string | null> {
    let response: v2.ThreadReadResponse;
    try {
      response = await this.codex.request<v2.ThreadReadResponse>(
        'thread/read',
        {
          threadId,
          includeTurns: true,
        },
      );
    } catch (err) {
      if (!isUnmaterializedThreadReadError(err)) throw err;
      // A thread can be running before its first user message is persisted, and
      // app-server then refuses to reconstruct turns at all. Re-read metadata so
      // this still resolves to a typed conflict below rather than escaping as a
      // raw transport error the caller cannot classify.
      const metadata = await this.codex.request<v2.ThreadReadResponse>(
        'thread/read',
        { threadId, includeTurns: false },
      );
      response = { thread: { ...metadata.thread, turns: [] } };
    }
    if (response.thread.status.type !== 'active') return null;
    const inProgress = [...response.thread.turns]
      .reverse()
      .find((turn) => turn.status === 'inProgress');
    if (inProgress) return inProgress.id;
    throw new BusinessException(
      ErrorCode.threads.deleteInterruptFailed,
      HttpStatus.CONFLICT,
      'Active conversation has no in-progress turn to interrupt',
      { threadId },
    );
  }

  private async isThreadStillActive(threadId: string): Promise<boolean> {
    try {
      const response = await this.codex.request<v2.ThreadReadResponse>(
        'thread/read',
        { threadId, includeTurns: false },
      );
      return response.thread.status.type === 'active';
    } catch (err) {
      return !isThreadNotFoundError(err);
    }
  }

  private readExpectedThreadIds(body: ThreadDeleteRequestDto): string[] {
    const raw = body?.expectedThreadIds;
    if (!Array.isArray(raw)) {
      throw BusinessException.badRequest(
        ErrorCode.threads.deleteThreadIdSetRequired,
        'expectedThreadIds is required',
      );
    }
    const threadIds = [...new Set(raw.map((id) => id.trim()))].filter(Boolean);
    if (threadIds.length === 0) {
      throw BusinessException.badRequest(
        ErrorCode.threads.deleteThreadIdSetRequired,
        'expectedThreadIds must not be empty',
      );
    }
    return threadIds;
  }

  /**
   * Reads an optional declared-state id list.
   *
   * Returns null when the caller omitted the field entirely. That distinction
   * is the whole contract: an omitted list means "I am not declaring this
   * dimension, do not check it", whereas an empty array means "I was shown
   * none, so any is new". Collapsing the two would make every conversation
   * that is running or holds a pending approval permanently undeletable by any
   * client that does not send the field.
   */
  private readOptionalThreadIds(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null;
    return [...new Set(raw.map((id) => String(id).trim()))].filter(Boolean);
  }

  private confirmedDestructiveStateFailure(
    plan: ThreadDeletePreviewDto,
    expectedRunningThreadIds: string[] | null,
    expectedPendingApprovalRequestIds: string[] | null,
    expectedPendingApprovalThreadIds: string[] | null,
  ): ThreadDeleteFailureDto | null {
    const running = expectedRunningThreadIds
      ? this.findNewIds(plan.runningThreadIds, expectedRunningThreadIds)
      : [];
    if (running.length > 0) {
      return {
        stage: 'drift',
        code: ErrorCode.threads.deletePlanChanged,
        message:
          'A conversation started running after the delete confirmation was shown',
        threadId: running[0],
      };
    }

    // Request ids are the precise dimension — a second approval arriving on an
    // already-pending thread is invisible at thread granularity. Fall back to
    // thread ids only when the caller declared those instead, and check neither
    // when the caller declared nothing.
    const pending = expectedPendingApprovalRequestIds
      ? this.findNewIds(
          plan.pendingApprovals.map((request) => request.requestId),
          expectedPendingApprovalRequestIds,
        )
      : expectedPendingApprovalThreadIds
        ? this.findNewIds(
            plan.pendingApprovalThreadIds,
            expectedPendingApprovalThreadIds,
          )
        : [];
    if (pending.length > 0) {
      return {
        stage: 'drift',
        code: ErrorCode.threads.deletePlanChanged,
        message:
          'A pending approval arrived after the delete confirmation was shown',
        threadId:
          plan.pendingApprovals.find((request) =>
            pending.includes(request.requestId),
          )?.threadId ?? pending[0],
      };
    }
    return null;
  }

  private findNewIds(current: string[], expected: string[]): string[] {
    const expectedSet = new Set(expected);
    return current.filter((id) => !expectedSet.has(id));
  }

  private appendCancelledRequestIds(
    target: string[],
    requests: Array<{ requestId: string }>,
  ): void {
    for (const request of requests) {
      if (!target.includes(request.requestId)) target.push(request.requestId);
    }
  }

  private sameSet(left: string[], right: string[]): boolean {
    if (left.length !== right.length) return false;
    const rightSet = new Set(right);
    return left.every((item) => rightSet.has(item));
  }

  private readUpdatedTree(
    treeRootThreadId: string,
    removedThreadIds: string[],
  ): ThreadDeleteResultDto['updatedTree'] {
    if (removedThreadIds.includes(treeRootThreadId)) return null;
    return this.branches.readBranchTree(treeRootThreadId);
  }

  private conflictResult(
    targetThreadId: string,
    expectedThreadIds: string[],
    latestPreview: ThreadDeletePreviewDto,
    message: string,
    stage: DeleteFailureStage,
  ): ThreadDeleteResultDto {
    return {
      targetThreadId,
      status: 'conflict',
      destructiveStarted: false,
      expectedThreadIds,
      plannedThreadIds: latestPreview.threadIds,
      deleteOrder: latestPreview.deleteOrder,
      interruptedThreadIds: [],
      cancelledApprovalRequestIds: [],
      deletedThreadIds: [],
      reapedThreadIds: [],
      remainingThreadIds: latestPreview.threadIds,
      failure: {
        stage,
        code:
          stage === 'drift'
            ? ErrorCode.threads.deletePlanChanged
            : ErrorCode.threads.deleteTopologyConflict,
        message,
      },
      latestPreview,
      diagnostics: latestPreview.adoption.diagnostics,
    };
  }

  private failureResult(params: {
    targetThreadId: string;
    expectedThreadIds: string[];
    plannedThreadIds: string[];
    deleteOrder: string[];
    destructiveStarted: boolean;
    interruptedThreadIds: string[];
    cancelledApprovalRequestIds: string[];
    deletedThreadIds: string[];
    reapedThreadIds: string[];
    failure: ThreadDeleteFailureDto;
    latestPreview?: ThreadDeletePreviewDto;
    treeRootThreadId?: string;
  }): ThreadDeleteResultDto {
    const remainingThreadIds = params.plannedThreadIds.filter(
      (id) =>
        !params.deletedThreadIds.includes(id) &&
        !params.reapedThreadIds.includes(id),
    );
    const updatedTree =
      params.treeRootThreadId &&
      params.failure.stage !== 'local_cleanup' &&
      (params.deletedThreadIds.length > 0 || params.reapedThreadIds.length > 0)
        ? this.readUpdatedTree(params.treeRootThreadId, [
            ...params.deletedThreadIds,
            ...params.reapedThreadIds,
          ])
        : undefined;
    return {
      targetThreadId: params.targetThreadId,
      status: params.destructiveStarted ? 'partial' : 'failed',
      destructiveStarted: params.destructiveStarted,
      expectedThreadIds: params.expectedThreadIds,
      plannedThreadIds: params.plannedThreadIds,
      deleteOrder: params.deleteOrder,
      interruptedThreadIds: params.interruptedThreadIds,
      cancelledApprovalRequestIds: params.cancelledApprovalRequestIds,
      deletedThreadIds: params.deletedThreadIds,
      reapedThreadIds: params.reapedThreadIds,
      remainingThreadIds,
      failure: params.failure,
      latestPreview: params.latestPreview,
      ...(updatedTree !== undefined && { updatedTree }),
      diagnostics: params.latestPreview?.adoption.diagnostics ?? [],
    };
  }

  private failure(
    stage: DeleteFailureStage,
    code: string,
    err: unknown,
    threadId: string,
  ): ThreadDeleteFailureDto {
    return {
      stage,
      code,
      message: err instanceof Error ? err.message : String(err),
      threadId,
    };
  }
}
