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
   * Local service-tier seed from start/resume/fork responses. The pinned CLI
   * has no passive tier read or tier-change notification; this map does not
   * claim cross-client freshness. Rendering filters it by model support.
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
  /**
   * Observation counter for each thread's recorded settings.
   *
   * Two sources write these maps and they are not equally fresh: a
   * `thread/settings/updated` notification reports the change as it happens,
   * while an open response is a snapshot taken when the request was served. If
   * the notification lands while that request is in flight, the older response
   * would overwrite it and the picker would show settings the conversation had
   * already left. Stamping the evidence is what makes the two comparable.
   */
  observedSettingsSeqByThread: Record<string, number>;
  /**
   * Records observed effort and, only when supplied by a lifecycle response,
   * a local tier seed. Effort notifications do not clear or invent a tier.
   *
   * @param threadId - Conversation the evidence describes
   * @param settings - Effort and tier as reported
   * @param seq - Counter at request issue or notification arrival, never at response application
   * @returns Nothing; an older observation is discarded
   */
  setObservedThreadSettings: (
    threadId: string,
    settings: { effort: ReasoningEffort | null; serviceTier?: string | null },
    seq: number,
  ) => void;
  forgetObservedThreadEffort: (threadId: string) => void;
  clearOverrides: () => void;
}

export const useModelStore = create<ModelState>((set) => ({
  modelOverride: null,
  effortOverride: null,
  observedEffortByThread: {},
  observedServiceTierByThread: {},
  observedSettingsSeqByThread: {},
  serviceTierOverride: undefined,

  setModelOverride: (model) => set({ modelOverride: model }),
  setEffortOverride: (effort) => set({ effortOverride: effort }),
  setServiceTierOverride: (tier) => set({ serviceTierOverride: tier }),
  setObservedThreadSettings: (threadId, settings, seq) =>
    set((state) => {
      const held = state.observedSettingsSeqByThread[threadId];
      const older = held !== undefined && held > seq;
      if (older && (settings.serviceTier === undefined || threadId in state.observedServiceTierByThread)) return state;
      return {
        observedEffortByThread: {
          ...state.observedEffortByThread,
          [threadId]: older ? state.observedEffortByThread[threadId] : settings.effort,
        },
        observedServiceTierByThread: settings.serviceTier === undefined ? state.observedServiceTierByThread : {
          ...state.observedServiceTierByThread,
          [threadId]: settings.serviceTier,
        },
        observedSettingsSeqByThread: {
          ...state.observedSettingsSeqByThread,
          [threadId]: older ? held : seq,
        },
      };
    }),
  // Drops every observed setting for a thread. The guard checks both maps: a
  // thread can have an observed tier without an observed effort, and keying the
  // early return on effort alone would strand the tier entry.
  forgetObservedThreadEffort: (threadId) =>
    set((state) => {
      const hasEffort = threadId in state.observedEffortByThread;
      const hasTier = threadId in state.observedServiceTierByThread;
      if (!hasEffort && !hasTier && !(threadId in state.observedSettingsSeqByThread))
        return state;
      const next = { ...state.observedEffortByThread };
      const nextTiers = { ...state.observedServiceTierByThread };
      delete next[threadId];
      delete nextTiers[threadId];
      const nextSeqs = { ...state.observedSettingsSeqByThread };
      delete nextSeqs[threadId];
      return {
        observedEffortByThread: next,
        observedServiceTierByThread: nextTiers,
        observedSettingsSeqByThread: nextSeqs,
      };
    }),
  clearOverrides: () =>
    set({
      modelOverride: null,
      effortOverride: null,
      serviceTierOverride: undefined,
    }),
}));
