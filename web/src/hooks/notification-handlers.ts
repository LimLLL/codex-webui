/** App-server notification dispatch and global metadata updates. */
import type { QueryClient } from '@tanstack/react-query';
import {
  accountReadAccountQueryKey,
  accountReadRateLimitsQueryKey,
  appsListAppsQueryKey,
  codexStatusGetStatusQueryKey,
  mcpServersListServersQueryKey,
  threadCommandsReadCollaborationModeQueryKey,
  threadCommandsReadGoalQueryKey,
} from '@/generated/api/@tanstack/react-query.gen';
import type { RateLimitSnapshotDto } from '@/generated/api';
import {
  refreshThreadPolicy,
  settleIfObserved,
} from '@/stores/thread-policy-store';
import { queryHasId } from '@/lib/query-invalidation';
import { useAccountStore } from '@/stores/account-store';
import { useMcpStore } from '@/stores/mcp-store';
import { useModelStore, type ReasoningEffort } from '@/stores/model-store';
import { showSnackbar } from '@/stores/snackbar-store';
import type { AuthMode, PlanType } from '@/types/account';
import type {
  ThreadTokenUsage,
  ThreadStatusType,
} from '@/types/codex-notifications';
import type { McpServerStartupState } from '@/types/mcp';
import { nextObservationSeq } from '@/lib/turn-item-merge';
import { normalizeLiveTurnFailure } from '@/lib/turn-failure';
import i18n from '@/i18n';
import {
  type NotificationContext,
  type Handler,
  hasThreadScope,
} from './notification-context';
import {
  handleReasoningSummaryTextDelta,
  handleAgentMessageDelta,
  handleCommandExecutionOutputDelta,
  handleFileChangeOutputDelta,
  handleTurnDiffUpdated,
  handleItemStarted,
  handleItemCompleted,
  handleTurnCompleted,
  handleTurnPlanUpdated,
  handlePlanDelta,
  handleMcpToolCallProgress,
} from './notification-item-handlers';

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
    void queryClient.invalidateQueries({
      queryKey: mcpServersListServersQueryKey(),
    });
    invalidateMcpTimer = null;
  }, 500);
}

function invalidateAccountQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    queryKey: accountReadAccountQueryKey(),
  });
  void queryClient.invalidateQueries({
    queryKey: accountReadRateLimitsQueryKey(),
  });
  void queryClient.invalidateQueries({
    queryKey: codexStatusGetStatusQueryKey(),
  });
}

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
  // This notification is the only confirmation that a requested security policy
  // actually took effect — the patch endpoint returns a queued acknowledgement,
  // not proof. Reading here is what releases the composer's hold on Send.
  //
  // A direct read rather than a query invalidation, and the difference was
  // measured: with a read already in flight, invalidating produced no second
  // request at all and the pre-notification body became the cached answer. The
  // confirmation this notification carries would have been lost, and the
  // composer would have waited out its whole window for an event that had
  // already arrived. `refreshThreadPolicy` stamps its own ordering, so a read
  // issued before this notification can no longer overwrite the one after it.
  void refreshThreadPolicy(threadId).then(() => settleIfObserved(threadId));

  // Entering Plan mode makes app-server rewrite the thread's reasoning effort,
  // so the badge has to be told. This is recorded per thread and for display
  // only — writing it into `effortOverride` would make it ride along on the
  // next `turn/start` and force this effort onto a different thread.
  const settings = params.threadSettings as
    | { effort?: string | null }
    | undefined;
  if (!settings) return;
  // Tier-only changes emit no notification in the pinned CLI. Keep its local
  // lifecycle seed rather than treating unrelated notifications as tier evidence.
  useModelStore.getState().setObservedThreadSettings(
    threadId,
    {
      effort: (settings.effort ?? null) as ReasoningEffort | null,
    },
    nextObservationSeq(),
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
      const alreadyTerminal = Boolean(turnId && ctx.isTurnTerminal(turnId));
      if (turnId) {
        ctx.upsertTurnFailure(normalizeLiveTurnFailure(turnId, error));
        ctx.updateCurrentTurn(turnId, (items) => ({ items, completed: true }));
      }
      // The two facts are released on different evidence. Clearing the active
      // pointer needs this exact turn named, or a stale unnamed failure would
      // declare a running turn finished. An outstanding submission has no turn
      // yet by definition, so a fatal error on this thread is all the evidence
      // it can ever get — leaving it pending disables the composer for good.
      if (!alreadyTerminal || ctx.getActiveTurnId() === turnId) ctx.setTurnStartPending(false);
      if (turnId && ctx.getActiveTurnId() === turnId) ctx.clearActiveTurn();
    }
  }
};

const handleTokenUsageUpdated: Handler = (params, ctx) => {
  const turnId = params.turnId as string | undefined;
  const tokenUsage = params.tokenUsage as ThreadTokenUsage | undefined;
  if (!turnId || !tokenUsage || !hasThreadScope(params, ctx)) return;
  ctx.setTokenUsage(turnId, tokenUsage);
};

/** Raw request IDs lack restart-safe identity; the backend projects the retirement separately. */
const handleServerRequestResolved: Handler = () => undefined;

const handleConfigWarning: Handler = (params) => {
  const summary = params.summary as string;
  const details = params.details as string | null;
  showSnackbar(details ? `${summary}: ${details}` : summary, 'warning', 5000);
};

/** Displays upstream warnings, including omitted unsupported service tiers, without changing turn state. */
const handleWarning: Handler = (params, ctx) => {
  if (typeof params.message !== 'string') return;
  if (hasThreadScope(params, ctx))
    ctx.addSystemMessage(params.message, 'warning');
  else showSnackbar(params.message, 'warning', 5000);
};

const handleDeprecationNotice: Handler = (params) => {
  const summary = params.summary as string;
  showSnackbar(summary, 'warning', 5000);
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

const handleThreadStarted: Handler = () => {};

// Overview has its own global hint.

const handleThreadStatusChanged: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  const status = params.status as ThreadStatusType | undefined;
  if (!status) return;

  if (ctx.threadId === threadId) {
    ctx.setThreadStatus(status);
    if (status.type === 'systemError') {
      ctx.addSystemMessage(
        i18n.t('Thread encountered a system error'),
        'error',
      );
    }
  }
};

const handleThreadNameUpdated: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  const name = params.threadName as string | undefined;
  if (threadId && ctx.threadId === threadId) {
    ctx.setThreadTitle(name?.trim() || null);
  }
};

const handleThreadClosed: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  if (ctx.threadId === threadId) {
    ctx.addSystemMessage(i18n.t('Thread closed'), 'info');
  }
};

const handleThreadArchived: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  if (ctx.threadId === threadId) {
    ctx.addSystemMessage(i18n.t('Thread archived'), 'warning');
  }
};

const handleThreadUnarchived: Handler = () => {};

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
};

const handleTurnStarted: Handler = (params, ctx) => {
  const threadId = params.threadId as string | undefined;
  const turn = params.turn as { id?: string } | undefined;
  const turnId = turn?.id;
  if (!turnId || ctx.threadId !== threadId) return;
  // Preserve whatever this turn already holds. A repeated or late `turn/started`
  // is not evidence the turn is empty: recovery may have already installed its
  // persisted items, and clearing them here would re-create the very gap
  // recovery exists to close. Reopening a finished turn is refused for the same
  // reason — turn lifecycle moves forward only.
  ctx.updateCurrentTurn(turnId, (items, completed) => ({
    items,
    completed,
  }));
  // Guarding the entry alone was not enough: a replayed `turn/started` for a
  // turn already known to have finished left the entry correct and still put
  // the composer back into a running state it could never leave, because the
  // matching `turn/completed` had already been consumed.
  if (ctx.isTurnTerminal(turnId)) return;
  ctx.setTurnStartPending(false);
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
  void ctx.queryClient.invalidateQueries({
    queryKey: accountReadRateLimitsQueryKey(),
  });
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
  void ctx.queryClient.invalidateQueries({
    queryKey: mcpServersListServersQueryKey(),
  });
  const name = typeof params.name === 'string' ? params.name : 'MCP server';
  const success = params.success === true;
  if (success) {
    showSnackbar(i18n.t('{{name}} login completed', { name }), 'success');
  } else {
    const error = typeof params.error === 'string' ? params.error : '';
    showSnackbar(
      i18n.t('{{name}} login failed: {{error}}', { name, error }),
      'error',
    );
  }
};

function isMcpStartupStatus(value: unknown): value is McpServerStartupState {
  return (
    value === 'starting' ||
    value === 'ready' ||
    value === 'failed' ||
    value === 'cancelled'
  );
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
  error: handleError,
  'thread/tokenUsage/updated': handleTokenUsageUpdated,
  'serverRequest/resolved': handleServerRequestResolved,
  configWarning: handleConfigWarning,
  warning: handleWarning,
  deprecationNotice: handleDeprecationNotice,
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

export type { NotificationContext } from './notification-context';
