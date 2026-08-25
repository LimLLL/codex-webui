/** Message-level branch data: version lookup per turn, and branch creation. */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  threadsCreateMessageBranchMutation,
  threadsListBranchTreesQueryKey,
  threadsListThreadsQueryKey,
  threadsReadBranchTreeOptions,
  threadsReadBranchTreeQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import type { BranchTreeDto, BranchVersionDto } from '@/generated/api/types.gen';
import { getApiErrorMessage } from '@/lib/api-error';
import { showSnackbar } from '@/stores/snackbar-store';

/** Sibling versions of one edited message, positioned for a `< n/m >` switcher. */
export interface MessageVersions {
  /** 1-based position of the version currently being viewed. */
  position: number;
  /** Total sibling count, including the original. */
  total: number;
  /** All siblings ordered by creation, for prev/next navigation. */
  versions: BranchVersionDto[];
}

/**
 * Indexes a branch tree by the turn each version's message occupies.
 *
 * A version's message turn differs per thread even within one group, so the
 * lookup key is the turn id as named in the thread currently being viewed.
 *
 * Version switchers are deliberately **path-local**: a group only lists the
 * threads that took part in creating it. Editing a turn inherited from an
 * ancestor therefore shows a switcher inside the branch where the edit was
 * made, but not in the ancestor — where that turn is unchanged and has no
 * alternative. This is intended, not a gap: the ancestor and the branch hold
 * byte-identical content for that turn, so counting them as two versions would
 * misreport what actually diverged.
 */
function indexVersionsByTurnId(
  tree: BranchTreeDto | undefined,
  threadId: string,
): Map<string, MessageVersions> {
  const byTurnId = new Map<string, MessageVersions>();
  if (!tree) return byTurnId;

  for (const group of tree.groups) {
    if (group.versions.length < 2) continue;
    const current = group.versions.find(
      (version) => version.threadId === threadId,
    );
    // The group belongs to a sibling branch the user is not currently viewing.
    if (!current?.messageTurnId) continue;

    byTurnId.set(current.messageTurnId, {
      position: group.versions.indexOf(current) + 1,
      total: group.versions.length,
      versions: group.versions,
    });
  }
  return byTurnId;
}

/**
 * Reads the branch tree for a thread and indexes it for timeline rendering.
 *
 * @param threadId - Thread currently being viewed, or null when none is open
 */
export function useMessageVersions(threadId: string | null): {
  versionsByTurnId: Map<string, MessageVersions>;
  isTracked: boolean;
  treeRootThreadId: string | null;
} {
  const { data } = useQuery({
    ...threadsReadBranchTreeOptions({ path: { threadId: threadId ?? '' } }),
    enabled: Boolean(threadId),
    staleTime: 30_000,
  });

  const versionsByTurnId = useMemo(
    () => indexVersionsByTurnId(data, threadId ?? ''),
    [data, threadId],
  );

  return {
    versionsByTurnId,
    isTracked: data?.tracked ?? false,
    treeRootThreadId: data?.treeRootThreadId ?? null,
  };
}

/**
 * Creates a new version of a user message by forking before its turn.
 *
 * On success the caller is moved to the fresh branch and the original text is
 * handed back so it can be pre-filled for editing. The branch stays empty until
 * that edited message is actually sent.
 */
export function useCreateMessageBranch(onBranchReady: (text: string) => void) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    ...threadsCreateMessageBranchMutation(),
    onSuccess: (res, vars) => {
      const childThreadId = res.fork.thread.id;
      void queryClient.invalidateQueries({
        queryKey: threadsReadBranchTreeQueryKey({
          path: { threadId: vars.path.threadId },
        }),
      });
      void queryClient.invalidateQueries({
        queryKey: threadsListBranchTreesQueryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: threadsListThreadsQueryKey(),
      });
      void navigate({ to: '/t/$threadId', params: { threadId: childThreadId } });
      onBranchReady(vars.body?.previewText ?? '');
    },
    onError: (err) => {
      showSnackbar(
        `${t('Could not create a new version of this message.')} ${getApiErrorMessage(err)}`,
        'error',
      );
    },
  });
}
