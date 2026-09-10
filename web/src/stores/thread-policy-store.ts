/**
 * Owns one conversation's observed security policy and any change awaiting
 * confirmation.
 *
 * The requested selection and the observed effective settings are deliberately
 * separate pieces of state. The patch endpoint returns a queued acknowledgement
 * — it says the request was accepted, not that the values are in force — so
 * treating the response as confirmation is exactly the mistake that made the
 * old global badge lie about what the conversation was running under.
 *
 * Observations are ordered by a monotonic sequence stamped when a read is
 * ISSUED, not when it resolves. That ordering is not decoration: with the read
 * held in a TanStack query, an invalidation fired by the confirming
 * notification was measured to be swallowed while the first read was still in
 * flight — one request was made in total and its pre-notification body became
 * the cached answer, so the badge kept showing the old policy and the composer
 * waited for a confirmation that had already come and gone.
 *
 * Confirmation is also owned here rather than in the hook, because the badge
 * and the composer both mount that hook: per-mount timers meant two deadlines,
 * two forced reads, and a window that restarted whenever either re-rendered.
 */
import { create } from 'zustand';
import { threadSecurityPolicyReadSecurityPolicy } from '@/generated/api/sdk.gen';
import { showSnackbar } from '@/stores/snackbar-store';
import i18n from '@/i18n';
import type {
  PatchThreadSecurityPolicyDto,
  ThreadSecurityPolicyDto,
} from '@/generated/api';

/** How long a selection may wait for confirmation before it is resolved. */
const CONFIRMATION_TIMEOUT_MS = 8_000;

/** How the wait for a requested selection ended. */
export type PolicyOutcome =
  /** Still waiting for a matching observation. */
  | 'pending'
  /** The patch itself was rejected; the conversation kept its old policy. */
  | 'rejected'
  /** The wait ended and a fresh read showed the request did not take effect. */
  | 'ineffective'
  /** The wait ended and the policy could not be read at all. */
  | 'unknown';

export interface PendingPolicyPatch {
  requested: PatchThreadSecurityPolicyDto;
  /** Absolute deadline, so remounting cannot extend the wait. */
  deadline: number;
  outcome: PolicyOutcome;
}

interface PolicyObservation {
  policy: ThreadSecurityPolicyDto;
  /** Sequence at which the evidence was requested. */
  seq: number;
  /**
   * True when the most recent read failed, so this evidence is last-known
   * rather than current.
   *
   * A failed read is not evidence and must not replace a known policy with a
   * guess — but continuing to present the old value as if it were current is
   * the same lie the global badge used to tell. The value stays; the claim
   * about it weakens.
   */
  stale?: boolean;
}

interface ThreadPolicyState {
  pendingByThread: Record<string, PendingPolicyPatch | undefined>;
  observedByThread: Record<string, PolicyObservation | undefined>;
  /** Records a selection as requested and unconfirmed. */
  requestPolicy: (
    threadId: string,
    requested: PatchThreadSecurityPolicyDto,
    deadline: number,
  ) => void;
  /** Ends the wait with a stated outcome, keeping it visible to the user. */
  settlePolicy: (
    threadId: string,
    outcome: Exclude<PolicyOutcome, 'pending'>,
  ) => void;
  /** Drops the pending record once observed settings caught up, or on cancel. */
  clearPolicy: (threadId: string) => void;
  /** Records evidence about effective settings, newest issue order wins. */
  observePolicy: (
    threadId: string,
    policy: ThreadSecurityPolicyDto,
    seq: number,
  ) => void;
  /** Marks the held evidence as last-known after a read failed. */
  markPolicyStale: (threadId: string) => void;
  /** Forgets a conversation's policy state entirely. */
  forgetPolicy: (threadId: string) => void;
}

let observationSeq = 0;
/** Latest issued read, including one whose response has not arrived yet. */
const latestReadByThread = new Map<string, number>();
/** Stamps a read before it is issued so a slow response cannot outrank a newer one. */
export function nextPolicySeq(): number {
  return ++observationSeq;
}

export const useThreadPolicyStore = create<ThreadPolicyState>((set) => ({
  pendingByThread: {},
  observedByThread: {},
  requestPolicy: (threadId, requested, deadline) =>
    set((state) => ({
      pendingByThread: {
        ...state.pendingByThread,
        [threadId]: { requested, deadline, outcome: 'pending' },
      },
    })),
  settlePolicy: (threadId, outcome) =>
    set((state) => {
      const pending = state.pendingByThread[threadId];
      if (!pending || pending.outcome !== 'pending') return state;
      return {
        pendingByThread: {
          ...state.pendingByThread,
          [threadId]: { ...pending, outcome },
        },
      };
    }),
  clearPolicy: (threadId) => {
    cancelConfirmation(threadId);
    set((state) => {
      if (!state.pendingByThread[threadId]) return state;
      const pendingByThread = { ...state.pendingByThread };
      delete pendingByThread[threadId];
      return { pendingByThread };
    });
  },
  observePolicy: (threadId, policy, seq) =>
    set((state) => {
      const existing = state.observedByThread[threadId];
      if (seq < (latestReadByThread.get(threadId) ?? 0)) return state;
      if (existing && existing.seq >= seq) return state;
      return {
        observedByThread: {
          ...state.observedByThread,
          [threadId]: { policy, seq },
        },
      };
    }),
  markPolicyStale: (threadId) =>
    set((state) => {
      const existing = state.observedByThread[threadId];
      if (!existing || existing.stale) return state;
      return {
        observedByThread: {
          ...state.observedByThread,
          [threadId]: { ...existing, stale: true },
        },
      };
    }),
  forgetPolicy: (threadId) => {
    cancelConfirmation(threadId);
    latestReadByThread.delete(threadId);
    set((state) => {
      const pendingByThread = { ...state.pendingByThread };
      const observedByThread = { ...state.observedByThread };
      delete pendingByThread[threadId];
      delete observedByThread[threadId];
      return { pendingByThread, observedByThread };
    });
  },
}));

/**
 * Reads a conversation's effective policy and records it as evidence.
 *
 * @param threadId - Conversation to read
 * A read has a bounded transport wait as well as a selection deadline. Otherwise
 * the deadline's final read could hang forever and never report `unknown`.
 * @returns Current evidence from this or a newer read, or undefined if unavailable
 */
export async function refreshThreadPolicy(
  threadId: string,
): Promise<ThreadSecurityPolicyDto | undefined> {
  const seq = nextPolicySeq();
  latestReadByThread.set(threadId, seq);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIRMATION_TIMEOUT_MS);
  try {
    const { data } = await threadSecurityPolicyReadSecurityPolicy({
      path: { threadId },
      signal: controller.signal,
    });
    if (!data) {
      if (latestReadByThread.get(threadId) === seq) {
        useThreadPolicyStore.getState().markPolicyStale(threadId);
      }
      return undefined;
    }
    if (latestReadByThread.get(threadId) !== seq) {
      // A superseded response must not confirm a request through the return
      // value after being rejected by observePolicy. Only newer, completed
      // evidence can stand in for it; an outstanding read proves nothing.
      const current =
        useThreadPolicyStore.getState().observedByThread[threadId];
      return current &&
        current.seq > seq &&
        current.seq === latestReadByThread.get(threadId)
        ? current.policy
        : undefined;
    }
    useThreadPolicyStore.getState().observePolicy(threadId, data, seq);
    return data;
  } catch {
    // A failed read is not evidence of anything. The last observation stands,
    // which is strictly better than replacing a known policy with a guess —
    // but it is flagged, so the badge can stop calling it current.
    if (latestReadByThread.get(threadId) === seq) {
      useThreadPolicyStore.getState().markPolicyStale(threadId);
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Drops every trace of a conversation's policy state.
 *
 * Exposed as a plain function so the timeline store can call it when a thread
 * is destroyed without reaching into this store's shape.
 *
 * @param threadId - Conversation that no longer exists
 */
export function forgetThreadPolicy(threadId: string): void {
  useThreadPolicyStore.getState().forgetPolicy(threadId);
}

/** Confirmation timers, one per conversation regardless of how many views mount. */
const confirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Cancels any outstanding confirmation timer for a conversation. */
function cancelConfirmation(threadId: string): void {
  const timer = confirmationTimers.get(threadId);
  if (timer) {
    clearTimeout(timer);
    confirmationTimers.delete(threadId);
  }
}

/**
 * Requests a policy change and drives it to a stated outcome.
 *
 * Confirmation is an observation, never the patch response. When the wait runs
 * out the policy is READ rather than assumed: a missing confirmation means the
 * outcome is unknown, and both "it silently worked and the notification was
 * lost" and "it never applied" are live possibilities. Only the read
 * distinguishes them, and only then can the badge tell the user which happened.
 *
 * @param threadId - Conversation to change
 * @param requested - The leaves to patch
 * @param patch - Sends the patch; can reject on either refusal or transport loss
 */
export async function applyThreadPolicy(
  threadId: string,
  requested: PatchThreadSecurityPolicyDto,
  patch: () => Promise<unknown>,
): Promise<void> {
  const store = useThreadPolicyStore.getState();
  cancelConfirmation(threadId);
  store.requestPolicy(
    threadId,
    requested,
    Date.now() + CONFIRMATION_TIMEOUT_MS,
  );
  const selection = useThreadPolicyStore.getState().pendingByThread[threadId];
  // Object identity distinguishes even a rapid re-selection of the same values.
  // Old PATCH failures and expired reads belong to their original selection.
  const isCurrent = () =>
    useThreadPolicyStore.getState().pendingByThread[threadId] === selection;

  confirmationTimers.set(
    threadId,
    setTimeout(() => {
      if (!isCurrent()) return;
      confirmationTimers.delete(threadId);
      void (async () => {
        const observed = await refreshThreadPolicy(threadId);
        if (!isCurrent()) return;
        const state = useThreadPolicyStore.getState();
        const pending = state.pendingByThread[threadId];
        if (!pending || pending.outcome !== 'pending') return;
        if (policySatisfies(observed, pending.requested)) {
          state.clearPolicy(threadId);
          return;
        }
        const outcome = observed?.observed ? 'ineffective' : 'unknown';
        state.settlePolicy(threadId, outcome);
        // Surfaced outside the popover on purpose: the popover is closed by the
        // time this fires in every realistic case, and a warning nobody can see
        // is the same as no warning.
        notifyPolicyOutcome(outcome);
      })();
    }, CONFIRMATION_TIMEOUT_MS),
  );

  try {
    await patch();
  } catch (error) {
    if (!isCurrent()) return;
    // The SDK throws the backend's error body for an HTTP refusal, but also
    // throws on network loss. Losing a response does not prove nothing applied.
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    if (
      typeof status === 'number' &&
      [400, 401, 403, 404, 409, 413, 422, 429].includes(status)
    ) {
      cancelConfirmation(threadId);
      useThreadPolicyStore.getState().settlePolicy(threadId, 'rejected');
      notifyPolicyOutcome('rejected');
      return;
    }
    // Keep the existing deadline and read actual settings for uncertain delivery,
    // exactly as for an acknowledgement whose confirming notification was lost.
  }
  if (!isCurrent()) return;
  // Acceptance queues the change. Read once immediately in case it was already
  // in force — a re-selection of the current policy would otherwise sit out the
  // whole window waiting for a notification that has no change to report.
  await refreshThreadPolicy(threadId);
  if (isCurrent()) settleIfObserved(threadId);
}

/** Tells the user how a policy change ended, wherever they are looking. */
function notifyPolicyOutcome(outcome: Exclude<PolicyOutcome, 'pending'>): void {
  showSnackbar(
    outcome === 'unknown'
      ? i18n.t(
          'Could not confirm the security policy change. Check the badge before sending.',
        )
      : i18n.t(
          'The security policy change did not take effect. This conversation kept its previous settings.',
        ),
    outcome === 'unknown' ? 'warning' : 'error',
  );
}

/**
 * Clears a pending selection once observed settings satisfy it.
 *
 * Called on every new observation. Deliberately does not require the patch to
 * have been acknowledged first: if the effective settings already match what
 * was asked for, the conversation IS running under that policy, and holding
 * Send any longer would be blocking on a formality rather than on a fact.
 *
 * @param threadId - Conversation to re-evaluate
 */
export function settleIfObserved(threadId: string): void {
  const state = useThreadPolicyStore.getState();
  const pending = state.pendingByThread[threadId];
  if (!pending || pending.outcome !== 'pending') return;
  const observation = state.observedByThread[threadId];
  // A newer read can still be pending or can have failed. Neither lets the
  // preceding observation act as confirmation of current effective settings.
  if (!observation || observation.seq < (latestReadByThread.get(threadId) ?? 0))
    return;
  if (policySatisfies(observation.policy, pending.requested)) {
    cancelConfirmation(threadId);
    state.clearPolicy(threadId);
  }
}

/** Reads the sandbox variant tag, which is all the picker's label distinguishes. */
export function sandboxMode(
  policy: ThreadSecurityPolicyDto['sandboxPolicy'] | undefined,
): string | null {
  return policy?.type ?? null;
}

type SandboxPolicy = NonNullable<ThreadSecurityPolicyDto['sandboxPolicy']>;

/**
 * Whether an observed sandbox is the one that was requested.
 *
 * Every field carries meaning, so the variant tag alone is not confirmation:
 * two `workspaceWrite` policies with different writable roots authorize
 * different things, and one with network disabled authorizes strictly less than
 * one with it enabled. Comparing only the tag reported a change effective while
 * the conversation ran under a materially different sandbox.
 *
 * @param observed - Sandbox currently in force, if known
 * @param requested - Sandbox the patch asked for
 * @returns True only when every field the request named matches
 */
function sandboxSatisfies(
  observed: SandboxPolicy | null | undefined,
  requested: SandboxPolicy,
): boolean {
  if (!observed || observed.type !== requested.type) return false;
  switch (requested.type) {
    case 'dangerFullAccess':
      return true;
    case 'readOnly':
      return (
        observed.type === 'readOnly' &&
        observed.networkAccess === requested.networkAccess
      );
    case 'externalSandbox':
      return (
        observed.type === 'externalSandbox' &&
        observed.networkAccess === requested.networkAccess
      );
    case 'workspaceWrite': {
      if (observed.type !== 'workspaceWrite') return false;
      const sameRoots =
        observed.writableRoots.length === requested.writableRoots.length &&
        requested.writableRoots.every((root) =>
          observed.writableRoots.includes(root),
        );
      return (
        sameRoots &&
        observed.networkAccess === requested.networkAccess &&
        observed.excludeTmpdirEnvVar === requested.excludeTmpdirEnvVar &&
        observed.excludeSlashTmp === requested.excludeSlashTmp
      );
    }
  }
}

/**
 * Whether the observed settings already satisfy a requested patch.
 *
 * Only the fields the patch actually named are compared: a patch that changed
 * the sandbox says nothing about the approval policy, and requiring the
 * untouched field to match some remembered value would hold Send forever if
 * another client changed it in between.
 *
 * @param observed - Last observed effective settings
 * @param requested - The patch to confirm
 * @returns True when every named field is in force
 */
export function policySatisfies(
  observed: ThreadSecurityPolicyDto | undefined,
  requested: PatchThreadSecurityPolicyDto,
): boolean {
  // `observed: false` means the server has never reported this conversation's
  // settings, so its null fields are absence of evidence, not evidence of null.
  if (!observed?.observed) return false;
  if (requested.approvalPolicy !== undefined) {
    // Granular policies are objects; the picker only ever requests the string
    // forms, so anything non-string cannot be what this patch asked for.
    if (typeof requested.approvalPolicy !== 'string') return false;
    if (observed.approvalPolicy !== requested.approvalPolicy) return false;
  }
  if (requested.sandboxPolicy !== undefined) {
    if (!sandboxSatisfies(observed.sandboxPolicy, requested.sandboxPolicy))
      return false;
  }
  return true;
}
