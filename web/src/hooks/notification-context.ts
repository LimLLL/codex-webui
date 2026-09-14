/** Thread-scoped notification dependencies. */
import type { QueryClient } from '@tanstack/react-query';
import type {
  ThreadTokenUsage,
  ThreadStatusType,
} from '@/types/codex-notifications';
import type { TurnItem, TurnPlanState } from '@/types/timeline';
import type { ApprovalRequest } from '@/types/approval';
import { normalizeLiveTurnFailure } from '@/lib/turn-failure';

// ---------------------------------------------------------------------------
// Context injected by the hook — all store actions + queryClient
// ---------------------------------------------------------------------------

export interface NotificationContext {
  /**
   * Thread the notification being handled belongs to.
   *
   * Reassigned per notification by the dispatcher so thread-scoped handlers
   * write to the right runtime. It is therefore **not** "the thread on screen"
   * — for any notification that carries a threadId the two are equal by
   * construction, which silently turns `ctx.threadId === params.threadId` into
   * a tautology. Use {@link getSelectedThreadId} for that question.
   */
  threadId: string | null;
  /** The thread actually being viewed, independent of notification routing. */
  getSelectedThreadId: () => string | null;
  queryClient: QueryClient;
  /** Removes all local runtime state for threads that no longer exist. */
  forgetThreads: (threadIds: string[]) => void;
  /** Keeps a destroyed conversation readable while making it unwritable. */
  markThreadDeletedRemotely: (threadId: string, message: string) => void;
  updateCurrentTurn: (
    turnId: string,
    updater: (
      items: TurnItem[],
      completed: boolean,
    ) => { items: TurnItem[]; completed: boolean },
  ) => void;
  updateTurnItem: (
    turnId: string,
    itemId: string,
    updater: (existing: TurnItem | undefined) => TurnItem,
  ) => void;
  updateTurnDiff: (turnId: string, diff: string) => void;
  updateTurnPlan: (turnId: string, plan: TurnPlanState) => void;
  appendPlanDelta: (turnId: string, itemId: string, delta: string) => void;
  /** Replaces one plan item's text with its authoritative accumulated value. */
  setPlanText: (turnId: string, itemId: string, text: string) => void;
  setTurnStartPending: (loading: boolean) => void;
  expandReasoning: (itemId: string) => void;
  collapseReasoning: (itemId: string) => void;
  addApproval: (approval: ApprovalRequest) => void;
  addSystemMessage: (
    message: string,
    severity?: 'info' | 'warning' | 'error',
    turnId?: string,
  ) => void;
  addSystemError: (message: string) => void;
  upsertTurnFailure: (
    failure: ReturnType<typeof normalizeLiveTurnFailure>,
  ) => void;
  setTokenUsage: (turnId: string, usage: ThreadTokenUsage) => void;
  setThreadStatus: (status: ThreadStatusType | null) => void;
  setActiveTurnId: (turnId: string | null) => void;
  clearActiveTurn: () => void;
  /** The turn this thread currently considers running, if any. */
  getActiveTurnId: () => string | null;
  /** Whether a turn is already known to have finished. */
  isTurnTerminal: (turnId: string) => boolean;
  setThreadTitle: (title: string | null) => void;
  resolveApprovalByRequestId: (requestId: string | number) => void;
}

export type Params = Record<string, unknown>;

export type Handler = (params: Params, ctx: NotificationContext) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Checks if the notification carries a thread scope matching the routed context. */
export function hasThreadScope(
  params: Params,
  ctx: NotificationContext,
): boolean {
  const eventThreadId = params.threadId as string | undefined;
  return Boolean(eventThreadId && ctx.threadId === eventThreadId);
}
