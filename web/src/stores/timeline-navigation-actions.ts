/** Conversation timeline navigation actions. */
import { useWorkspaceStore } from './workspace-store';
import { forgetTranscriptBookmarks } from '@/lib/transcript-anchor';
import { getSocket } from '../socket';
import { forgetThreadPolicy } from './thread-policy-store';
import { invalidateThreadEpoch } from '../lib/thread-recovery-epoch';
import { excludePendingReads } from '../lib/pending-read-coverage';
import {
  type TimelineState,
  type TimelineActionContext,
} from './timeline-state';
import {
  normalizeMaxIdleSubscriptions,
  createRuntime,
  readRuntime,
  selectedFields,
  persistSelectedRuntime,
  hasPendingApproval,
  touchRuntime,
  isSafeToCleanupIdleRuntime,
  compareIdleCleanupCandidates,
} from './timeline-runtime';

/** Concrete navigation mutations keep each conversation's ownership and lifecycle explicit. */
export function createTimelineNavigationActions({
  set,
  get,
  applyThreadUpdate,
}: TimelineActionContext): Pick<
  TimelineState,
  | 'ensureThreadState'
  | 'selectThread'
  | 'resubscribeAll'
  | 'unsubscribeThread'
  | 'forgetThreads'
  | 'setMaxIdleSubscriptions'
  | 'cleanupIdleThreadSubscriptions'
  | 'getThreadTitle'
  | 'getThreadRuntime'
  | 'isThreadBusy'
  | 'hasPendingApproval'
  | 'setActiveThread'
  | 'setReadOnlyThread'
  | 'clearThread'
> {
  return {
    ensureThreadState: (input) => {
      set((state) => {
        const existing = readRuntime(state, input.threadId);
        if (existing) return {};
        return {
          threadsById: {
            ...persistSelectedRuntime(state),
            [input.threadId]: createRuntime(input),
          },
        };
      });
    },

    selectThread: (threadId) => {
      for (const subscribed of get().subscribedThreadIds) {
        if (subscribed !== threadId) get().unsubscribeThread(subscribed);
      }
      set((state) => {
        const threadsById = persistSelectedRuntime(state);
        if (!threadId) {
          return {
            ...selectedFields(null),
            selectedThreadId: null,
            threadsById,
          };
        }
        const runtime = touchRuntime(
          threadsById[threadId] ?? createRuntime({ threadId }),
        );
        return {
          ...selectedFields(runtime),
          selectedThreadId: threadId,
          threadsById: { ...threadsById, [threadId]: runtime },
        };
      });
    },

    resubscribeAll: (onSubscribed) => {
      const socket = getSocket();
      for (const threadId of get().subscribedThreadIds) {
        socket.emit(
          'thread.subscribe',
          { threadId },
          (reply: { ok?: boolean }) => {
            if (reply?.ok) onSubscribed?.(threadId);
          },
        );
      }
    },

    unsubscribeThread: (threadId) => {
      const socket = getSocket();
      if (socket.connected) socket.emit('thread.unsubscribe', { threadId });
      set((state) => {
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        subscribedThreadIds.delete(threadId);
        return { subscribedThreadIds };
      });
    },

    /**
     * Drops every trace of threads that no longer exist.
     *
     * `unsubscribeThread` only leaves the socket room; the runtime survives in
     * `threadsById` and would be handed straight back to a deep link or a back
     * navigation to a deleted thread, showing content for a conversation that
     * is gone. The selected runtime needs special care: it lives in the
     * top-level fields, and the usual `selectThread(null)` path persists it into
     * `threadsById` on the way out — which would resurrect what we are deleting.
     *
     * @param threadIds - Threads that were destroyed
     */
    forgetThreads: (threadIds) => {
      useWorkspaceStore.getState().forgetConversations(threadIds);
      forgetTranscriptBookmarks(threadIds);
      const doomed = new Set(threadIds);
      if (doomed.size === 0) return;
      excludePendingReads(doomed);

      const socket = getSocket();
      const subscribed = get().subscribedThreadIds;
      for (const threadId of doomed) {
        invalidateThreadEpoch(threadId);
        if (subscribed.has(threadId)) {
          if (socket.connected) socket.emit('thread.unsubscribe', { threadId });
        }
      }

      set((state) => {
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        for (const threadId of doomed) subscribedThreadIds.delete(threadId);

        const selectedDoomed =
          state.selectedThreadId !== null && doomed.has(state.selectedThreadId);
        const threadsById = selectedDoomed
          ? { ...state.threadsById }
          : persistSelectedRuntime(state);
        for (const threadId of doomed) delete threadsById[threadId];

        return selectedDoomed
          ? {
              ...selectedFields(null),
              selectedThreadId: null,
              threadsById,
              subscribedThreadIds,
            }
          : { threadsById, subscribedThreadIds };
      });
    },

    setMaxIdleSubscriptions: (limit) => {
      const maxIdleSubscriptions = normalizeMaxIdleSubscriptions(limit);
      set({ maxIdleSubscriptions });
      get().cleanupIdleThreadSubscriptions(maxIdleSubscriptions);
    },

    cleanupIdleThreadSubscriptions: (limit) => {
      const maxIdleSubscriptions = normalizeMaxIdleSubscriptions(
        limit ?? get().maxIdleSubscriptions,
      );
      const evictedThreadIds: string[] = [];
      const subscribedBefore = get().subscribedThreadIds;

      set((state) => {
        const candidates: Array<{ threadId: string; lastActivityAt: number }> =
          [];
        // Every held runtime, not only the subscribed ones. Attention delivery
        // creates state for conversations this browser never subscribed to and
        // may never open, so scanning subscriptions alone would leave exactly
        // those to accumulate for the life of the session. The safety predicate
        // still refuses to evict anything running or awaiting a decision.
        for (const threadId of Object.keys(persistSelectedRuntime(state))) {
          const runtime = readRuntime(state, threadId);
          if (isSafeToCleanupIdleRuntime(runtime, state.threadId)) {
            candidates.push({
              threadId,
              lastActivityAt: runtime.lastActivityAt,
            });
          }
        }

        if (candidates.length <= maxIdleSubscriptions) return {};

        const now = Date.now();
        candidates.sort((a, b) => compareIdleCleanupCandidates(now, a, b));
        const evictCount = candidates.length - maxIdleSubscriptions;
        const subscribedThreadIds = new Set(state.subscribedThreadIds);
        const threadsById = { ...persistSelectedRuntime(state) };

        for (const candidate of candidates.slice(0, evictCount)) {
          subscribedThreadIds.delete(candidate.threadId);
          delete threadsById[candidate.threadId];
          evictedThreadIds.push(candidate.threadId);
        }

        return { subscribedThreadIds, threadsById };
      });

      const socket = getSocket();
      excludePendingReads(evictedThreadIds);
      for (const threadId of evictedThreadIds) {
        invalidateThreadEpoch(threadId);
        forgetThreadPolicy(threadId);
        if (socket.connected && subscribedBefore.has(threadId))
          socket.emit('thread.unsubscribe', { threadId });
      }
    },

    getThreadTitle: (threadId) => {
      const runtime = readRuntime(get(), threadId);
      return runtime?.threadTitle ?? threadId.slice(0, 8);
    },

    getThreadRuntime: (threadId) => readRuntime(get(), threadId),

    isThreadBusy: (threadId) =>
      Boolean(
        readRuntime(get(), threadId)?.turnStartPending ||
        readRuntime(get(), threadId)?.activeTurnId,
      ),

    hasPendingApproval: (threadId) =>
      hasPendingApproval(readRuntime(get(), threadId)),

    setActiveThread: (threadId, cwd, title) => {
      get().ensureThreadState({ threadId, cwd, title, mode: 'live' });
      get().selectThread(threadId);
      set((state) => ({
        subscribedThreadIds: new Set(state.subscribedThreadIds).add(threadId),
      }));
      get().cleanupIdleThreadSubscriptions();
      const socket = getSocket();
      // Do not buffer room changes while disconnected. Reconnect joins the
      // final desired room; the opener can independently paint its HTTP page.
      if (!socket.connected) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        socket
          .timeout(10_000)
          .emit(
            'thread.subscribe',
            { threadId },
            (error: Error | null, reply?: { ok?: boolean }) =>
              resolve(!error && Boolean(reply?.ok)),
          );
      });
    },

    setReadOnlyThread: (thread) => {
      const title = thread.name ?? thread.preview ?? null;
      get().unsubscribeThread(thread.id);
      get().ensureThreadState({
        threadId: thread.id,
        cwd: thread.cwd,
        title,
        mode: 'readOnly',
      });
      // The failed writable open creates a live runtime before this degraded
      // path runs. `ensureThreadState` intentionally preserves existing state,
      // so the mode must be changed explicitly before selecting the snapshot.
      //
      // The timeline is deliberately untouched here. History now arrives as a
      // page through `hydrateOpenedThread`, which refuses to shrink a transcript
      // the user has already paged backwards through; seeding an empty timeline
      // first would discard those earlier pages and defeat that guard.
      applyThreadUpdate(thread.id, (runtime) => ({
        ...runtime,
        threadMode: 'readOnly',
      }));
      get().selectThread(thread.id);
    },

    clearThread: () => get().selectThread(null),
  };
}
