/**
 * Reads and changes one conversation's security policy.
 *
 * This replaces reading and writing the global config from the composer. That
 * was measured against the pinned app-server to have no effect on a
 * conversation already loaded: writing `approval_policy` with the hot-reload
 * flag changed the default for threads started afterwards, while the loaded
 * thread stayed on its original policy and emitted no settings change at all.
 *
 * What this does guarantee is narrower and true, and was measured end to end
 * against a real model turn: a conversation started on `on-request` /
 * read-only asked for approval to write a file; after this patch it ran the
 * same task under `never` / full access without asking. A turn already in
 * flight is untouched, and per the pinned protocol a permission change does not
 * re-sandbox or stop processes that are already running.
 *
 * The hook is a thin view. Ordering, confirmation and the deadline live in the
 * store, because both the badge and the composer mount this and per-mount
 * timers gave one selection two competing deadlines.
 */
import { useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { threadSecurityPolicyPatchSecurityPolicyMutation } from '@/generated/api/@tanstack/react-query.gen';
import type {
  PatchThreadSecurityPolicyDto,
  ThreadSecurityPolicyDto,
} from '@/generated/api';
import {
  applyThreadPolicy,
  refreshThreadPolicy,
  settleIfObserved,
  useThreadPolicyStore,
  type PolicyOutcome,
} from '@/stores/thread-policy-store';

export interface ThreadSecurityPolicyView {
  /** Observed effective policy, or undefined while unknown. */
  observed: ThreadSecurityPolicyDto | undefined;
  /** True when the server has never told us this thread's policy. */
  unknown: boolean;
  /** True when the shown policy is last-known because the latest read failed. */
  stale: boolean;
  /** A selection the user made that is not yet confirmed effective. */
  pending: PatchThreadSecurityPolicyDto | null;
  /** How the wait ended, or `pending` while it continues. */
  outcome: PolicyOutcome | null;
  /** Applies a patch to this conversation. */
  apply: (patch: PatchThreadSecurityPolicyDto) => void;
  /** Dismisses a settled selection so the badge stops reporting it. */
  dismiss: () => void;
  /** True while a selection is unconfirmed, which holds Send. */
  isSettling: boolean;
}

export function useThreadSecurityPolicy(
  threadId: string | null,
): ThreadSecurityPolicyView {
  const pendingEntry = useThreadPolicyStore((s) =>
    threadId ? s.pendingByThread[threadId] : undefined,
  );
  const observed = useThreadPolicyStore((s) =>
    threadId ? s.observedByThread[threadId]?.policy : undefined,
  );
  const stale = useThreadPolicyStore((s) =>
    threadId ? Boolean(s.observedByThread[threadId]?.stale) : false,
  );
  const clearPolicy = useThreadPolicyStore((s) => s.clearPolicy);

  const patch = useMutation(threadSecurityPolicyPatchSecurityPolicyMutation());

  // One read on first sight of a conversation. After that the live path is
  // `thread/settings/updated`, the only event reporting a change made anywhere
  // — this tab, another tab, the CLI — and reconnect re-reads for the window
  // where that event could not be delivered.
  //
  // `observed: false` deliberately does NOT count as having read it. It means
  // the server has not reported this conversation's settings yet, which is
  // absence of evidence; treating the record's existence as the answer left a
  // thread first seen too early permanently stuck on "unknown".
  useEffect(() => {
    if (!threadId) return;
    const held = useThreadPolicyStore.getState().observedByThread[threadId];
    if (held?.policy.observed && !held.stale) return;
    void refreshThreadPolicy(threadId);
  }, [threadId]);

  // A selection can also be satisfied by an observation that arrived for an
  // unrelated reason, so re-evaluate whenever either side moves.
  useEffect(() => {
    if (threadId) settleIfObserved(threadId);
  }, [threadId, observed, pendingEntry]);

  return {
    observed,
    unknown: !observed?.observed,
    stale: stale && Boolean(observed?.observed),
    pending: pendingEntry?.requested ?? null,
    outcome: pendingEntry?.outcome ?? null,
    isSettling: pendingEntry?.outcome === 'pending',
    dismiss: () => {
      if (threadId) clearPolicy(threadId);
    },
    apply: (body) => {
      if (!threadId) return;
      void applyThreadPolicy(threadId, body, () =>
        patch.mutateAsync({ path: { threadId }, body }),
      );
    },
  };
}
