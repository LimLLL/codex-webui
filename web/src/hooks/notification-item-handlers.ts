/** Turn and item events preserve execution identity independently of submission state. */
import type { TurnPlanStepStatus } from '@/types/timeline';
import {
  mergeTurnItem,
  normalizeThreadItem,
} from '@/lib/thread-item-normalizer';
import { acceptsStreamedUpdate } from '@/lib/turn-item-merge';
import { normalizeLiveTurnFailure } from '@/lib/turn-failure';
import { type Handler, hasThreadScope } from './notification-context';

export function isPlanStepStatus(value: unknown): value is TurnPlanStepStatus {
  return value === 'pending' || value === 'inProgress' || value === 'completed';
}

// ---------------------------------------------------------------------------
// Tier 0 — Already handled (migrated from if-chain)
// ---------------------------------------------------------------------------

export const handleReasoningSummaryTextDelta: Handler = (params, ctx) => {
  const { turnId, itemId, delta } = params as {
    turnId?: string;
    itemId?: string;
    delta?: string;
  };
  if (!turnId || !itemId || !hasThreadScope(params, ctx)) return;
  ctx.updateTurnItem(turnId, itemId, (existing) => {
    if (existing && !acceptsStreamedUpdate(existing)) return existing;
    return {
      type: 'reasoning',
      itemId,
      content:
        (existing?.type === 'reasoning' ? existing.content : '') +
        (delta ?? ''),
      completed: false,
    };
  });
  ctx.expandReasoning(itemId);
};

export const handleAgentMessageDelta: Handler = (params, ctx) => {
  const { turnId, itemId, delta } = params as {
    turnId?: string;
    itemId?: string;
    delta?: string;
  };
  if (!turnId || !itemId || !hasThreadScope(params, ctx)) return;
  ctx.updateTurnItem(turnId, itemId, (existing) => {
    if (existing && !acceptsStreamedUpdate(existing)) return existing;
    return {
      type: 'agentMessage',
      itemId,
      content:
        (existing?.type === 'agentMessage' ? existing.content : '') +
        (delta ?? ''),
      questions: existing?.type === 'agentMessage' ? existing.questions : [],
      completed: false,
    };
  });
};

export const handleCommandExecutionOutputDelta: Handler = (params, ctx) => {
  const { turnId, itemId, delta } = params as {
    turnId?: string;
    itemId?: string;
    delta?: string;
  };
  if (!turnId || !itemId || !hasThreadScope(params, ctx)) return;
  ctx.updateTurnItem(turnId, itemId, (existing) => {
    if (existing && !acceptsStreamedUpdate(existing)) return existing;
    return {
      ...(existing?.type === 'commandExecution'
        ? existing
        : { type: 'commandExecution' as const, itemId, content: '' }),
      content:
        (existing?.type === 'commandExecution' ? existing.content : '') +
        (delta ?? ''),
      completed: false,
    };
  });
};

export const handleFileChangeOutputDelta: Handler = (params, ctx) => {
  const { turnId, itemId, delta } = params as {
    turnId?: string;
    itemId?: string;
    delta?: string;
  };
  if (!turnId || !itemId || !hasThreadScope(params, ctx)) return;
  ctx.updateTurnItem(turnId, itemId, (existing) => {
    if (existing && !acceptsStreamedUpdate(existing)) return existing;
    return {
      ...(existing?.type === 'fileChange'
        ? existing
        : { type: 'fileChange' as const, itemId, content: '' }),
      content:
        (existing?.type === 'fileChange' ? existing.content : '') +
        (delta ?? ''),
      completed: false,
    };
  });
};

export const handleTurnDiffUpdated: Handler = (params, ctx) => {
  const { turnId } = params as { turnId?: string };
  const diff = params.diff as string | undefined;
  if (!turnId || typeof diff !== 'string' || !hasThreadScope(params, ctx))
    return;
  ctx.updateTurnDiff(turnId, diff);
};

export const handleItemStarted: Handler = (params, ctx) => {
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
    // `item/started` carries an empty shell. Recovery can install the terminal
    // payload for an item before its own start notification is processed — on
    // reconnect the snapshot legitimately runs ahead of the replayed stream —
    // and letting the shell win there would blank out a finished item.
    ctx.updateTurnItem(turnId, normalized.item.itemId, (existing) =>
      existing && !acceptsStreamedUpdate(existing) ? existing : normalized.item,
    );
  }
};

export const handleItemCompleted: Handler = (params, ctx) => {
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
    return;
  }
  // Plan items were previously dropped here, so plan text only ever grew by
  // delta and a fragment lost to a disconnect stayed lost. Like every other
  // terminal payload this one carries the whole accumulated text, so it
  // replaces rather than appends.
  if (normalized.kind === 'plan') {
    ctx.setPlanText(turnId, normalized.itemId, normalized.text);
  }
};

/** turn/completed payload is { threadId, turn: { id, status, error } }. */
export const handleTurnCompleted: Handler = (params, ctx) => {
  const turn = params.turn as
    | { id?: string; status?: string; error?: Record<string, unknown> | null }
    | undefined;
  const turnId = turn?.id;
  if (!turnId) return;

  if (!hasThreadScope(params, ctx)) {
    return;
  }

  const alreadyTerminal = ctx.isTurnTerminal(turnId);
  ctx.updateCurrentTurn(turnId, (items) => ({ items, completed: true }));
  // Only the turn that is actually running may stop the composer. A replayed or
  // late `turn/completed` naming an earlier turn used to clear the pointer
  // regardless, which released Send and hid the spinner while a different turn
  // was still streaming.
  // A previously unknown completion can settle a lost start response, but an
  // already-terminal replay cannot release a newer unbound submission.
  // A completion for a turn this client never saw start still ends whatever
  // submission is outstanding: without the null case, a send whose HTTP
  // response was lost leaves `turnStartPending` set with no later event able
  // to clear it, and the composer never re-enables.
  const active = ctx.getActiveTurnId();
  if (active === turnId || (active === null && !alreadyTerminal)) {
    ctx.setTurnStartPending(false);
    ctx.clearActiveTurn();
  }

  if (turn.status === 'failed' && turn.error) {
    ctx.upsertTurnFailure(normalizeLiveTurnFailure(turnId, turn.error));
  }
};

export const handleTurnPlanUpdated: Handler = (params, ctx) => {
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
    explanation:
      typeof params.explanation === 'string' ? params.explanation : null,
    steps,
  });
};

export const handlePlanDelta: Handler = (params, ctx) => {
  const { turnId, itemId, delta } = params as {
    turnId?: string;
    itemId?: string;
    delta?: string;
  };
  if (!turnId || !itemId || !delta || !hasThreadScope(params, ctx)) return;
  ctx.appendPlanDelta(turnId, itemId, delta);
};

export const handleMcpToolCallProgress: Handler = (params, ctx) => {
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
