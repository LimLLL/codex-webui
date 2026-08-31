/**
 * Notification dispatcher for Codex app-server events.
 * Maps every ServerNotification method to a typed handler.
 * Unknown methods fall through to a dev-only debug log.
 */
import type { QueryClient } from '@tanstack/react-query';
import {
  accountReadAccountQueryKey,
  accountReadRateLimitsQueryKey,
  appsListAppsQueryKey,
  codexStatusGetStatusQueryKey,
  mcpServersListServersQueryKey,
  threadCommandsReadCollaborationModeQueryKey,
  threadCommandsReadGoalQueryKey,
  threadsListThreadsQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import type { RateLimitSnapshotDto } from '@/generated/api';
import {
  invalidateBranchTreesSoon,
  invalidateThreadListSoon,
} from '@/lib/query-invalidation';
import { useAccountStore } from '@/stores/account-store';
import { useMcpStore } from '@/stores/mcp-store';
import { useModelStore, type ReasoningEffort } from '@/stores/model-store';
import { showSnackbar } from '@/stores/snackbar-store';
import type { AuthMode, PlanType } from '@/types/account';
import type { ThreadTokenUsage, ThreadStatusType } from '@/types/codex-notifications';
import type { McpServerStartupState } from '@/types/mcp';
import type { TurnItem, TurnPlanState, TurnPlanStepStatus } from '@/types/timeline';
import type { ApprovalRequest } from '@/types/approval';
import {
  mergeTurnItem,
  normalizeThreadItem,
} from '@/lib/thread-item-normalizer';
import { normalizeLiveTurnFailure } from '@/lib/turn-failure';
import i18n from '@/i18n';

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
  updateTurnPlan: (
    turnId: string,
    plan: TurnPlanState,
  ) => void;
  appendPlanDelta: (turnId: string, itemId: string, delta: string) => void;
  setLoading: (loading: boolean) => void;
  expandReasoning: (itemId: string) => void;
  collapseReasoning: (itemId: string) => void;
  addApproval: (approval: ApprovalRequest) => void;
  addSystemMessage: (message: string, severity?: 'info' | 'warning' | 'error', turnId?: string) => void;
  addSystemError: (message: string) => void;
  upsertTurnFailure: (
    failure: ReturnType<typeof normalizeLiveTurnFailure>,
  ) => void;
  setTokenUsage: (turnId: string, usage: ThreadTokenUsage) => void;
  setThreadStatus: (status: ThreadStatusType | null) => void;
  setActiveTurnId: (turnId: string | null) => void;
  clearActiveTurn: () => void;
  setThreadTitle: (title: string | null) => void;
  resolveApprovalByRequestId: (requestId: string | number) => void;
}

type Params = Record<string, unknown>;
type Handler = (params: Params, ctx: NotificationContext) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Checks if the notification carries a thread scope matching the routed context. */
function hasThreadScope(params: Params, ctx: NotificationContext): boolean {
  const eventThreadId = params.threadId as string | undefined;
  return Boolean(eventThreadId && ctx.threadId === eventThreadId);
}

// ---------------------------------------------------------------------------
// Error deduplication — suppress repeated retry toasts within a short window
// ---------------------------------------------------------------------------

const recentErrors = new Map<string, number>();
const DEDUP_WINDOW_MS = 5_000;

function isDuplicateRetryError(key: string): boolean {
  const now = Date.now();
  const last = recentErrors.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  recentErrors.set(key, now);
  for (const [k, ts] of recentErrors) {
    if (now - ts > DEDUP_WINDOW_MS) recentErrors.delete(k);
  }
  return false;
}

let invalidateMcpTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedInvalidateMcpServers(queryClient: QueryClient): void {
  if (invalidateMcpTimer) clearTimeout(invalidateMcpTimer);
  invalidateMcpTimer = setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey: mcpServersListServersQueryKey() });
    invalidateMcpTimer = null;
  }, 500);
}

/** Matches generated TanStack Query keys whose first element has `{ _id: id }`. */
function queryHasId(query: { queryKey: readonly unknown[] }, id: string): boolean {
  const first = query.queryKey[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    '_id' in first &&
    (first as { _id?: unknown })._id === id
  );
}

function invalidateAccountQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: accountReadAccountQueryKey() });
  void queryClient.invalidateQueries({ queryKey: accountReadRateLimitsQueryKey() });
  void queryClient.invalidateQueries({ queryKey: codexStatusGetStatusQueryKey() });
}

function isPlanStepStatus(value: unknown): value is TurnPlanStepStatus {
  return value === 'pending' || value === 'inProgress' || value === 'completed';
}

// ---------------------------------------------------------------------------
// Tier 0 — Already handled (migrated from if-chain)
// ---------------------------------------------------------------------------

const handleReasoningSummaryTextDelta: Handler = (params, ctx) => {
  const { turnId, itemId, delta } = params as { turnId?: string; itemId?: string; delta?: string };
  if (!turnId || !itemId || !hasThreadScope(params, ctx)) return;
  ctx.updateTurnItem(turnId, itemId, (existing) => ({
    type: 'reasoning',
    itemId,
    content:
      (existing?.type === 'reasoning' ? existing.content : '') +
      (delta ?? ''),
    completed: false,
  }));
  ctx.expandReasoning(itemId);
};

const handleAgentMessageDelta: Handler = (params, ctx) => {
  const { turnId, itemId, delta } = params as { turnId?: string; itemId?: string; delta?: string };
  if (!turnId || !itemId || !hasThreadScope(params, ctx)) return;
  ctx.updateTurnItem(turnId, itemId, (existing) => ({
    type: 'agentMessage',
    itemId,
    content:
      (existing?.type === 'agentMessage' ? existing.content : '') +
      (delta ?? ''),
    completed: false,
  }));
};

const handleCommandExecutionOutputDelta: Handler = (params, ctx) => {
  const { turnId, itemId, delta } = params as { turnId?: string; itemId?: string; delta?: string };
  if (!turnId || !itemId || !hasThreadScope(params, ctx)) return;
  ctx.updateTurnItem(turnId, itemId, (existing) => ({
    ...(existing?.type === 'commandExecution'
      ? existing
      : { type: 'commandExecution' as const, itemId, content: '' }),
    content:
      (existing?.type === 'commandExecution' ? existing.content : '') +
      (delta ?? ''),
    completed: false,
  }));
};

const handleFileChangeOutputDelta: Handler = (params, ctx) => {
  const { turnId, itemId, delta } = params as { turnId?: string; itemId?: string; delta?: string };
  if (!turnId || !itemId || !hasThreadScope(params, ctx)) return;
  ctx.updateTurnItem(turnId, itemId, (existing) => ({
    ...(existing?.type === 'fileChange'
      ? existing
      : { type: 'fileChange' as const, itemId, content: '' }),
    content:
      (existing?.type === 'fileChange' ? existing.content : '') +
      (delta ?? ''),
    completed: false,
  }));
};

const handleTurnDiffUpdated: Handler = (params, ctx) => {
  const { turnId } = params as { turnId?: string };
  const diff = params.diff as string | undefined;
  if (!turnId || typeof diff !== 'string' || !hasThreadScope(params, ctx)) return;
  ctx.updateTurnDiff(turnId, diff);
};

const handleItemStarted: Handler = (params, ctx) => {
  const { turnId } = params as { turnId?: string };
  if (!turnId || !hasThreadScope(params, ctx)) return;
  const item = params.item as Record<string, unknown> | undefined;
  if (!item) return;
  const itemId =
    (params.itemId as string | undefined) ??
    (item.id as string | undefined) ??
    '';
  const normalized = normalizeThreadItem(item, false, itemId);
  if (normalized.kind === 'render' || normalized.kind === 'unknown') {
    ctx.updateTurnItem(turnId, normalized.item.itemId, () => normalized.item);
  }
};

const handleItemCompleted: Handler = (params, ctx) => {
  const { turnId } = params as { turnId?: string };
  if (!turnId || !hasThreadScope(params, ctx)) return;
  const item = params.item as Record<string, unknown> | undefined;
  if (!item) return;
  const completedItemId =
    (params.itemId as string | undefined) ??
    (item.id as string | undefined) ??
    '';
  const normalized = normalizeThreadItem(item, true, completedItemId);
  if (normalized.kind === 'render' || normalized.kind === 'unknown') {
    ctx.updateTurnItem(turnId, normalized.item.itemId, (existing) =>
      mergeTurnItem(existing, normalized.item),
    );
    if (normalized.item.type === 'reasoning') {
      ctx.collapseReasoning(normalized.item.itemId);
    }
  }
};

/** turn/completed payload is { threadId, turn: { id, status, error } }. */
const handleTurnCompleted: Handler = (params, ctx) => {
  const turn = params.turn as
    | { id?: string; status?: string; error?: Record<string, unknown> | null }
    | undefined;
  const turnId = turn?.id;
  if (!turnId) return;

  if (!hasThreadScope(params, ctx)) {
    // Still invalidate thread list for non-active threads
    void ctx.queryClient.invalidateQueries({ queryKey: threadsListThreadsQueryKey() });
    return;
  }

  ctx.updateCurrentTurn(turnId, (items) => ({ items, completed: true }));
  ctx.setLoading(false);
  ctx.clearActiveTurn();

  if (turn.status === 'failed' && turn.error) {
    ctx.upsertTurnFailure(normalizeLiveTurnFailure(turnId, turn.error));
  }

  void ctx.queryClient.invalidateQueries({ queryKey: threadsListThreadsQueryKey() });
};

/**
 * Collaboration mode has no side-effect-free read, so this notification is the
 * only way the backend learns a mode changed elsewhere — another tab, the CLI,
 * or the desktop app. Without invalidating here the plan badge would keep
 * showing whatever this tab last wrote.
 */
const handleThreadSettingsUpdated: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  if (!threadId) return;
  void ctx.queryClient.invalidateQueries({
    queryKey: threadCommandsReadCollaborationModeQueryKey({
      path: { threadId },
    }),
  });

  // Entering Plan mode makes app-server rewrite the thread's reasoning effort,
  // so the badge has to be told. This is recorded per thread and for display
  // only — writing it into `effortOverride` would make it ride along on the
  // next `turn/start` and force this effort onto a different thread.
  const settings = params.threadSettings as
    | { effort?: string | null }
    | undefined;
  if (!settings) return;
  useModelStore
    .getState()
    .setObservedThreadEffort(
      threadId,
      (settings.effort ?? null) as ReasoningEffort | null,
    );
};

/** Keeps the goal row live when a goal changes outside this tab. */
const handleThreadGoalChanged: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  if (!threadId) return;
  void ctx.queryClient.invalidateQueries({
    queryKey: threadCommandsReadGoalQueryKey({ path: { threadId } }),
  });
};

// ---------------------------------------------------------------------------
// Tier 1 — High value
// ---------------------------------------------------------------------------

const handleError: Handler = (params, ctx) => {
  const error = params.error as Record<string, unknown> | undefined;
  const willRetry = params.willRetry as boolean;
  const turnId = params.turnId as string | undefined;
  const threadId = params.threadId as string | undefined;
  const message =
    typeof error?.message === 'string' ? error.message : 'Unknown error';

  if (willRetry) {
    const dedupKey = `${threadId}:${turnId}:${message}`;
    if (ctx.threadId === threadId && !isDuplicateRetryError(dedupKey)) {
      showSnackbar(message, 'warning');
    }
  } else {
    if (ctx.threadId === threadId) {
      showSnackbar(message, 'error', 5000);
      if (turnId) {
        ctx.upsertTurnFailure(normalizeLiveTurnFailure(turnId, error));
        ctx.updateCurrentTurn(turnId, (items) => ({ items, completed: true }));
      }
      ctx.setLoading(false);
      ctx.clearActiveTurn();
    }
  }
};

const handleTokenUsageUpdated: Handler = (params, ctx) => {
  const turnId = params.turnId as string | undefined;
  const tokenUsage = params.tokenUsage as ThreadTokenUsage | undefined;
  if (!turnId || !tokenUsage || !hasThreadScope(params, ctx)) return;
  ctx.setTokenUsage(turnId, tokenUsage);
};

const handleServerRequestResolved: Handler = (params, ctx) => {
  const requestId = params.requestId as string | number | undefined;
  if (requestId == null || !hasThreadScope(params, ctx)) return;
  ctx.resolveApprovalByRequestId(requestId);
};

const handleConfigWarning: Handler = (params) => {
  const summary = params.summary as string;
  const details = params.details as string | null;
  showSnackbar(details ? `${summary}: ${details}` : summary, 'warning', 5000);
};

const handleDeprecationNotice: Handler = (params) => {
  const summary = params.summary as string;
  showSnackbar(summary, 'warning', 5000);
};

const handleTurnPlanUpdated: Handler = (params, ctx) => {
  const turnId = params.turnId as string | undefined;
  if (!turnId || !hasThreadScope(params, ctx)) return;
  const rawPlan = Array.isArray(params.plan) ? params.plan : [];
  const steps = rawPlan
    .map((step) => step as { step?: unknown; status?: unknown })
    .filter(
      (step): step is { step: string; status: TurnPlanStepStatus } =>
        typeof step.step === 'string' && isPlanStepStatus(step.status),
    )
    .map((step) => ({ step: step.step, status: step.status }));
  ctx.updateTurnPlan(turnId, {
    explanation: typeof params.explanation === 'string' ? params.explanation : null,
    steps,
  });
};

const handlePlanDelta: Handler = (params, ctx) => {
  const { turnId, itemId, delta } = params as {
    turnId?: string;
    itemId?: string;
    delta?: string;
  };
  if (!turnId || !itemId || !delta || !hasThreadScope(params, ctx)) return;
  ctx.appendPlanDelta(turnId, itemId, delta);
};

const handleMcpToolCallProgress: Handler = (params, ctx) => {
  const { turnId, itemId, message } = params as {
    turnId?: string;
    itemId?: string;
    message?: string;
  };
  if (!turnId || !itemId || !hasThreadScope(params, ctx)) return;
  ctx.updateTurnItem(turnId, itemId, (existing) => ({
    ...(existing?.type === 'mcpToolCall'
      ? existing
      : {
      type: 'mcpToolCall' as const,
      itemId,
      content: '',
      completed: false,
      toolServer: '',
      toolName: '',
      toolArgs: '',
        }),
    toolProgress: message ?? '',
  }));
};

const handleMcpStartupStatusUpdated: Handler = (params, ctx) => {
  const name = params.name as string | undefined;
  const status = params.status as string | undefined;
  if (!name || !isMcpStartupStatus(status)) return;
  useMcpStore.getState().setServerStatus({
    name,
    status,
    error: typeof params.error === 'string' ? params.error : null,
  });
  if (status === 'ready' || status === 'failed') {
    debouncedInvalidateMcpServers(ctx.queryClient);
  }
};

// ---------------------------------------------------------------------------
// Tier 2 — Thread/Turn lifecycle
// ---------------------------------------------------------------------------

const handleThreadStarted: Handler = (_params, ctx) => {
  invalidateThreadListSoon(ctx.queryClient);
};

const handleThreadStatusChanged: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  const status = params.status as ThreadStatusType | undefined;
  if (!status) return;

  if (ctx.threadId === threadId) {
    ctx.setThreadStatus(status);
    if (status.type === 'systemError') {
      ctx.addSystemMessage(i18n.t('Thread encountered a system error'), 'error');
    }
  }
  invalidateThreadListSoon(ctx.queryClient);
};

const handleThreadNameUpdated: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  const name = params.threadName as string | undefined;
  if (threadId && ctx.threadId === threadId) {
    ctx.setThreadTitle(name?.trim() || null);
  }
  invalidateThreadListSoon(ctx.queryClient);
};

const handleThreadClosed: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  if (ctx.threadId === threadId) {
    ctx.addSystemMessage(i18n.t('Thread closed'), 'info');
  }
  invalidateThreadListSoon(ctx.queryClient);
};

const handleThreadArchived: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  if (ctx.threadId === threadId) {
    ctx.addSystemMessage(i18n.t('Thread archived'), 'warning');
  }
  invalidateThreadListSoon(ctx.queryClient);
};

const handleThreadUnarchived: Handler = (_params, ctx) => {
  invalidateThreadListSoon(ctx.queryClient);
};

/**
 * Drops a thread the app-server destroyed, whoever asked for it.
 *
 * A delete started here has already navigated away by the time this arrives,
 * so the interesting case is the other one: another browser or the CLI removed
 * the conversation and this client would otherwise keep listing it until the
 * page is reloaded. Branch topology has to be refreshed alongside the list —
 * the sidebar decides whether a row is a fold-away branch from that data, and
 * refreshing only one of the two makes rows appear and disappear.
 */
const handleThreadDeleted: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  if (!threadId) return;

  // Compared against the *selected* thread, not the routed one. The dispatcher
  // sets `ctx.threadId` to this notification's own thread before calling us, so
  // testing it here was always true: the runtime of a conversation deleted from
  // another client was never dropped, and appending a system message to a
  // thread this client had never opened created a ghost runtime through the
  // store's create-if-absent helper.
  if (ctx.getSelectedThreadId() === threadId) {
    // The runtime is deliberately left in place: dropping it would blank the
    // conversation the user is reading with no explanation, and the router is
    // not reachable from here. But keeping it readable is not the same as
    // keeping it usable — the thread is gone, so it is marked unwritable in the
    // same step rather than left accepting messages that can only fail.
    ctx.markThreadDeletedRemotely(
      threadId,
      i18n.t('This conversation was deleted'),
    );
  } else {
    ctx.forgetThreads([threadId]);
  }

  invalidateThreadListSoon(ctx.queryClient);
  invalidateBranchTreesSoon(ctx.queryClient);
};

const handleTurnStarted: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  const turn = params.turn as { id?: string } | undefined;
  const turnId = turn?.id;
  if (!turnId || ctx.threadId !== threadId) return;
  ctx.updateCurrentTurn(turnId, () => ({ items: [], completed: false }));
  ctx.setLoading(true);
  ctx.setActiveTurnId(turnId);
};

const handleThreadCompacted: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  if (ctx.threadId === threadId) {
    ctx.addSystemMessage(i18n.t('Context compacted'), 'info');
  }
};

const handleModelRerouted: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  const fromModel = params.fromModel as string;
  const toModel = params.toModel as string;
  const message = i18n.t('Model rerouted: {{from}} → {{to}}', {
    from: fromModel,
    to: toModel,
  });
  if (ctx.threadId === threadId) {
    ctx.addSystemMessage(message, 'warning');
    showSnackbar(message, 'info');
  }
};

const handleAccountUpdated: Handler = (params, ctx) => {
  const authMode = params.authMode as AuthMode | null;
  const planType = params.planType as PlanType | null;
  useAccountStore.getState().setAccountUpdated({ authMode, planType });
  invalidateAccountQueries(ctx.queryClient);
};

const handleAccountLoginCompleted: Handler = (params, ctx) => {
  const payload = {
    loginId: typeof params.loginId === 'string' ? params.loginId : null,
    success: Boolean(params.success),
    error: typeof params.error === 'string' ? params.error : null,
  };
  useAccountStore.getState().setLoginCompleted(payload);
  invalidateAccountQueries(ctx.queryClient);
  if (payload.success) {
    showSnackbar(i18n.t('ChatGPT login completed'), 'success');
  } else if (payload.error) {
    showSnackbar(payload.error, 'error', 5000);
  }
};

const handleAccountRateLimitsUpdated: Handler = (params, ctx) => {
  const rateLimits = params.rateLimits as RateLimitSnapshotDto | undefined;
  if (!rateLimits) return;
  useAccountStore.getState().setRateLimitSnapshot(rateLimits);
  void ctx.queryClient.invalidateQueries({ queryKey: accountReadRateLimitsQueryKey() });
};

const handleSkillsChanged: Handler = (_params, ctx) => {
  void ctx.queryClient.invalidateQueries({
    predicate: (query) => queryHasId(query, 'skillsListSkills'),
  });
};

/** Invalidate apps query when app list changes (e.g. after plugin install). */
const handleAppListUpdated: Handler = (_params, ctx) => {
  void ctx.queryClient.invalidateQueries({ queryKey: appsListAppsQueryKey() });
};

/** Refresh MCP status and show toast after OAuth login completes. */
const handleMcpOauthLoginCompleted: Handler = (params, ctx) => {
  void ctx.queryClient.invalidateQueries({ queryKey: mcpServersListServersQueryKey() });
  const name = typeof params.name === 'string' ? params.name : 'MCP server';
  const success = params.success === true;
  if (success) {
    showSnackbar(i18n.t('{{name}} login completed', { name }), 'success');
  } else {
    const error = typeof params.error === 'string' ? params.error : '';
    showSnackbar(i18n.t('{{name}} login failed: {{error}}', { name, error }), 'error');
  }
};

function isMcpStartupStatus(value: unknown): value is McpServerStartupState {
  return value === 'starting' || value === 'ready' || value === 'failed' || value === 'cancelled';
}

// ---------------------------------------------------------------------------
// Tier 3 — Known low-priority methods (debug-only logging)
// ---------------------------------------------------------------------------

const TIER3_METHODS = new Set([
  'hook/started',
  'hook/completed',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'rawResponseItem/completed',
  'command/exec/outputDelta',
  'item/commandExecution/terminalInteraction',
  'fs/changed',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
  'thread/realtime/started',
  'thread/realtime/itemAdded',
  'thread/realtime/transcriptUpdated',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/error',
  'thread/realtime/closed',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
]);

// ---------------------------------------------------------------------------
// Master handler map
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, Handler> = {
  // Tier 0 — existing
  'item/reasoning/summaryTextDelta': handleReasoningSummaryTextDelta,
  'item/agentMessage/delta': handleAgentMessageDelta,
  'item/commandExecution/outputDelta': handleCommandExecutionOutputDelta,
  'item/fileChange/outputDelta': handleFileChangeOutputDelta,
  'turn/diff/updated': handleTurnDiffUpdated,
  'item/started': handleItemStarted,
  'item/completed': handleItemCompleted,
  'turn/completed': handleTurnCompleted,

  // Tier 1 — high value
  'error': handleError,
  'thread/tokenUsage/updated': handleTokenUsageUpdated,
  'serverRequest/resolved': handleServerRequestResolved,
  'configWarning': handleConfigWarning,
  'deprecationNotice': handleDeprecationNotice,
  'turn/plan/updated': handleTurnPlanUpdated,
  'item/plan/delta': handlePlanDelta,
  'item/mcpToolCall/progress': handleMcpToolCallProgress,
  'mcpServer/startupStatus/updated': handleMcpStartupStatusUpdated,
  'account/updated': handleAccountUpdated,
  'account/rateLimits/updated': handleAccountRateLimitsUpdated,
  'account/login/completed': handleAccountLoginCompleted,

  // Tier 2 — thread/turn lifecycle
  'thread/started': handleThreadStarted,
  'thread/status/changed': handleThreadStatusChanged,
  'thread/name/updated': handleThreadNameUpdated,
  'thread/closed': handleThreadClosed,
  'thread/archived': handleThreadArchived,
  'thread/unarchived': handleThreadUnarchived,
  'thread/deleted': handleThreadDeleted,
  'thread/settings/updated': handleThreadSettingsUpdated,
  'thread/goal/updated': handleThreadGoalChanged,
  'thread/goal/cleared': handleThreadGoalChanged,
  'turn/started': handleTurnStarted,
  'thread/compacted': handleThreadCompacted,
  'model/rerouted': handleModelRerouted,
  'skills/changed': handleSkillsChanged,
  'app/list/updated': handleAppListUpdated,
  'mcpServer/oauthLogin/completed': handleMcpOauthLoginCompleted,
};

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatches a Codex app-server notification to the appropriate handler.
 *
 * @param method - Notification method name (e.g. 'item/agentMessage/delta')
 * @param params - Notification params payload
 * @param ctx - Injected dependencies (store actions, queryClient)
 */
export function handleNotification(
  method: string,
  params: Record<string, unknown>,
  ctx: NotificationContext,
): void {
  const handler = HANDLERS[method];
  const eventThreadId = params.threadId as string | undefined;
  const previousThreadId = ctx.threadId;

  // Route thread-scoped notifications to their owning thread runtime.
  if (eventThreadId) ctx.threadId = eventThreadId;

  try {
    if (handler) {
      handler(params, ctx);
      return;
    }

    if (TIER3_METHODS.has(method)) {
      if (import.meta.env.DEV) {
        console.debug(`[codex] tier3 notification: ${method}`);
      }
      return;
    }

    if (import.meta.env.DEV) {
      console.debug(`[codex] unknown notification: ${method}`);
    }
  } finally {
    ctx.threadId = previousThreadId;
  }
}
