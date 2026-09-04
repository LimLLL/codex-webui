/** Server-side branch-collapsed projection for the conversation sidebar. */
import { Injectable } from '@nestjs/common';
import type { v2 } from '../codex/codex-schema';
import { CodexService } from '../codex/codex.service';
import { ConversationBranchMutationsService } from '../conversation-branches/conversation-branch-mutations.service';
import { ConversationBranchesService } from '../conversation-branches/conversation-branches.service';
import { PendingApprovalsService } from '../pending-approvals/pending-approvals.service';
import type {
  ThreadOverviewResponseDto,
  ThreadOverviewRowDto,
} from './dto/threads.dto';

export interface ThreadOverviewParams {
  cursor?: string;
  limit?: number;
  archived?: boolean;
  searchTerm?: string;
  cwd?: string;
  sortKey?: 'created_at' | 'updated_at';
}

interface ThreadSnapshot {
  thread: v2.Thread;
  archived: boolean;
}

interface ProjectionGroup {
  displayThreadId: string;
  treeRootThreadId: string;
  members: v2.Thread[];
}

@Injectable()
export class ThreadsOverviewService {
  constructor(
    private readonly codex: CodexService,
    private readonly branchMutations: ConversationBranchMutationsService,
    private readonly branches: ConversationBranchesService,
    private readonly pendingApprovals: PendingApprovalsService,
  ) {}

  /**
   * Returns a branch-collapsed, already sorted overview page.
   *
   * Unlike the former client join, folding is based on the complete filtered
   * snapshot rather than the raw page app-server happened to return. When the
   * true root is filtered out, the highest visible ancestor becomes the row so
   * the remaining branch stays reachable.
   */
  async listOverview(
    params: ThreadOverviewParams,
  ): Promise<ThreadOverviewResponseDto> {
    const limit = params.limit ?? 100;
    const offset = this.parseCursor(params.cursor);
    const archived = params.archived ?? false;
    const filteredThreads = await this.listAllThreads({
      archived,
      searchTerm: params.searchTerm,
      cwd: params.cwd,
      sortKey: params.sortKey,
    });
    const topologySnapshots = await this.listTopologyThreads(
      archived,
      filteredThreads,
      Boolean(params.searchTerm ?? params.cwd),
    );

    const topologyById = new Map(
      topologySnapshots.map((snapshot) => [snapshot.thread.id, snapshot]),
    );
    const visibleIds = new Set(filteredThreads.map((thread) => thread.id));
    const { parentByChild, childrenByParent } =
      this.buildTopology(topologyById);
    const groups = this.groupVisibleThreads(
      filteredThreads,
      parentByChild,
      visibleIds,
    );
    const pendingCounts = this.countPendingApprovals(filteredThreads);
    const activePointers = this.branches.listActiveMembers(
      groups.map((group) => group.treeRootThreadId),
    );

    const rows = groups
      .map((group) =>
        this.toRow(group, childrenByParent, activePointers, pendingCounts),
      )
      .sort((a, b) => this.compareRows(a, b, params.sortKey));

    const page = rows.slice(offset, offset + limit);
    return {
      data: page,
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
    };
  }

  private async listAllThreads(params: {
    archived: boolean;
    searchTerm?: string;
    cwd?: string;
    sortKey?: 'created_at' | 'updated_at';
  }): Promise<v2.Thread[]> {
    const data: v2.Thread[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await this.codex.request<v2.ThreadListResponse>(
        'thread/list',
        {
          cursor,
          limit: 200,
          archived: params.archived,
          searchTerm: params.searchTerm,
          cwd: params.cwd,
          sortKey: params.sortKey,
          modelProviders: [],
        },
      );
      data.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    return data;
  }

  /**
   * Collects the thread set used to reconstruct fork topology.
   *
   * Topology must span both archived states, because a visible branch can hang
   * off an archived ancestor. It must not, however, re-enumerate a list the
   * caller already holds: a full enumeration costs one round trip per 200
   * stored threads and this projection runs on every sidebar refresh.
   *
   * The already-fetched page can only stand in for its archived state when the
   * caller applied no filters — a `searchTerm` or `cwd` narrows it to a subset,
   * and reusing that subset would silently drop the parent links of everything
   * filtered out, un-collapsing branches whose ancestor lies outside the filter.
   *
   * @param archived - Archived state the caller already enumerated
   * @param alreadyFetched - Threads the caller holds for that state
   * @param filtered - Whether `alreadyFetched` is a filtered subset
   */
  private async listTopologyThreads(
    archived: boolean,
    alreadyFetched: v2.Thread[],
    filtered: boolean,
  ): Promise<ThreadSnapshot[]> {
    const snapshots: ThreadSnapshot[] = [];
    for (const state of [false, true]) {
      const reusable = state === archived && !filtered;
      const threads = reusable
        ? alreadyFetched
        : await this.listAllThreads({ archived: state });
      snapshots.push(...threads.map((thread) => ({ thread, archived: state })));
    }
    return snapshots;
  }

  private buildTopology(topologyById: Map<string, ThreadSnapshot>): {
    parentByChild: Map<string, string>;
    childrenByParent: Map<string, Set<string>>;
  } {
    const parentByChild = new Map<string, string>();
    const childrenByParent = new Map<string, Set<string>>();
    const addEdge = (childThreadId: string, parentThreadId: string) => {
      if (childThreadId === parentThreadId) return;
      if (parentByChild.has(childThreadId)) return;
      parentByChild.set(childThreadId, parentThreadId);
      const children = childrenByParent.get(parentThreadId) ?? new Set();
      children.add(childThreadId);
      childrenByParent.set(parentThreadId, children);
    };

    for (const edge of this.branchMutations.listEdges()) {
      addEdge(edge.childThreadId, edge.parentThreadId);
    }
    for (const snapshot of topologyById.values()) {
      if (snapshot.thread.forkedFromId) {
        addEdge(snapshot.thread.id, snapshot.thread.forkedFromId);
      }
    }
    return { parentByChild, childrenByParent };
  }

  private groupVisibleThreads(
    threads: v2.Thread[],
    parentByChild: Map<string, string>,
    visibleIds: Set<string>,
  ): ProjectionGroup[] {
    const groups = new Map<string, ProjectionGroup>();
    for (const thread of threads) {
      const displayThreadId = this.resolveDisplayThreadId(
        thread.id,
        parentByChild,
        visibleIds,
      );
      const group = groups.get(displayThreadId) ?? {
        displayThreadId,
        treeRootThreadId: this.resolveTreeRootThreadId(
          displayThreadId,
          parentByChild,
        ),
        members: [],
      };
      group.members.push(thread);
      groups.set(displayThreadId, group);
    }
    return [...groups.values()];
  }

  private resolveDisplayThreadId(
    threadId: string,
    parentByChild: Map<string, string>,
    visibleIds: Set<string>,
  ): string {
    let current = threadId;
    let displayThreadId = threadId;
    const seen = new Set<string>();
    while (parentByChild.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentByChild.get(current)!;
      if (visibleIds.has(current)) displayThreadId = current;
    }
    return displayThreadId;
  }

  private resolveTreeRootThreadId(
    threadId: string,
    parentByChild: Map<string, string>,
  ): string {
    let current = threadId;
    const seen = new Set<string>();
    while (parentByChild.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentByChild.get(current)!;
    }
    return current;
  }

  private countPendingApprovals(threads: v2.Thread[]): Map<string, number> {
    const counts = new Map<string, number>();
    const pending = this.pendingApprovals.listPending(
      threads.map((thread) => thread.id),
    );
    for (const request of pending) {
      counts.set(request.threadId, (counts.get(request.threadId) ?? 0) + 1);
    }
    return counts;
  }

  private toRow(
    group: ProjectionGroup,
    childrenByParent: Map<string, Set<string>>,
    activePointers: ReturnType<
      ConversationBranchesService['listActiveMembers']
    >,
    pendingCounts: Map<string, number>,
  ): ThreadOverviewRowDto {
    const displayThread =
      group.members.find((thread) => thread.id === group.displayThreadId) ??
      group.members[0];
    const memberIds = group.members.map((thread) => thread.id);
    const hiddenThreadIds = memberIds.filter(
      (threadId) => threadId !== group.displayThreadId,
    );
    const latestActivityAt = Math.max(
      ...group.members.map((thread) => thread.updatedAt),
    );
    const flags = group.members.flatMap((thread) =>
      thread.status.type === 'active' ? (thread.status.activeFlags ?? []) : [],
    );
    const pendingApprovalCount = memberIds.reduce(
      (sum, threadId) => sum + (pendingCounts.get(threadId) ?? 0),
      0,
    );
    const activePointer =
      activePointers.get(group.treeRootThreadId)?.activeThreadId ?? null;
    const openThreadId =
      activePointer && memberIds.includes(activePointer)
        ? activePointer
        : group.displayThreadId;

    return {
      thread: {
        ...displayThread,
        model: null,
        reasoningEffort: null,
        updatedAt: latestActivityAt,
      },
      treeRootThreadId: group.treeRootThreadId,
      openThreadId,
      memberThreadIds: memberIds,
      hiddenThreadIds,
      hasBranchDescendants:
        hiddenThreadIds.length > 0 ||
        (childrenByParent.get(group.displayThreadId)?.size ?? 0) > 0,
      latestActivityAt,
      running:
        group.members.some((thread) => thread.status.type === 'active') &&
        !flags.includes('waitingOnApproval') &&
        !flags.includes('waitingOnUserInput'),
      waitingOnApproval:
        flags.includes('waitingOnApproval') || pendingApprovalCount > 0,
      waitingOnUserInput: flags.includes('waitingOnUserInput'),
      pendingApprovalCount,
    };
  }

  private compareRows(
    a: ThreadOverviewRowDto,
    b: ThreadOverviewRowDto,
    sortKey: 'created_at' | 'updated_at' | undefined,
  ): number {
    if (sortKey === 'created_at') {
      return b.thread.createdAt - a.thread.createdAt;
    }
    return b.latestActivityAt - a.latestActivityAt;
  }

  private parseCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    const parsed = Number(cursor);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
}
