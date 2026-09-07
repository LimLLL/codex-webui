/**
 * Zustand store for session-level model and reasoning effort overrides.
 * These are applied per-turn via turn/start params.
 */
import { create } from 'zustand';

export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';

interface ModelState {
  /** Overridden model id — null means use the server default. */
  modelOverride: string | null;
  /**
   * Overridden reasoning effort — null means use model default.
   *
   * This is a deliberate user choice and IS sent with `turn/start`, so nothing
   * but a user action may write it. Reflecting an observed thread effort here
   * would silently force that effort onto whatever thread is sent next.
   */
  effortOverride: ReasoningEffort | null;
  /**
   * Effort app-server reports for a thread, keyed by thread id. Display only:
   * entering Plan mode rewrites a thread's effort server-side, and the badge
   * has to show that without turning it into an override.
   */
  observedEffortByThread: Record<string, ReasoningEffort | null>;

  setModelOverride: (model: string | null) => void;
  setEffortOverride: (effort: ReasoningEffort | null) => void;
  setObservedThreadEffort: (
    threadId: string,
    effort: ReasoningEffort | null,
  ) => void;
  forgetObservedThreadEffort: (threadId: string) => void;
  clearOverrides: () => void;
}

export const useModelStore = create<ModelState>((set) => ({
  modelOverride: null,
  effortOverride: null,
  observedEffortByThread: {},

  setModelOverride: (model) => set({ modelOverride: model }),
  setEffortOverride: (effort) => set({ effortOverride: effort }),
  setObservedThreadEffort: (threadId, effort) =>
    set((state) => ({
      observedEffortByThread: {
        ...state.observedEffortByThread,
        [threadId]: effort,
      },
    })),
  forgetObservedThreadEffort: (threadId) =>
    set((state) => {
      if (!(threadId in state.observedEffortByThread)) return state;
      const next = { ...state.observedEffortByThread };
      delete next[threadId];
      return { observedEffortByThread: next };
    }),
  clearOverrides: () => set({ modelOverride: null, effortOverride: null }),
}));
