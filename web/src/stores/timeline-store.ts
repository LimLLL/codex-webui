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

/** Unsubscribe from the current thread and subscribe to a new one. */
function switchSocketSubscription(
  oldThreadId: string | null,
  newThreadId: string,
) {
  const socket = getSocket();
  if (oldThreadId) {
    socket.emit('thread.unsubscribe', { threadId: oldThreadId });
  }
  socket.emit('thread.subscribe', { threadId: newThreadId });
}

interface TimelineState {
  threadId: string | null;
  /** Working directory of the current thread. */
  threadCwd: string | null;
  timeline: TimelineEntry[];
  loading: boolean;
  expandedReasoning: Set<string>;
  /** Pending/resolved approval requests, keyed by itemId for easy lookup. */
  approvals: Record<string, ApprovalRequest>;

  /** Sets the active thread, subscribes socket, resets timeline. */
  setActiveThread: (threadId: string, cwd?: string | null) => void;
  /** Hydrates timeline from persisted turns (e.g. after resume). */
  hydrateTimeline: (turns: TurnDto[], cwd?: string | null) => void;
  /** Adds a user message to the timeline (optimistic). */
  addUserMessage: (text: string) => void;
  /** Adds a system error to the timeline. */
  addSystemError: (message: string) => void;

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
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  threadId: null,
  threadCwd: null,
  timeline: [],
  loading: false,
  expandedReasoning: new Set<string>(),
  approvals: {},

  setActiveThread: (threadId: string, cwd?: string | null) => {
    const { threadId: oldId } = get();
    if (oldId === threadId) return;
    switchSocketSubscription(oldId, threadId);
    set({
      threadId,
      threadCwd: cwd ?? null,
      timeline: [],
      loading: false,
      expandedReasoning: new Set<string>(),
      approvals: {},
    });
  },

  hydrateTimeline: (turns: TurnDto[], cwd?: string | null) => {
    set({
      threadCwd: cwd ?? get().threadCwd,
      loading: false,
      ...(turns.length > 0 ? { timeline: turnsToTimeline(turns) } : {}),
    });
  },

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
        { kind: 'system' as const, content: `Error: ${message}` },
      ],
      loading: false,
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
      const last = timeline[timeline.length - 1];

      if (last?.kind === 'turn' && last.turnId === turnId) {
        const result = updater(last.items, last.completed);
        return {
          timeline: [
            ...timeline.slice(0, -1),
            { ...last, items: result.items, completed: result.completed },
          ],
        };
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
    set((s) => ({
      approvals: { ...s.approvals, [approval.itemId]: approval },
    }));
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
}));

export type { ThreadDto, TurnDto };
