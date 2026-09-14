/** Conversation timeline history actions. */
import { useWorkspaceStore } from './workspace-store';
import { forgetTranscriptBookmarks } from '@/lib/transcript-anchor';
import { normalizePersistedTurnFailure } from '../lib/turn-failure';
import { reconcileTimeline, sharesHistory } from '../lib/timeline-reconcile';
import { excludePendingReads } from '../lib/pending-read-coverage';
import {
  type TimelineState,
  type TimelineActionContext,
} from './timeline-state';
import {
  turnsToTimeline,
  collectKnownTurnIds,
} from './timeline-history-entries';
import {
  absorbStrandedFailures,
  upsertRuntimeTurnFailure,
} from './timeline-failures';
import { ensureRequestTurnEntries } from './timeline-items';

/** Concrete history mutations keep each conversation's ownership and lifecycle explicit. */
export function createTimelineHistoryActions({
  applyThreadUpdate,
}: TimelineActionContext): Pick<
  TimelineState,
  | 'hydrateTimelineForThread'
  | 'hydrateOpenedThread'
  | 'prependHistoryForThread'
  | 'setHistoryLoadingForThread'
  | 'markThreadDeletedRemotely'
  | 'hydrateTokenUsageForThread'
  | 'hydrateTurnDiffsForThread'
  | 'hydrateTurnErrorsForThread'
> {
  return {
    hydrateTimelineForThread: (threadId, turns, cwd) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        threadCwd: cwd ?? runtime.threadCwd,
        turnStartPending: false,
        timeline: ensureRequestTurnEntries(
          turnsToTimeline(turns),
          runtime.approvals,
          runtime.userInputRequests,
        ),
        activeTurnId: null,
        hydrated: true,
        historyRequest: 'idle',
        historyError: null,
      }));
    },

    /**
     * Seeds a thread from a metadata-first open.
     *
     * The server returns the most recent page of turns newest-first, because
     * that is the end the user is looking at; the timeline renders oldest-first,
     * so the page is reversed here rather than at every read site.
     */
    hydrateOpenedThread: ({
      threadId,
      turnsNewestFirst,
      historyCursor,
      readOnlyReason,
      cwd,
      knownTurnIdsAtRead,
    }) => {
      const turns = [...turnsNewestFirst].reverse();
      applyThreadUpdate(threadId, (runtime) => {
        // Reopening must not undo paging. An open returns only the most recent
        // page, so replacing the timeline with it would discard every earlier
        // page the user had loaded — leave the conversation and come back and
        // the history silently shrinks again.
        //
        // The page is kept only when it introduces nothing this client does not
        // already hold.
        const knownTurnIds = collectKnownTurnIds(runtime.timeline);
        const pageIsSubsumed =
          runtime.hydrated &&
          turns.length > 0 &&
          turns.every((turn) => knownTurnIds.has(turn.id));

        const pageEntries = ensureRequestTurnEntries(
          turnsToTimeline(turns),
          runtime.approvals,
          runtime.userInputRequests,
        );
        // A thread not yet hydrated can still hold entries: subscription and
        // this request run concurrently, so notifications for a turn that is
        // running right now may already have been written. Replacing wholesale
        // here is what erased them on a refresh mid-turn.
        //
        // Once hydrated, the two are reconciled only when they overlap. Without
        // a shared turn they are disconnected windows of a thread that moved on
        // elsewhere, and interleaving them would keep every entry while hiding
        // the gap between them — so the server's view still wins outright, as
        // it did before, and its cursor is adopted so the gap stays pageable.
        const baselineTimeline = knownTurnIdsAtRead
          ? runtime.timeline.filter(
              (entry) =>
                entry.kind !== 'system' &&
                entry.turnId &&
                knownTurnIdsAtRead.has(entry.turnId),
            )
          : runtime.timeline;
        const reconcilable =
          turns.length === 0 ||
          (knownTurnIdsAtRead
            ? knownTurnIdsAtRead.size === 0
            : !runtime.hydrated) ||
          sharesHistory(turnsToTimeline(turns), baselineTimeline);
        // Keep live observations made after the read even if the old cached
        // window no longer overlaps. Approval-only rows are not history anchors.
        const newer = knownTurnIdsAtRead
          ? runtime.timeline.filter(
              (entry) =>
                entry.kind !== 'system' &&
                (!entry.turnId || !knownTurnIdsAtRead.has(entry.turnId)),
            )
          : [];

        return {
          ...runtime,
          threadCwd: cwd ?? runtime.threadCwd,
          // Known turn ids do not imply known contents or lifecycle. Keep the
          // paging cursor below, but still reconcile a repeat open's evidence.
          timeline: reconcilable
            ? reconcileTimeline(pageEntries, runtime.timeline)
            : reconcileTimeline(pageEntries, newer),
          // Left to the caller, which can compare the page against what is
          // already known. Clearing it here dropped a `turn/started` that
          // arrived while this request was in flight.
          hydrated: true,
          // Keeping the existing cursor matters as much as keeping the entries:
          // the cursor from a fresh open points just before the newest page, so
          // adopting it would offer to re-fetch history already on screen.
          historyCursor:
            pageIsSubsumed || (reconcilable && runtime.hydrated)
              ? runtime.historyCursor
              : historyCursor,
          historyLoading: false,
          readOnlyReason,
        };
      });
    },

    /**
     * Adds an older page of history above what is already rendered.
     *
     * Guards against double-application: a turn already present is skipped
     * rather than duplicated, because the cursor page is inclusive of its
     * anchor row and a retry can overlap what the previous page delivered.
     */
    prependHistoryForThread: (threadId, turnsNewestFirst, nextCursor) => {
      applyThreadUpdate(threadId, (runtime) => {
        const knownTurnIds = collectKnownTurnIds(runtime.timeline);
        const older = [...turnsNewestFirst]
          .reverse()
          .filter((turn) => !knownTurnIds.has(turn.id));
        // Failures hydrated before their turn was paged in are parked at the
        // end; this page may be the one that owns them.
        const { prepended, existing } = absorbStrandedFailures(
          turnsToTimeline(older),
          older.map((turn) => turn.id),
          runtime.timeline,
        );
        return {
          ...runtime,
          timeline: [...prepended, ...existing],
          historyCursor: nextCursor,
          historyLoading: false,
        };
      });
    },

    setHistoryLoadingForThread: (threadId, historyLoading) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        historyLoading,
      }));
    },

    /**
     * Marks a conversation destroyed elsewhere while keeping its transcript.
     *
     * Keeping what the user is reading is deliberate, but it must stop being
     * interactive in the same step: a preserved transcript that still accepts
     * messages is a conversation that fails on every send. Any in-flight turn
     * state is cleared too — it can no longer complete, and leaving it would
     * show a spinner that never resolves.
     */
    markThreadDeletedRemotely: (threadId, message) => {
      useWorkspaceStore.getState().forgetConversations([threadId]);
      forgetTranscriptBookmarks([threadId]);
      excludePendingReads([threadId]);
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        deletedRemotely: true,
        turnStartPending: false,
        activeTurnId: null,
        historyCursor: null,
        historyLoading: false,
        timeline: [
          ...runtime.timeline,
          { kind: 'system', content: message, severity: 'error' },
        ],
      }));
    },

    // The backend keeps receiving while this browser is away. Its recording
    // can advance values already cached here; only observations made after the
    // read began outrank that recording. Unbaselined callers remain fill-only.
    hydrateTokenUsageForThread: (threadId, turns, baseline) => {
      applyThreadUpdate(threadId, (runtime) => {
        const tokenUsageByTurn = { ...runtime.tokenUsageByTurn };
        let filled = false;
        for (const turn of turns) {
          if (
            turn.turnId in tokenUsageByTurn &&
            (!baseline ||
              tokenUsageByTurn[turn.turnId] !==
                baseline.tokenUsageByTurn[turn.turnId])
          )
            continue;
          tokenUsageByTurn[turn.turnId] = turn.usage;
          filled = true;
        }
        return {
          ...runtime,
          tokenUsageByTurn,
          // The newest turn's usage drives the context gauge. A live value is
          // already the newest by construction, so the recording only supplies
          // one when there is nothing to supersede.
          latestTokenUsage:
            baseline && runtime.latestTokenUsage === baseline.latestTokenUsage
              ? (turns.at(-1)?.usage ?? runtime.latestTokenUsage)
              : (runtime.latestTokenUsage ??
                (filled ? (turns.at(-1)?.usage ?? null) : null)),
        };
      });
    },

    hydrateTurnDiffsForThread: (threadId, turns, baseline) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: runtime.timeline.map((entry) => {
          if (entry.kind !== 'turn') return entry;
          const previous = baseline?.timeline.find(
            (row) => row.kind === 'turn' && row.turnId === entry.turnId,
          );
          if (
            entry.diff !== undefined &&
            (!baseline ||
              previous?.kind !== 'turn' ||
              previous.diff !== entry.diff)
          )
            return entry;
          const match = turns.find((turn) => turn.turnId === entry.turnId);
          return match ? { ...entry, diff: match.diff } : entry;
        }),
      }));
    },

    hydrateTurnErrorsForThread: (threadId, errors) => {
      if (errors.length === 0) return;
      applyThreadUpdate(threadId, (runtime) => {
        let next = runtime;
        for (const error of errors) {
          next = upsertRuntimeTurnFailure(
            next,
            normalizePersistedTurnFailure(error),
          );
        }
        return next;
      });
    },
  };
}
