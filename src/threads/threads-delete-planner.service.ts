/** Builds exact topology-based delete previews for thread cascades. */
import { Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import type { v2 } from '../codex/codex-schema';
import { ConversationBranchAdoptionService } from '../conversation-branches/conversation-branch-adoption.service';
import { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import type {
  DeletePlanThreadSource,
  ThreadDeleteBlockerDto,
  ThreadDeletePlanThreadDto,
  ThreadDeletePreviewDto,
} from './dto/thread-deletion.dto';
import { ErrorCode } from '../common/error-codes';

interface ThreadSnapshot {
  thread: v2.Thread;
  archived: boolean;
}

interface PlanEdge {
  childThreadId: string;
  parentThreadId: string;
  source: DeletePlanThreadSource;
}

@Injectable()
export class ThreadsDeletePlannerService {
  constructor(
    private readonly codex: CodexService,
    private readonly adoption: ConversationBranchAdoptionService,
    private readonly branchMutations: ConversationBranchMutationsService,
    private readonly pendingApprovals: PendingApprovalsService,
  ) {}

  /** Returns the exact id set and leaf-to-root order for deleting a subtree. */
  async buildPlan(threadId: string): Promise<ThreadDeletePreviewDto> {
    this.adoption.assertReadyForDeletion();
    const snapshots = await this.listAllThreadSnapshots();
    const localEdges = this.branchMutations.listEdges().map((edge) => ({
      childThreadId: edge.childThreadId,
      parentThreadId: edge.parentThreadId,
      source: edge.source === 'adopted' ? 'adopted' : 'local',
    })) satisfies PlanEdge[];
    const serverEdges: PlanEdge[] = [...snapshots.values()]
      .filter((snapshot) => Boolean(snapshot.thread.forkedFromId))
      .map((snapshot) => ({
        childThreadId: snapshot.thread.id,
        parentThreadId: snapshot.thread.forkedFromId!,
        source: 'server',
      }));

    const { childrenByParent, parentByChild, sourceByChild, blockers } =
      this.mergeEdges([...localEdges, ...serverEdges]);
    const treeRootThreadId = this.resolveRoot(threadId, parentByChild);
    const { threadIds, depths } = this.collectReachable(
      threadId,
      childrenByParent,
    );
    const deleteOrder = this.postOrder(threadId, childrenByParent, new Set());
    const deleteOrderIndex = new Map(
      deleteOrder.map((id, index) => [id, index]),
    );
    const pendingApprovals = this.pendingApprovals.listPending(threadIds);
    const pendingCounts = this.countPendingApprovals(pendingApprovals);

    const relevantBlockers = blockers.filter((item) =>
      this.blockerIntersects(item, threadIds),
    );
    relevantBlockers.push(
      ...this.adoption.getBlockingDiagnostics(threadIds).map((item) => ({
        code: item.code,
        message: item.message,
        threadId: item.threadId,
        parentThreadId: item.parentThreadId,
      })),
    );

    const threads = threadIds
      .map((id): ThreadDeletePlanThreadDto => {
        const snapshot = snapshots.get(id);
        const status = snapshot?.thread.status.type ?? 'missing';
        return {
          threadId: id,
          parentThreadId: parentByChild.get(id) ?? null,
          childThreadIds: [...(childrenByParent.get(id) ?? [])].sort(),
          depth: depths.get(id) ?? 0,
          deleteOrderIndex: deleteOrderIndex.get(id) ?? -1,
          source:
            id === threadId ? 'target' : (sourceByChild.get(id) ?? 'server'),
          status,
          active: status === 'active',
          pendingApprovalCount: pendingCounts.get(id) ?? 0,
          name: snapshot?.thread.name ?? null,
          preview: snapshot?.thread.preview ?? null,
          cwd: snapshot?.thread.cwd ? String(snapshot.thread.cwd) : null,
          archived: snapshot?.archived ?? false,
          createdAt: snapshot?.thread.createdAt ?? null,
          updatedAt: snapshot?.thread.updatedAt ?? null,
        };
      })
      .sort(
        (a, b) => a.depth - b.depth || a.threadId.localeCompare(b.threadId),
      );

    return {
      targetThreadId: threadId,
      treeRootThreadId,
      threadIds,
      deleteOrder,
      threads,
      runningThreadIds: threads
        .filter((item) => item.active)
        .map((item) => item.threadId),
      pendingApprovalThreadIds: threads
        .filter((item) => item.pendingApprovalCount > 0)
        .map((item) => item.threadId),
      pendingApprovals,
      canDelete: relevantBlockers.length === 0,
      blockers: relevantBlockers,
      adoption: this.adoption.getStatus(),
    };
  }

  private async listAllThreadSnapshots(): Promise<Map<string, ThreadSnapshot>> {
    const snapshots = new Map<string, ThreadSnapshot>();
    for (const archived of [false, true]) {
      let cursor: string | null | undefined;
      do {
        const response = await this.codex.request<v2.ThreadListResponse>(
          'thread/list',
          { cursor, limit: 200, archived, modelProviders: [] },
        );
        for (const thread of response.data) {
          if (!snapshots.has(thread.id)) {
            snapshots.set(thread.id, { thread, archived });
          }
        }
        cursor = response.nextCursor;
      } while (cursor);
    }
    return snapshots;
  }

  private mergeEdges(edges: PlanEdge[]): {
    childrenByParent: Map<string, Set<string>>;
    parentByChild: Map<string, string>;
    sourceByChild: Map<string, DeletePlanThreadSource>;
    blockers: ThreadDeleteBlockerDto[];
  } {
    const childrenByParent = new Map<string, Set<string>>();
    const parentByChild = new Map<string, string>();
    const sourceByChild = new Map<string, DeletePlanThreadSource>();
    const blockers: ThreadDeleteBlockerDto[] = [];

    for (const edge of edges) {
      const existingParent = parentByChild.get(edge.childThreadId);
      if (existingParent && existingParent !== edge.parentThreadId) {
        blockers.push({
          code: ErrorCode.threads.deleteTopologyConflict,
          message: 'Local and server topology disagree for a fork child',
          threadId: edge.childThreadId,
          parentThreadId: edge.parentThreadId,
        });
      } else if (!existingParent) {
        parentByChild.set(edge.childThreadId, edge.parentThreadId);
      }

      const children = childrenByParent.get(edge.parentThreadId) ?? new Set();
      children.add(edge.childThreadId);
      childrenByParent.set(edge.parentThreadId, children);
      const previousSource = sourceByChild.get(edge.childThreadId);
      if (
        !previousSource ||
        this.sourcePriority(edge.source) < this.sourcePriority(previousSource)
      ) {
        sourceByChild.set(edge.childThreadId, edge.source);
      }
    }
    return { childrenByParent, parentByChild, sourceByChild, blockers };
  }

  private countPendingApprovals(
    approvals: ThreadDeletePreviewDto['pendingApprovals'],
  ): Map<string, number> {
    const counts = new Map<string, number>();
    for (const approval of approvals) {
      counts.set(approval.threadId, (counts.get(approval.threadId) ?? 0) + 1);
    }
    return counts;
  }

  private collectReachable(
    threadId: string,
    childrenByParent: Map<string, Set<string>>,
  ): { threadIds: string[]; depths: Map<string, number> } {
    const threadIds: string[] = [];
    const depths = new Map<string, number>();
    const queue: Array<{ threadId: string; depth: number }> = [
      { threadId, depth: 0 },
    ];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || seen.has(current.threadId)) continue;
      seen.add(current.threadId);
      threadIds.push(current.threadId);
      depths.set(current.threadId, current.depth);
      for (const childId of [
        ...(childrenByParent.get(current.threadId) ?? []),
      ].sort()) {
        queue.push({ threadId: childId, depth: current.depth + 1 });
      }
    }
    return { threadIds, depths };
  }

  private postOrder(
    threadId: string,
    childrenByParent: Map<string, Set<string>>,
    seen: Set<string>,
  ): string[] {
    if (seen.has(threadId)) return [];
    seen.add(threadId);
    const children = [...(childrenByParent.get(threadId) ?? [])].sort();
    return [
      ...children.flatMap((childId) =>
        this.postOrder(childId, childrenByParent, seen),
      ),
      threadId,
    ];
  }

  private resolveRoot(
    threadId: string,
    parentByChild: Map<string, string>,
  ): string {
    const seen = new Set<string>();
    let current = threadId;
    while (parentByChild.has(current)) {
      if (seen.has(current)) return threadId;
      seen.add(current);
      current = parentByChild.get(current)!;
    }
    return current;
  }

  private sourcePriority(source: DeletePlanThreadSource): number {
    switch (source) {
      case 'local':
        return 0;
      case 'adopted':
        return 1;
      case 'server':
        return 2;
      case 'target':
        return 3;
    }
  }

  private blockerIntersects(
    blocker: ThreadDeleteBlockerDto,
    threadIds: string[],
  ): boolean {
    const ids = new Set(threadIds);
    return (
      (blocker.threadId !== undefined && ids.has(blocker.threadId)) ||
      (blocker.parentThreadId !== undefined && ids.has(blocker.parentThreadId))
    );
  }
}
