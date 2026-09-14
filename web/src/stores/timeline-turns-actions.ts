/** Conversation timeline turns actions. */
import { type TurnPlanState } from '../types/timeline';
import { nextObservationSeq } from '../lib/turn-item-merge';
import {
  type TimelineState,
  type TimelineActionContext,
} from './timeline-state';
import { upsertRuntimeTurnFailure } from './timeline-failures';
import {
  ensureTurnEntry,
  bindPendingUserMessage,
  updateRuntimeCurrentTurn,
  updateRuntimeTurnItem,
  applyPersistedItems,
  setRuntimePlanText,
  updateRuntimeDiff,
  updateRuntimePlan,
} from './timeline-items';

/** Concrete turns mutations keep each conversation's ownership and lifecycle explicit. */
export function createTimelineTurnsActions({
  get,
  applyThreadUpdate,
}: TimelineActionContext): Pick<
  TimelineState,
  | 'updateCurrentTurnForThread'
  | 'updateTurnItemForThread'
  | 'applyFullTurnItemsForThread'
  | 'applyRecoveredTurnItemsForThread'
  | 'updateTurnDiffForThread'
  | 'updateTurnPlanForThread'
  | 'appendPlanDeltaForThread'
  | 'setPlanTextForThread'
  | 'setOpenStateForThread'
  | 'setTurnStartPendingForThread'
  | 'setTokenUsageForThread'
  | 'setThreadStatusForThread'
  | 'setActiveTurnIdForThread'
  | 'clearActiveTurnForThread'
  | 'settleTurnLifecycleForThread'
  | 'addSystemMessageForThread'
  | 'addSystemErrorForThread'
  | 'upsertTurnFailureForThread'
  | 'setThreadTitleForThread'
> {
  return {
    updateCurrentTurnForThread: (threadId, turnId, updater) => {
      applyThreadUpdate(threadId, (runtime) =>
        updateRuntimeCurrentTurn(runtime, turnId, updater),
      );
    },

    updateTurnItemForThread: (threadId, turnId, itemId, updater) => {
      applyThreadUpdate(threadId, (runtime) =>
        updateRuntimeTurnItem(runtime, turnId, itemId, (existing) => {
          const next = updater(existing);
          // Stamp only a write that actually changed something. A guarded delta
          // returns `existing` untouched, and re-stamping that would make a
          // stale event look to a recovery merge like fresh evidence that
          // outranks the snapshot.
          return next === existing
            ? next
            : { ...next, observedSeq: nextObservationSeq() };
        }),
      );
    },

    applyFullTurnItemsForThread: (threadId, turnId, items) => {
      applyThreadUpdate(threadId, (runtime) =>
        applyPersistedItems(runtime, turnId, items, {
          // This snapshot was fetched at an unknown moment, so it cannot claim
          // to be newer than a terminal observation already on screen. It still
          // repairs fragments, which is the point of topping a turn up.
          baselineSeq: -1,
          // Full detail does not imply final membership: late activities append.
          markFull: true,
        }),
      );
    },

    applyRecoveredTurnItemsForThread: (
      threadId,
      turnId,
      items,
      baselineSeq,
    ) => {
      applyThreadUpdate(threadId, (runtime) =>
        applyPersistedItems(runtime, turnId, items, {
          baselineSeq,
          // Recovery can be bounded or partial. Only a complete item query may
          // upgrade detail to full, independently of future freshness.
          markFull: false,
        }),
      );
    },

    updateTurnDiffForThread: (threadId, turnId, diff) => {
      applyThreadUpdate(threadId, (runtime) =>
        updateRuntimeDiff(runtime, turnId, diff),
      );
    },

    updateTurnPlanForThread: (threadId, turnId, plan) => {
      applyThreadUpdate(threadId, (runtime) =>
        updateRuntimePlan(runtime, turnId, plan),
      );
    },

    appendPlanDeltaForThread: (threadId, turnId, itemId, delta) => {
      if (!delta) return;
      applyThreadUpdate(threadId, (runtime) => {
        const patchPlan = (plan?: TurnPlanState): TurnPlanState => {
          const held = plan?.planTextByItemId?.[itemId];
          return {
            explanation: plan?.explanation ?? null,
            steps: plan?.steps ?? [],
            planTextByItemId: {
              ...(plan?.planTextByItemId ?? {}),
              [itemId]: {
                text: `${held?.text ?? ''}${delta}`,
                completed: false,
                observedSeq: nextObservationSeq(),
              },
            },
          };
        };
        const idx = runtime.timeline.findIndex(
          (entry) => entry.kind === 'turn' && entry.turnId === turnId,
        );
        if (idx >= 0) {
          const entry = runtime.timeline[idx];
          if (entry.kind !== 'turn') return runtime;
          // A delta that arrives after the terminal payload is stale by
          // construction: that payload already carries the whole accumulated
          // text, so appending would duplicate its tail and reopen a finished
          // plan item. This is `acceptsStreamedUpdate` applied to plan text.
          if (entry.plan?.planTextByItemId?.[itemId]?.completed) return runtime;
          const timeline = [...runtime.timeline];
          timeline[idx] = { ...entry, plan: patchPlan(entry.plan) };
          return { ...runtime, timeline };
        }
        return {
          ...runtime,
          timeline: [
            ...runtime.timeline,
            {
              kind: 'turn' as const,
              turnId,
              items: [],
              completed: false,
              plan: patchPlan(),
            },
          ],
        };
      });
    },

    setPlanTextForThread: (threadId, turnId, itemId, text) => {
      applyThreadUpdate(threadId, (runtime) =>
        setRuntimePlanText(runtime, turnId, itemId, text),
      );
    },

    setOpenStateForThread: (threadId, state) => {
      if (!get().getThreadRuntime(threadId)) return;
      applyThreadUpdate(threadId, (runtime) => ({ ...runtime, ...state }));
    },

    setTurnStartPendingForThread: (threadId, turnStartPending) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        turnStartPending,
      }));
    },

    setTokenUsageForThread: (threadId, turnId, usage) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        tokenUsageByTurn: { ...runtime.tokenUsageByTurn, [turnId]: usage },
        latestTokenUsage: usage,
      }));
    },

    setThreadStatusForThread: (threadId, status) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        threadStatus: status,
      }));
    },

    setActiveTurnIdForThread: (threadId, turnId) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        activeTurnId: turnId,
        turnStartPending: turnId ? false : runtime.turnStartPending,
        timeline: turnId
          ? bindPendingUserMessage(runtime.timeline, turnId)
          : runtime.timeline,
      }));
    },

    clearActiveTurnForThread: (threadId) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        activeTurnId: null,
        turnStartPending: false,
      }));
    },

    settleTurnLifecycleForThread: (threadId, turns) => {
      applyThreadUpdate(threadId, (runtime) => {
        const statusById = new Map(turns.map((turn) => [turn.id, turn.status]));
        const timeline = runtime.timeline.map((entry) => {
          if (entry.kind !== 'turn') return entry;
          const status = statusById.get(entry.turnId);
          // A turn the headers do not mention is not evidence of anything: the
          // read is bounded, so an older turn is simply out of range.
          if (status === undefined || status === 'inProgress') return entry;
          // Forward-only, like every other lifecycle write. Marking an already
          // completed turn completed is a no-op worth skipping so the entry
          // keeps its identity and the transcript does not re-render.
          return entry.completed ? entry : { ...entry, completed: true };
        });

        // The active pointer is only cleared on evidence about that exact turn.
        // The headers name the turns that exist; one this read did not return
        // says nothing, and clearing on that would resurrect the stuck-spinner
        // bug in the opposite direction — a turn that started during the gap
        // and is genuinely running would be declared finished.
        const activeStatus = runtime.activeTurnId
          ? statusById.get(runtime.activeTurnId)
          : undefined;
        const activeEnded =
          activeStatus !== undefined && activeStatus !== 'inProgress';
        // A turn reported running that this client does not know about started
        // during the gap. Adopting it restores the composer's running state.
        const terminalTurnIds = new Set(
          timeline.flatMap((entry) =>
            entry.kind === 'turn' && entry.completed ? [entry.turnId] : [],
          ),
        );
        const running = turns.find(
          (turn) =>
            turn.status === 'inProgress' && !terminalTurnIds.has(turn.id),
        );
        const activeTurnId = activeEnded
          ? (running?.id ?? null)
          : (runtime.activeTurnId ?? running?.id ?? null);

        return {
          ...runtime,
          timeline: activeTurnId
            ? ensureTurnEntry(timeline, activeTurnId)
            : timeline,
          activeTurnId,
          turnStartPending:
            activeTurnId !== null ? false : runtime.turnStartPending,
        };
      });
    },

    addSystemMessageForThread: (
      threadId,
      message,
      severity = 'info',
      turnId?,
      requestInstanceId?,
    ) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: [
          ...runtime.timeline,
          {
            kind: 'system' as const,
            content: message,
            severity,
            turnId,
            ...(requestInstanceId && { requestInstanceId }),
          },
        ],
      }));
    },

    addSystemErrorForThread: (threadId, message) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        timeline: [
          ...runtime.timeline,
          {
            kind: 'system' as const,
            content: `Error: ${message}`,
            severity: 'error' as const,
          },
        ],
      }));
    },

    upsertTurnFailureForThread: (threadId, failure) => {
      applyThreadUpdate(threadId, (runtime) =>
        upsertRuntimeTurnFailure(runtime, failure),
      );
    },

    setThreadTitleForThread: (threadId, title) => {
      applyThreadUpdate(threadId, (runtime) => ({
        ...runtime,
        threadTitle: title,
      }));
    },
  };
}
