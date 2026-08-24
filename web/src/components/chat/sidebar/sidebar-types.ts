/** Shared types and pure helpers for the thread sidebar. */
import type { BranchTreeDto, ThreadDto } from '@/generated/api';

// SidebarView type is defined in layout-store.ts as SidebarViewState.
// Re-export for backward compatibility with child components.
export type { SidebarViewState as SidebarView } from '@/stores/layout-store';

export type ConfirmAction =
  | { type: 'archive'; thread: ThreadDto }
  | { type: 'compact'; thread: ThreadDto }
  | null;

export interface WorkspaceGroup {
  cwd: string;
  threads: ThreadDto[];
}

/** Display label for a thread: name → preview → truncated id. */
export function threadLabel(thread: ThreadDto): string {
  return thread.name?.trim() || thread.preview || thread.id.slice(0, 8);
}

/** Extract the last path segment from a cwd for display. */
export function workspaceLabel(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1) ?? cwd;
}

/**
 * Maps every locally tracked branch thread to the root of its tree.
 *
 * Only non-root members are included, so a lookup miss means "this thread is a
 * root, or this client never tracked it" — both render as ordinary rows.
 */
export function buildBranchRootIndex(
  trees: BranchTreeDto[] | undefined,
): Map<string, string> {
  const rootByThreadId = new Map<string, string>();
  for (const tree of trees ?? []) {
    for (const member of tree.members) {
      if (member.parentThreadId) {
        rootByThreadId.set(member.threadId, tree.treeRootThreadId);
      }
    }
  }
  return rootByThreadId;
}

/**
 * Maps each tree root to the branch members hidden behind its row.
 *
 * Used to lift attention-worthy state (running, awaiting approval) from a
 * hidden branch up to the row the user can actually see.
 */
export function buildBranchMemberIndex(
  trees: BranchTreeDto[] | undefined,
): Map<string, string[]> {
  const membersByRoot = new Map<string, string[]>();
  for (const tree of trees ?? []) {
    const hidden = tree.members
      .filter((member) => member.parentThreadId)
      .map((member) => member.threadId);
    if (hidden.length > 0) membersByRoot.set(tree.treeRootThreadId, hidden);
  }
  return membersByRoot;
}

/**
 * Collapses branch members into their root row and lifts the tree's activity.
 *
 * A branch is not its own conversation from the user's point of view, so it
 * must not occupy a sidebar row; but if the newest activity happened inside a
 * hidden branch, the visible root row would otherwise sink in the list.
 *
 * The list is paginated, which bounds this in two ways. Activity is aggregated
 * only over members on the same page. And a member is only folded away when its
 * root is on that page too — an active branch can otherwise sort onto page 1
 * while its older root does not, and hiding it would make the whole
 * conversation unreachable from the sidebar.
 *
 * @param threads - One page of threads as returned by the server
 * @param rootByThreadId - Index from {@link buildBranchRootIndex}
 */
export function collapseBranchThreads(
  threads: ThreadDto[],
  rootByThreadId: Map<string, string>,
): ThreadDto[] {
  if (rootByThreadId.size === 0) return threads;

  const presentIds = new Set(threads.map((thread) => thread.id));
  const isFoldable = (threadId: string): boolean => {
    const rootId = rootByThreadId.get(threadId);
    return rootId !== undefined && presentIds.has(rootId);
  };

  const latestByRoot = new Map<string, number>();
  for (const thread of threads) {
    if (!isFoldable(thread.id)) continue;
    const rootId = rootByThreadId.get(thread.id)!;
    const current = latestByRoot.get(rootId) ?? 0;
    if (thread.updatedAt > current) latestByRoot.set(rootId, thread.updatedAt);
  }

  return threads
    .filter((thread) => !isFoldable(thread.id))
    .map((thread) => {
      const branchActivity = latestByRoot.get(thread.id);
      return branchActivity && branchActivity > thread.updatedAt
        ? { ...thread, updatedAt: branchActivity }
        : thread;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Group threads by cwd, preserving insertion order. */
export function groupByWorkspace(threads: ThreadDto[]): WorkspaceGroup[] {
  const groups = new Map<string, ThreadDto[]>();
  for (const thread of threads) {
    const group = groups.get(thread.cwd) ?? [];
    group.push(thread);
    groups.set(thread.cwd, group);
  }
  return Array.from(groups.entries()).map(([cwd, groupThreads]) => ({
    cwd,
    threads: groupThreads,
  }));
}
