/**
 * Zustand store for session-level model, reasoning effort and service tier
 * overrides. These are applied per-turn via turn/start params.
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
  /**
   * Service tier app-server reports for a thread, keyed by thread id. Display
   * only, for the same reason as the effort map above.
   *
   * Without this the picker would fall back to the model's catalog default and
   * show "Standard" for a thread that actually carries a paid tier — while the
   * composer omits `serviceTier`, leaving that tier in force. The user would
   * believe they were on standard speed and cost.
   */
  observedServiceTierByThread: Record<string, string | null>;
  /**
   * Overridden service (speed) tier — three-state, unlike the two overrides
   * above.
   *
   * `undefined` means the user has not touched the picker, so the field is
   * omitted and the thread keeps whatever tier it already had. `null` is the
   * user explicitly choosing standard speed, which has to be sent to clear a
   * previously set tier. A string is a model-advertised tier id.
   *
   * Collapsing `null` into `undefined` would make "go back to standard"
   * unexpressible; always sending it would force-clear the configured tier for
   * users who never opened the picker.
   */
  serviceTierOverride: string | null | undefined;

  setModelOverride: (model: string | null) => void;
  setEffortOverride: (effort: ReasoningEffort | null) => void;
  setServiceTierOverride: (tier: string | null | undefined) => void;
  setObservedThreadEffort: (
    threadId: string,
    effort: ReasoningEffort | null,
  ) => void;
  setObservedThreadServiceTier: (threadId: string, tier: string | null) => void;
  forgetObservedThreadEffort: (threadId: string) => void;
  clearOverrides: () => void;
}

export const useModelStore = create<ModelState>((set) => ({
  modelOverride: null,
  effortOverride: null,
  observedEffortByThread: {},
  observedServiceTierByThread: {},
  serviceTierOverride: undefined,

  setModelOverride: (model) => set({ modelOverride: model }),
  setEffortOverride: (effort) => set({ effortOverride: effort }),
  setServiceTierOverride: (tier) => set({ serviceTierOverride: tier }),
  setObservedThreadEffort: (threadId, effort) =>
    set((state) => ({
      observedEffortByThread: {
        ...state.observedEffortByThread,
        [threadId]: effort,
      },
    })),
  setObservedThreadServiceTier: (threadId, tier) =>
    set((state) => ({
      observedServiceTierByThread: {
        ...state.observedServiceTierByThread,
        [threadId]: tier,
      },
    })),
  // Drops every observed setting for a thread. The guard checks both maps: a
  // thread can have an observed tier without an observed effort, and keying the
  // early return on effort alone would strand the tier entry.
  forgetObservedThreadEffort: (threadId) =>
    set((state) => {
      const hasEffort = threadId in state.observedEffortByThread;
      const hasTier = threadId in state.observedServiceTierByThread;
      if (!hasEffort && !hasTier) return state;
      const next = { ...state.observedEffortByThread };
      const nextTiers = { ...state.observedServiceTierByThread };
      delete next[threadId];
      delete nextTiers[threadId];
      return {
        observedEffortByThread: next,
        observedServiceTierByThread: nextTiers,
      };
    }),
  clearOverrides: () =>
    set({
      modelOverride: null,
      effortOverride: null,
      serviceTierOverride: undefined,
    }),
}));
