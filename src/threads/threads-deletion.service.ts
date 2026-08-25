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
import { DRIZZLE_DB, type AppDatabase } from '../database/database.constants';
import { tokenUsageSnapshots, turnDiffs, turnErrors } from '../database/schema';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import { ThreadDeletionRegistryService } from '../thread-deletion/thread-deletion-registry.service';
import { ThreadResumeRegistryService } from './thread-resume-registry.service';
import {
  isDescendantRejectedError,
  isNotMaterializedError,
  isThreadNotFoundError,
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
    private readonly pendingApprovals: PendingApprovalsService,
    private readonly resumeRegistry: ThreadResumeRegistryService,
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
    reapedThreadIds.push(threadId);
    return null;
  }

  private reapLocalThread(
    threadId: string,
    expectedSet: Set<string>,
  ): ThreadDeleteFailureDto | null {
    try {
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
      if (!isNotMaterializedError(err)) throw err;
      response = await this.codex.request<v2.ThreadReadResponse>(
        'thread/read',
        {
          threadId,
          includeTurns: false,
        },
      );
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
  }): ThreadDeleteResultDto {
    const remainingThreadIds = params.plannedThreadIds.filter(
      (id) =>
        !params.deletedThreadIds.includes(id) &&
        !params.reapedThreadIds.includes(id),
    );
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
