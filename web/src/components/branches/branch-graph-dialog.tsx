/** Full-size, pannable branch graph for one conversation tree. */
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  threadsListThreadsOptions,
  threadsReadBranchTreeOptions,
} from '@/generated/api/@tanstack/react-query.gen';
import { threadsCountTurns } from '@/generated/api/sdk.gen';
import {
  adoptionBlockReason,
  buildDeleteRequestBody,
  useBranchAdoptionStatus,
  useDeletePreview,
  useDeleteThread,
} from '@/hooks/use-thread-deletion';
import { getApiErrorMessage } from '@/lib/api-error';
import { useTimelineStore } from '@/stores/timeline-store';
import type { BranchGraphItem } from './branch-graph';
import { DeleteConversationDialog } from './delete-conversation-dialog';

// Keeps React Flow out of the entry chunk; this dialog is the only interactive
// graph surface and is opened on demand.
const BranchGraphPanel = lazy(() =>
  import('./branch-graph').then((module) => ({
    default: module.BranchGraphPanel,
  })),
);

interface Props {
  /** Any member of the tree to display, or null when closed. */
  threadId: string | null;
  onClose: () => void;
}

/**
 * Renders the whole locally known branch tree.
 *
 * Clicking a node is ordinary thread navigation, which is all a branch switch
 * has ever been — the route is driven entirely by the URL thread id.
 */
export function BranchGraphDialog({ threadId, onClose }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentThreadId = useTimelineStore((s) => s.threadId);
  const threadsById = useTimelineStore((s) => s.threadsById);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    ...threadsReadBranchTreeOptions({ path: { threadId: threadId ?? '' } }),
    enabled: Boolean(threadId),
  });

  // Deleting from the graph is deleting a *subtree*, which is unambiguous
  // topology — so unlike the version switcher, every node is a legitimate
  // target. The switcher's "the group original cannot be deleted here" rule is
  // scoped to a version group; a graph node is a conversation, not a version.
  // The graph is only an entry point: the cascade is always re-planned by the
  // server and confirmed in the existing dialog, never derived from what is
  // drawn here, which can be stale or locally incomplete.
  const adoptionStatus = useBranchAdoptionStatus();
  const deleteBlockedReason = adoptionBlockReason(adoptionStatus.data, t);
  const deletePreview = useDeletePreview(deleteTargetId);
  const deleteThread = useDeleteThread({
    onFinished: () => {
      setDeleteTargetId(null);
      onClose();
    },
  });

  const memberThreadIds = useMemo(
    () => (data?.members ?? []).map((member) => member.threadId),
    [data],
  );

  // Counts are fetched for the whole visible graph in one batched request and
  // are allowed to fail: a node with no count renders without one.
  const { data: turnCounts } = useQuery({
    queryKey: ['branchGraphTurnCounts', memberThreadIds],
    enabled: memberThreadIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const { data: counts } = await threadsCountTurns({
        body: { threadIds: memberThreadIds },
      });
      return new Map(
        (counts?.counts ?? []).map((entry) => [
          entry.threadId,
          entry.count ?? null,
        ]),
      );
    },
  });

  // Creation times are not part of the local branch topology, so they are
  // joined in from the thread list. These options match the sidebar's query
  // exactly, which means this reuses that cache instead of issuing a request.
  // Archived members fall outside it and simply render without a timestamp.
  const { data: threadList } = useQuery({
    ...threadsListThreadsOptions({
      query: { archived: false, limit: 100, sortKey: 'updated_at' },
    }),
    enabled: Boolean(threadId),
  });

  const openThread = useCallback(
    (target: string) => {
      onClose();
      void navigate({ to: '/t/$threadId', params: { threadId: target } });
    },
    [navigate, onClose],
  );

  const items = useMemo<BranchGraphItem[]>(() => {
    if (!data) return [];
    // Version rows carry the human-readable preview; members carry topology.
    //
    // Keyed by group, not by thread: one thread holds a version row in every
    // group it takes part in — it is a *branch* of the group it was forked into,
    // and the *original* of any group created by editing one of its own later
    // messages. Collapsing those onto the thread id lets whichever row happened
    // to come last win, which labels a node with an edit made inside it rather
    // than the edit that created it. Concretely: a fork shown as "message 3"
    // silently became "the later message I edited inside it", and its true label
    // vanished from the graph.
    const previewByGroupedThread = new Map<string, string>();
    // Membership is tracked separately from preview text: a version row with a
    // blank preview is still a member, and the two questions have different
    // answers.
    const groupMemberKeys = new Set<string>();
    const groupKey = (
      threadId: string,
      commonPrefixTurnId: string | null | undefined,
    ) => `${threadId}::${commonPrefixTurnId ?? ''}`;
    for (const group of data.groups) {
      for (const version of group.versions) {
        const key = groupKey(version.threadId, group.commonPrefixTurnId);
        groupMemberKeys.add(key);
        if (!version.previewText.trim()) continue;
        previewByGroupedThread.set(key, version.previewText.trim());
      }
    }

    const childPrefixByParent = new Map<string, string | null | undefined>();
    for (const member of data.members) {
      if (
        member.parentThreadId &&
        !childPrefixByParent.has(member.parentThreadId)
      ) {
        childPrefixByParent.set(
          member.parentThreadId,
          member.commonPrefixTurnId,
        );
      }
    }
    const labelByThreadId = new Map(
      (threadList?.data ?? []).map((thread) => [
        thread.id,
        thread.name?.trim() || thread.preview?.trim() || '',
      ]),
    );

    /**
     * Labels a node with the message that distinguishes it from its parent.
     *
     * The root was not forked from anything, so it has no group of its own; its
     * counterpart text lives in the group its children forked out of, where it
     * sits as the original. Failing that it falls back to the app-server's own
     * thread preview, which is what the sidebar shows for the same conversation.
     */
    const labelFor = (member: (typeof data.members)[number]): string => {
      const own = previewByGroupedThread.get(
        groupKey(member.threadId, member.commonPrefixTurnId),
      );
      if (own) return own;
      if (!member.parentThreadId) {
        const asOriginal = previewByGroupedThread.get(
          groupKey(
            member.threadId,
            childPrefixByParent.get(member.threadId) ?? null,
          ),
        );
        if (asOriginal) return asOriginal;
      }
      return labelByThreadId.get(member.threadId) || member.threadId.slice(0, 8);
    };

    const labelByMember = new Map(
      data.members.map((member) => [member.threadId, labelFor(member)]),
    );

    // The message a fork was made from is the group's `original` row.
    const editedMessageByPrefix = new Map<string, string>();
    for (const group of data.groups) {
      const text = group.versions
        .find((version) => version.kind === 'original')
        ?.previewText.trim();
      if (text) editedMessageByPrefix.set(group.commonPrefixTurnId ?? '', text);
    }

    /**
     * Names the edited message on an edge, but only when it adds information.
     *
     * When a child is just another version of the message its parent is named
     * after, the label would restate the parent node and add nothing. It earns
     * its place in the other case: an edit made to some *later* message inside
     * the parent, where nothing on screen otherwise says which message the child
     * diverged from.
     */
    const edgeLabelFor = (member: (typeof data.members)[number]) => {
      if (!member.parentThreadId) return null;
      // A topology-only fork (an ordinary fork, or an adopted one with no
      // boundary) carries a common prefix but is not a member of any version
      // group. Looking the label up by prefix alone would hand it the message of
      // whichever real group happens to share that prefix — an edit that did not
      // create this edge.
      if (!groupMemberKeys.has(groupKey(member.threadId, member.commonPrefixTurnId))) {
        return null;
      }
      const edited = editedMessageByPrefix.get(member.commonPrefixTurnId ?? '');
      if (!edited) return null;
      if (edited === labelByMember.get(member.parentThreadId)) return null;
      return edited.length > 18 ? `${edited.slice(0, 18)}…` : edited;
    };

    const createdAtByThreadId = new Map(
      (threadList?.data ?? []).map((thread) => [thread.id, thread.createdAt]),
    );
    return data.members.map((member) => ({
      threadId: member.threadId,
      parentThreadId: member.parentThreadId ?? null,
      edgeLabel: edgeLabelFor(member),
      data: {
        label: labelByMember.get(member.threadId) ?? member.threadId.slice(0, 8),
        // No delete anchor in a browse graph; see BranchGraphNodeData.isTarget.
        isTarget: false,
        isCurrent: member.threadId === currentThreadId,
        isDoomed: false,
        running: Boolean(threadsById[member.threadId]?.loading),
        pendingApprovalCount: Object.values(
          threadsById[member.threadId]?.approvals ?? {},
        ).filter((approval) => approval.status === 'pending').length,
        archived: false,
        external: member.source === 'adopted',
        // Every member here comes from a persisted edge row, and an edge is only
        // written once its fork point is known — adoption reconstructs it from
        // the rollout's `history_base`. Forks whose boundary really is unknown
        // never become edges; they reach the delete planner from app-server's
        // `forkedFromId` instead, which is where that flag belongs.
        boundaryUnknown: false,
        createdAt: createdAtByThreadId.get(member.threadId) ?? null,
        turnCount: turnCounts?.get(member.threadId) ?? null,
        clickable: true,
        onDelete: setDeleteTargetId,
        deleteBlockedReason,
      },
    }));
  }, [
    data,
    currentThreadId,
    threadsById,
    threadList,
    turnCounts,
    deleteBlockedReason,
  ]);

  return (
    <Dialog open={Boolean(threadId)} onOpenChange={(next) => !next && onClose()}>
      {/* Wide on desktop: a branch tree spreads horizontally as versions
          accumulate, and a narrow box forces panning for structure that would
          otherwise fit on screen. */}
      <DialogContent className="w-[min(94vw,1400px)] max-w-none sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{t('Branch graph')}</DialogTitle>
          <DialogDescription>
            {t(
              'Each node is one branch of this conversation; an edge is labelled with the message that was edited to create the branch below it. Click a node to open it, or use its bin icon to delete it and everything below it.',
            )}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex h-[min(70vh,620px)] items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex h-[min(70vh,620px)] items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            }
          >
            <BranchGraphPanel
              items={items}
              onNodeClick={openThread}
              className="h-[min(70vh,620px)] rounded-md border"
            />
          </Suspense>
        )}
      </DialogContent>

      <DeleteConversationDialog
        open={deleteTargetId !== null}
        preview={deletePreview.data ?? null}
        loading={deletePreview.isLoading}
        errorMessage={
          deletePreview.error ? getApiErrorMessage(deletePreview.error) : null
        }
        pending={deleteThread.isPending}
        currentThreadId={currentThreadId}
        onConfirm={(preview) =>
          deleteThread.mutate({
            path: { threadId: preview.targetThreadId },
            body: buildDeleteRequestBody(preview),
          })
        }
        onClose={() => setDeleteTargetId(null)}
      />
    </Dialog>
  );
}
