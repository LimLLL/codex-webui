/**
 * Zustand store for chat timeline state.
 * Manages threads, turns, items, and their streaming updates.
 */
import { create } from 'zustand';
import { api, type Thread, type TurnItemData, type Turn } from '../api';
import { getSocket } from '../socket';
import type { TimelineEntry, TurnItem } from '../types/timeline';
import type { ApprovalRequest } from '../types/approval';

/** Converts a persisted turn item to a TurnItem for rendering. */
function parseTurnItem(item: TurnItemData): TurnItem | null {
  switch (item.type) {
    case 'userMessage':
      return null; // Handled separately as TimelineEntry.user
    case 'reasoning':
      return {
        type: 'reasoning',
        itemId: item.id,
        content: item.summary?.join('\n') ?? '',
        completed: true,
      };
    case 'agentMessage':
      return {
        type: 'agentMessage',
        itemId: item.id,
        content: item.text ?? '',
        completed: true,
      };
    case 'mcpToolCall':
      return {
        type: 'mcpToolCall',
        itemId: item.id,
        content: item.result ? JSON.stringify(item.result, null, 2).slice(0, 500) : '',
        completed: true,
        toolServer: (item.server as string) ?? '',
        toolName: (item.tool as string) ?? '',
        toolArgs: item.arguments ? JSON.stringify(item.arguments, null, 2) : '',
      };
    case 'commandExecution':
      return {
        type: 'commandExecution',
        itemId: item.id,
        content: item.aggregatedOutput ?? item.text ?? '',
        completed: true,
        command: item.command,
        exitCode: item.exitCode,
      };
    case 'fileChange': {
      const changes = (item as unknown as Record<string, unknown>).changes as
        | Array<{ file?: string }>
        | undefined;
      return {
        type: 'fileChange',
        itemId: item.id,
        content: item.text ?? '',
        completed: true,
        filePath: changes?.[0]?.file,
      };
    }
    default:
      return null;
  }
}

/** Converts persisted turns into timeline entries. */
function turnsToTimeline(turns: Turn[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const turn of turns) {
    if (!turn.items) continue;

    // Extract user message first
    const userMsg = turn.items.find((it) => it.type === 'userMessage');
    if (userMsg) {
      const text =
        userMsg.content?.[0]?.text ?? userMsg.text ?? '';
      entries.push({ kind: 'user', content: text });
    }

    // Build turn block from remaining items
    const turnItems = turn.items
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
  /** All known threads for the sidebar list. */
  threads: Thread[];
  threadId: string | null;
  /** Working directory of the current thread. */
  threadCwd: string | null;
  timeline: TimelineEntry[];
  loading: boolean;
  expandedReasoning: Set<string>;
  /** Pending/resolved approval requests, keyed by itemId for easy lookup. */
  approvals: Record<string, ApprovalRequest>;

  fetchThreads: () => Promise<void>;
  createThread: () => Promise<void>;
  switchThread: (threadId: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
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

  /** Updates the turn-level unified diff. */
  updateTurnDiff: (turnId: string, diff: string) => void;

  setLoading: (loading: boolean) => void;
  expandReasoning: (itemId: string) => void;
  collapseReasoning: (itemId: string) => void;

  /** Adds a pending approval request. */
  addApproval: (approval: ApprovalRequest) => void;
  /** Marks an approval as accepted or declined. */
  resolveApproval: (itemId: string, decision: 'accepted' | 'declined') => void;
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

export const useTimelineStore = create<TimelineState>((set, get) => ({
  threads: [],
  threadId: null,
  threadCwd: null,
  timeline: [],
  loading: false,
  expandedReasoning: new Set<string>(),
  approvals: {},

  fetchThreads: async () => {
    try {
      const res = await api.listThreads();
      set({ threads: res.data });
    } catch {
      // Silently fail — sidebar will show empty
    }
  },

  createThread: async () => {
    try {
      const { threadId: oldId } = get();
      const res = await api.createThread({});
      const newId = res.thread.id;
      switchSocketSubscription(oldId, newId);
      set((s) => ({
        threadId: newId,
        threadCwd: res.cwd ?? null,
        timeline: [],
        loading: false,
        expandedReasoning: new Set<string>(),
        threads: [res.thread, ...s.threads],
      }));
    } catch (err) {
      set((s) => ({
        timeline: [
          ...s.timeline,
          {
            kind: 'system' as const,
            content: `Error: ${(err as Error).message}`,
          },
        ],
      }));
    }
  },

  switchThread: async (targetId: string) => {
    const { threadId: oldId } = get();
    if (oldId === targetId) return;

    switchSocketSubscription(oldId, targetId);
    set({
      threadId: targetId,
      threadCwd: null,
      timeline: [],
      loading: false,
      expandedReasoning: new Set<string>(),
      approvals: {},
    });

    try {
      const res = await api.resumeThread(targetId);
      const turns = res.thread.turns ?? [];
      set({
        threadCwd: res.cwd ?? null,
        ...(turns.length > 0 ? { timeline: turnsToTimeline(turns) } : {}),
      });
    } catch {
      // Thread might already be loaded — that's fine
    }
  },

  sendMessage: async (text: string) => {
    const { threadId, loading } = get();
    if (!threadId || !text.trim() || loading) return;

    set((s) => ({
      timeline: [...s.timeline, { kind: 'user' as const, content: text }],
      loading: true,
    }));

    try {
      await api.sendMessage(threadId, text);
    } catch (err) {
      set((s) => ({
        timeline: [
          ...s.timeline,
          {
            kind: 'system' as const,
            content: `Error: ${(err as Error).message}`,
          },
        ],
        loading: false,
      }));
    }
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
