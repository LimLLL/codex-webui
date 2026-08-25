/** Delete-preview reads and the destructive delete mutation. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  threadsDeletionDeleteThreadMutation,
  threadsDeletionPreviewDeleteOptions,
  threadsDeletionReadBranchAdoptionStatusOptions,
  threadsReadBranchTreeQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import type {
  ThreadDeletePreviewDto,
  ThreadDeleteResultDto,
} from '@/generated/api/types.gen';
import { getApiErrorMessage } from '@/lib/api-error';
import {
  invalidateBranchTreeMembersSoon,
  invalidateBranchTreesSoon,
  invalidateThreadListSoon,
} from '@/lib/query-invalidation';
import { showSnackbar } from '@/stores/snackbar-store';
import { useTimelineStore } from '@/stores/timeline-store';

/**
 * Reads the exact cascade a delete would perform.
 *
 * Never cached: the preview is the artefact the user consents to, and a stale
 * one would describe a set that no longer matches what the server would remove.
 * The backend re-plans and rejects mismatches, so a stale preview cannot cause
 * a wrong deletion — but it can make the dialog describe the wrong thing, which
 * is the failure this whole flow exists to prevent.
 *
 * @param threadId - Thread the user asked to delete, or null when closed
 */
export function useDeletePreview(threadId: string | null) {
  return useQuery({
    ...threadsDeletionPreviewDeleteOptions({
      path: { threadId: threadId ?? '' },
    }),
    enabled: Boolean(threadId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Reads startup adoption scanner state, which gates every delete entry point. */
export function useBranchAdoptionStatus() {
  return useQuery({
    ...threadsDeletionReadBranchAdoptionStatusOptions(),
    staleTime: 15_000,
    refetchInterval: (query) =>
      query.state.data?.status === 'ready' ? false : 3_000,
  });
}

/** Human-readable reason the delete entry point is unavailable, if any. */
export function adoptionBlockReason(
  status: ReturnType<typeof useBranchAdoptionStatus>['data'],
  t: (key: string) => string,
): string | null {
  if (!status) return t('Checking branch topology…');
  if (status.status === 'ready') return null;
  if (status.status === 'failed') {
    return t('Branch topology scan failed; deletion is disabled.');
  }
  return t('Branch topology scan is still running.');
}

interface DeleteArgs {
  targetThreadId: string;
  preview: ThreadDeletePreviewDto;
}

/**
 * Builds the delete request body from the preview the user actually confirmed.
 *
 * The declared state is what makes auto-interrupt honest. Deletion interrupts
 * whatever is running, so a conversation that starts running *after* the
 * confirmation would be interrupted without ever having been named in it.
 * Declaring what was on screen lets the server refuse and re-ask instead.
 *
 * Approval *request* ids rather than thread ids: a second approval arriving on
 * a thread that already had one is invisible at thread granularity.
 *
 * @param preview - Exactly the preview rendered in the confirmation dialog
 */
export function buildDeleteRequestBody(preview: ThreadDeletePreviewDto) {
  return {
    expectedThreadIds: preview.threadIds,
    expectedRunningThreadIds: preview.runningThreadIds,
    expectedPendingApprovalRequestIds: preview.pendingApprovals.map(
      (request) => request.requestId,
    ),
  };
}

/**
 * Picks the version to land on once `targetThreadId` is destroyed.
 *
 * Deleting a version is not deleting the conversation, so dropping the user on
 * the empty state misrepresents what just happened. The switcher's own ordering
 * is the answer: step back to the nearest earlier version, which is what the
 * `< n/m >` control would have moved to. Later versions are only a fallback —
 * a cascade takes the target's descendants with it, so under normal topology
 * every one of them is doomed too.
 *
 * @param targetThreadId - Version being deleted
 * @param siblingThreadIds - Every version in the group, in switcher order
 * @param doomed - Full cascade set the server will remove
 * @returns Thread to navigate to, or null when nothing in the group survives
 */
export function pickSurvivingVersion(
  targetThreadId: string,
  siblingThreadIds: string[],
  doomed: Set<string>,
): string | null {
  const index = siblingThreadIds.indexOf(targetThreadId);
  if (index < 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!doomed.has(siblingThreadIds[i])) return siblingThreadIds[i];
  }
  for (let i = index + 1; i < siblingThreadIds.length; i += 1) {
    if (!doomed.has(siblingThreadIds[i])) return siblingThreadIds[i];
  }
  return null;
}

interface UseDeleteThreadOptions {
  /** Runs once the mutation settles, in success and failure alike. */
  onFinished?: () => void;
  /**
   * Resolves where to navigate once the conversation on screen is confirmed
   * destroyed. Receives the set the server actually removed — not the planned
   * cascade — so a partial delete cannot send the user to a thread that is
   * still there in name only. Returning null falls back to the empty state.
   */
  resolveSurvivor?: (removed: Set<string>) => string | null;
}

/**
 * Executes a confirmed cascade delete and tears down local state for it.
 *
 * Nothing moves until the server confirms. An earlier version navigated as soon
 * as the request was issued, on the grounds that sitting inside a conversation
 * being destroyed produces resume and turn requests the backend rejects — but
 * that only held while the confirmation dialog dismissed itself on click. It
 * now stays up for the duration, so the user cannot act on the doomed thread
 * anyway, and leaving early merely asserted a deletion that had not happened
 * yet. A failed delete used to leave them somewhere else with nothing removed.
 */
export function useDeleteThread({
  onFinished,
  resolveSurvivor,
}: UseDeleteThreadOptions = {}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    ...threadsDeletionDeleteThreadMutation(),
    onSuccess: (result: ThreadDeleteResultDto) => {
      const removed = new Set([
        ...result.deletedThreadIds,
        ...result.reapedThreadIds,
      ]);

      // Leave only if the conversation on screen is one of the ones actually
      // gone. Keyed on what the server reports as removed rather than on what
      // was planned: a conflict removes nothing and a partial removes some, and
      // in both cases moving the user would misreport the outcome.
      const store = useTimelineStore.getState();
      if (store.threadId && removed.has(store.threadId)) {
        const survivor = resolveSurvivor?.(removed) ?? null;
        store.clearThread();
        // Split rather than a ternary argument: the router types each `to`
        // against its own params, and a union of the two defeats that inference.
        if (survivor) {
          void navigate({ to: '/t/$threadId', params: { threadId: survivor } });
        } else {
          void navigate({ to: '/' });
        }
      }

      useTimelineStore.getState().forgetThreads([...removed]);

      // Write the server's own post-delete view of the tree straight into the
      // caches that render it, rather than waiting for a refetch.
      //
      // The survivor list must come from the returned tree's own members. The
      // request body carries the *doomed* set, so deriving survivors from it
      // yields an empty list whenever the delete succeeded in full — which left
      // the one cache that actually matters untouched: the version the user is
      // dropped onto is a surviving sibling, not the tree root, so its switcher
      // went on reporting the pre-delete count until something else refetched it.
      const tree = result.updatedTree;
      if (tree) {
        const members = [
          tree.treeRootThreadId,
          ...tree.members.map((member) => member.threadId),
        ];
        for (const threadId of members) {
          if (removed.has(threadId)) continue;
          queryClient.setQueryData(
            threadsReadBranchTreeQueryKey({ path: { threadId } }),
            tree,
          );
        }
      }
      // Removed members keep stale trees otherwise, and a re-visit by id would
      // read one. When no tree came back there are two very different cases:
      // the root was deleted and nothing survives, or the server aborted before
      // it could report one — local cleanup failures omit `updatedTree` while
      // still having removed threads. The second leaves survivors holding a
      // pre-delete topology, so everything the plan touched is refreshed rather
      // than assuming there is nothing left to correct.
      invalidateBranchTreeMembersSoon(
        queryClient,
        tree
          ? [...removed]
          : [
              ...removed,
              ...result.plannedThreadIds,
              ...result.remainingThreadIds,
            ],
      );

      if (result.status === 'completed') {
        showSnackbar(
          t('Deleted {{count}} conversation(s).', { count: removed.size }),
          'success',
        );
      } else if (result.status === 'conflict') {
        showSnackbar(
          `${t('Nothing was deleted; the plan changed. Review and try again.')} ${result.failure?.message ?? ''}`.trim(),
          'warning',
        );
      } else {
        // `partial` means destruction already began; the user must be told the
        // tree is now half-removed rather than left assuming a clean rollback.
        showSnackbar(
          `${t('Deletion stopped partway. Some conversations were removed.')} ${result.failure?.message ?? ''}`.trim(),
          'error',
        );
      }
      onFinished?.();
    },
    onError: (err) => {
      showSnackbar(
        `${t('Could not delete this conversation.')} ${getApiErrorMessage(err)}`,
        'error',
      );
      onFinished?.();
    },
    onSettled: () => {
      // Debounced on the same timers the socket dispatcher uses: a delete also
      // produces `thread/status/changed` and `thread/deleted`, and invalidating
      // here immediately would refetch once now and once again a moment later,
      // reshuffling the sidebar twice for a single action.
      invalidateThreadListSoon(queryClient);
      invalidateBranchTreesSoon(queryClient);
    },
  });
}

export type { DeleteArgs };
