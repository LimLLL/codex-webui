/**
 * Zustand store for chat timeline state.
 * Manages realtime/UI state: active thread, timeline entries, approvals.
 * REST data (thread list, models) is managed by TanStack Query.
 */
import { create } from 'zustand';
import { getSocket } from '../socket';
import type { TimelineEntry, TurnItem } from '../types/timeline';
import type { ApprovalRequest } from '../types/approval';
import type { ThreadDto, TurnDto } from '../generated/api';
import type { ThreadTokenUsage, ThreadStatusType } from '../types/codex-notifications';

export type ThreadMode = 'live' | 'readOnly';

/** Converts a persisted turn item to a TurnItem for rendering. */
function parseTurnItem(item: Record<string, unknown>): TurnItem | null {
  const type = item.type as string;
  const id = item.id as string;

  switch (type) {
    case 'userMessage':
      return null;
    case 'reasoning':
      return {
        type: 'reasoning',
        itemId: id,
        content: ((item.summary as string[]) ?? []).join('\n'),
        completed: true,
      };
    case 'agentMessage':
      return {
        type: 'agentMessage',
        itemId: id,
        content: (item.text as string) ?? '',
        completed: true,
      };
    case 'mcpToolCall':
      return {
        type: 'mcpToolCall',
        itemId: id,
        content: item.result ? JSON.stringify(item.result, null, 2).slice(0, 500) : '',
        completed: true,
        toolServer: (item.server as string) ?? '',
        toolName: (item.tool as string) ?? '',
        toolArgs: item.arguments ? JSON.stringify(item.arguments, null, 2) : '',
      };
    case 'commandExecution':
      return {
        type: 'commandExecution',
        itemId: id,
        content: (item.aggregatedOutput as string) ?? (item.text as string) ?? '',
        completed: true,
        command: item.command as string | undefined,
        exitCode: item.exitCode as number | undefined,
      };
    case 'fileChange': {
      const changes = item.changes as Array<{ file?: string }> | undefined;
      return {
        type: 'fileChange',
        itemId: id,
        content: (item.text as string) ?? '',
        completed: true,
        filePath: changes?.[0]?.file,
      };
    }
    default:
      return null;
  }
}

/** Converts persisted turns into timeline entries. */
function turnsToTimeline(turns: TurnDto[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const turn of turns) {
    const items = (turn.items ?? []) as Array<Record<string, unknown>>;

    const userMsg = items.find((it) => it.type === 'userMessage');
    if (userMsg) {
      const content = userMsg.content as Array<{ type: string; text?: string }> | undefined;
      const text = content?.[0]?.text ?? (userMsg.text as string) ?? '';
      entries.push({ kind: 'user', content: text });
    }

    const turnItems = items
      .map(parseTurnItem)
      .filter((it): it is TurnItem => it !== null);

    if (turnItems.length > 0) {
      entries.push({
        kind: 'turn',
        turnId: turn.id,
        items: turnItems,
        completed: turn.status === 'completed',
      });
    }
  }

  return entries;
}


interface TimelineState {
  threadId: string | null;
  /** Working directory of the current thread. */
  threadCwd: string | null;
  /** Current thread display name, falling back to preview in UI. */
  threadTitle: string | null;
  /** Live threads are resumable; read-only threads are archived snapshots. */
  threadMode: ThreadMode;
  timeline: TimelineEntry[];
  loading: boolean;
  expandedReasoning: Set<string>;
  /** Pending/resolved approval requests, keyed by itemId for easy lookup. */
  approvals: Record<string, ApprovalRequest>;
  /** Token usage per turn (keyed by turnId). */
  tokenUsageByTurn: Record<string, ThreadTokenUsage>;
  /** Latest token usage snapshot for the active thread (drives ChatInput donut). */
  latestTokenUsage: ThreadTokenUsage | null;
  /** Active thread status from app-server. */
  threadStatus: ThreadStatusType | null;
  /** Active turn id observed from a fresh turn/started notification. */
  activeTurnId: string | null;
  /** Request IDs resolved before their approval card arrived (out-of-order). */
  pendingResolvedRequestIds: Set<string>;

  /** Sets the active thread, subscribes socket, resets timeline. */
  setActiveThread: (threadId: string, cwd?: string | null, title?: string | null) => void;
  /** Loads a thread snapshot without subscribing it for live updates. */
  setReadOnlyThread: (thread: ThreadDto) => void;
  /** Clears the selected thread and returns the chat area to the empty state. */
  clearThread: () => void;
  /** Hydrates timeline from persisted turns (e.g. after resume). */
  hydrateTimeline: (turns: TurnDto[], cwd?: string | null) => void;
  /** Updates the active thread title after a rename/list refresh. */
  setThreadTitle: (title: string | null) => void;
  /** Adds a user message to the timeline (optimistic). */
  addUserMessage: (text: string) => void;
  /** Adds a system error to the timeline. */
  addSystemError: (message: string) => void;
  /** Adds a system message with optional severity. */
  addSystemMessage: (message: string, severity?: 'info' | 'warning' | 'error') => void;

  toggleReasoning: (itemId: string) => void;
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
  setLoading: (loading: boolean) => void;
  expandReasoning: (itemId: string) => void;
  collapseReasoning: (itemId: string) => void;
  addApproval: (approval: ApprovalRequest) => void;
  resolveApproval: (itemId: string, decision: 'accepted' | 'declined') => void;
  /** Stores token usage for a turn and updates latest snapshot. */
  setTokenUsage: (turnId: string, usage: ThreadTokenUsage) => void;
  /** Updates active thread status. */
  setThreadStatus: (status: ThreadStatusType | null) => void;
  /** Stores the currently steerable turn id. */
  setActiveTurnId: (turnId: string | null) => void;
  /** Clears the active turn and marks the active turn as no longer loading. */
  clearActiveTurn: () => void;
  /** Hydrates token usage snapshots fetched from the backend. */
  hydrateTokenUsage: (turns: Array<{ turnId: string; usage: ThreadTokenUsage }>) => void;
  /** Resolves an approval by its JSON-RPC requestId (for serverRequest/resolved). */
  resolveApprovalByRequestId: (requestId: string | number) => void;
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  threadId: null,
  threadCwd: null,
  threadTitle: null,
  threadMode: 'live',
  timeline: [],
  loading: false,
  expandedReasoning: new Set<string>(),
  approvals: {},
  tokenUsageByTurn: {},
  latestTokenUsage: null,
  threadStatus: null,
  activeTurnId: null,
  pendingResolvedRequestIds: new Set(),

  setActiveThread: (threadId: string, cwd?: string | null, title?: string | null) => {
    const { threadId: oldId, threadMode: oldMode } = get();
    if (oldId === threadId && oldMode === 'live') return;
    if (oldId && oldId !== threadId) {
      getSocket().emit('thread.unsubscribe', { threadId: oldId });
    }
    getSocket().emit('thread.subscribe', { threadId });
    set({
      threadId,
      threadCwd: cwd ?? null,
      threadTitle: title ?? null,
      threadMode: 'live',
      timeline: [],
      loading: false,
      expandedReasoning: new Set<string>(),
      approvals: {},
      tokenUsageByTurn: {},
      latestTokenUsage: null,
      threadStatus: null,
      activeTurnId: null,
      pendingResolvedRequestIds: new Set(),
    });
  },

  setReadOnlyThread: (thread) => {
    const { threadId: oldId } = get();
    if (oldId) {
      getSocket().emit('thread.unsubscribe', { threadId: oldId });
    }
    set({
      threadId: thread.id,
      threadCwd: thread.cwd,
      threadTitle: thread.name ?? thread.preview ?? null,
      threadMode: 'readOnly',
      timeline: turnsToTimeline(thread.turns ?? []),
      loading: false,
      expandedReasoning: new Set<string>(),
      approvals: {},
      tokenUsageByTurn: {},
      latestTokenUsage: null,
      threadStatus: thread.status as ThreadStatusType,
      activeTurnId: null,
      pendingResolvedRequestIds: new Set(),
    });
  },

  clearThread: () => {
    const { threadId: oldId } = get();
    if (oldId) {
      getSocket().emit('thread.unsubscribe', { threadId: oldId });
    }
    set({
      threadId: null,
      threadCwd: null,
      threadTitle: null,
      threadMode: 'live',
      timeline: [],
      loading: false,
      expandedReasoning: new Set<string>(),
      approvals: {},
      tokenUsageByTurn: {},
      latestTokenUsage: null,
      threadStatus: null,
      activeTurnId: null,
      pendingResolvedRequestIds: new Set(),
    });
  },

  hydrateTimeline: (turns: TurnDto[], cwd?: string | null) => {
    set({
      threadCwd: cwd ?? get().threadCwd,
      loading: false,
      timeline: turnsToTimeline(turns),
      activeTurnId: null,
    });
  },

  setThreadTitle: (title) => set({ threadTitle: title }),

  addUserMessage: (text: string) => {
    set((s) => ({
      timeline: [...s.timeline, { kind: 'user' as const, content: text }],
      loading: true,
    }));
  },

  addSystemError: (message: string) => {
    set((s) => ({
      timeline: [
        ...s.timeline,
        { kind: 'system' as const, content: `Error: ${message}`, severity: 'error' as const },
      ],
      loading: false,
    }));
  },

  addSystemMessage: (message: string, severity: 'info' | 'warning' | 'error' = 'info') => {
    set((s) => ({
      timeline: [
        ...s.timeline,
        { kind: 'system' as const, content: message, severity },
      ],
    }));
  },

  toggleReasoning: (itemId: string) => {
    set((s) => {
      const next = new Set(s.expandedReasoning);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return { expandedReasoning: next };
    });
  },

  updateCurrentTurn: (turnId, updater) => {
    set((s) => {
      const { timeline } = s;
      const idx = timeline.findIndex(
        (e) => e.kind === 'turn' && e.turnId === turnId,
      );

      if (idx >= 0) {
        const entry = timeline[idx];
        if (entry.kind !== 'turn') return {};
        const result = updater(entry.items, entry.completed);
        const updated = [...timeline];
        updated[idx] = { ...entry, items: result.items, completed: result.completed };
        return { timeline: updated };
      }

      const result = updater([], false);
      return {
        timeline: [
          ...timeline,
          { kind: 'turn' as const, turnId, ...result },
        ],
      };
    });
  },

  updateTurnItem: (turnId, itemId, updater) => {
    get().updateCurrentTurn(turnId, (items, completed) => {
      const idx = items.findIndex((it) => it.itemId === itemId);
      if (idx >= 0) {
        const updated = [...items];
        updated[idx] = updater(updated[idx]);
        return { items: updated, completed };
      }
      return { items: [...items, updater(undefined)], completed };
    });
  },

  updateTurnDiff: (turnId, diff) => {
    set((s) => {
      const { timeline } = s;
      const idx = timeline.findIndex(
        (e) => e.kind === 'turn' && e.turnId === turnId,
      );
      if (idx >= 0) {
        const entry = timeline[idx];
        if (entry.kind === 'turn') {
          const updated = [...timeline];
          updated[idx] = { ...entry, diff };
          return { timeline: updated };
        }
      }
      return {};
    });
  },

  setLoading: (loading: boolean) => set({ loading }),

  expandReasoning: (itemId: string) => {
    set((s) => ({
      expandedReasoning: new Set(s.expandedReasoning).add(itemId),
    }));
  },

  collapseReasoning: (itemId: string) => {
    set((s) => {
      const next = new Set(s.expandedReasoning);
      next.delete(itemId);
      return { expandedReasoning: next };
    });
  },

  addApproval: (approval) => {
    const { pendingResolvedRequestIds } = get();
    const requestKey = String(approval.requestId);
    const alreadyResolved = pendingResolvedRequestIds.has(requestKey);
    const finalApproval = alreadyResolved
      ? { ...approval, status: 'resolved' as const }
      : approval;
    set((s) => {
      const nextPending = alreadyResolved
        ? (() => {
            const next = new Set(s.pendingResolvedRequestIds);
            next.delete(requestKey);
            return next;
          })()
        : s.pendingResolvedRequestIds;
      return {
        approvals: { ...s.approvals, [approval.itemId]: finalApproval },
        pendingResolvedRequestIds: nextPending,
      };
    });
  },

  resolveApproval: (itemId, decision) => {
    set((s) => {
      const existing = s.approvals[itemId];
      if (!existing) return {};
      return {
        approvals: {
          ...s.approvals,
          [itemId]: { ...existing, status: decision },
        },
      };
    });
  },

  setTokenUsage: (turnId, usage) => {
    set((s) => ({
      tokenUsageByTurn: { ...s.tokenUsageByTurn, [turnId]: usage },
      latestTokenUsage: usage,
    }));
  },

  setThreadStatus: (status) => {
    set({ threadStatus: status });
  },

  setActiveTurnId: (turnId) => set({ activeTurnId: turnId }),

  clearActiveTurn: () => set({ activeTurnId: null, loading: false }),

  hydrateTokenUsage: (turns) => {
    const byTurn: Record<string, ThreadTokenUsage> = {};
    for (const turn of turns) {
      byTurn[turn.turnId] = turn.usage;
    }
    set({
      tokenUsageByTurn: byTurn,
      latestTokenUsage: turns.at(-1)?.usage ?? null,
    });
  },

  resolveApprovalByRequestId: (requestId) => {
    const requestKey = String(requestId);
    const { approvals } = get();
    const entry = Object.values(approvals).find(
      (a) => String(a.requestId) === requestKey,
    );
    if (entry) {
      set((s) => ({
        approvals: {
          ...s.approvals,
          [entry.itemId]: { ...entry, status: 'resolved' },
        },
      }));
    } else {
      set((s) => ({
        pendingResolvedRequestIds: new Set(s.pendingResolvedRequestIds).add(requestKey),
      }));
    }
  },
}));

export type { ThreadDto, TurnDto };
