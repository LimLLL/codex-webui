/** Delayed open responses must yield to live lifecycle and model observations. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadOpenResponseDto, TurnDto } from '@/generated/api';
import { useTimelineStore } from '@/stores/timeline-store';
import { useModelStore } from '@/stores/model-store';
import { nextObservationSeq } from '@/lib/turn-item-merge';
import { applyOpenResponse } from './use-thread-open';

vi.mock('@/socket', () => ({ getSocket: () => ({ emit: vi.fn() }) }));
vi.mock('@/stores/thread-policy-store', () => ({
  refreshThreadPolicy: vi.fn(async () => undefined), settleIfObserved: vi.fn(), forgetThreadPolicy: vi.fn(),
}));
vi.mock('@/lib/thread-recovery', () => ({ recoverTurnItems: vi.fn() }));
vi.mock('@/generated/api/sdk.gen', () => ({
  tokenUsageReadThreadTokenUsage: vi.fn(async () => ({})),
  turnDiffReadThreadTurnDiffs: vi.fn(async () => ({})),
  turnErrorsReadThreadTurnErrors: vi.fn(async () => ({})),
}));
const pristine = useTimelineStore.getState();
const pristineModels = useModelStore.getState();
const running: TurnDto = {
  id: 'turn', status: 'inProgress', items: [], itemsView: 'summary', error: null,
  startedAt: null, completedAt: null, durationMs: null,
};
function response(): ThreadOpenResponseDto {
  return {
    mode: 'writable', ownership: 'acquired', cwd: '/workspace',
    thread: {
      id: 't', name: 'thread', preview: '', status: { type: 'idle' }, cwd: '/workspace',
      forkedFromId: null, ephemeral: false, modelProvider: 'test', model: null,
      reasoningEffort: null, createdAt: 0, updatedAt: 0, path: null,
      cliVersion: '0.153.2', source: 'appServer', agentNickname: null,
      agentRole: null, gitInfo: null, turns: [],
    },
    reasoningEffort: 'low', serviceTier: null,
    initialTurnsPage: { data: [running], nextCursor: null, backwardsCursor: null },
    turnsBackwardsCursor: null, itemsBackwardsCursor: null,
  };
}
beforeEach(() => {
  useTimelineStore.setState(pristine, true);
  useModelStore.setState(pristineModels, true);
  useTimelineStore.getState().ensureThreadState({ threadId: 't' });
});

describe('open response authority', () => {
  it('does not revive a turn completed while opening', () => {
    const baseline = nextObservationSeq();
    useTimelineStore.getState().updateCurrentTurnForThread('t', 'turn', () => ({ items: [], completed: true }));
    applyOpenResponse(response(), baseline);
    expect(useTimelineStore.getState().getThreadRuntime('t')).toMatchObject({ activeTurnId: null, loading: false });
  });

  it('does not overwrite settings observed after the open request', () => {
    const baseline = nextObservationSeq();
    useModelStore.getState().setObservedThreadSettings('t', { effort: 'high', serviceTier: 'fast' }, nextObservationSeq());
    applyOpenResponse(response(), baseline);
    expect(useModelStore.getState().observedEffortByThread.t).toBe('high');
    expect(useModelStore.getState().observedServiceTierByThread.t).toBe('fast');
  });

  it('does not claim freshness when a caller has no request baseline', () => {
    useModelStore.getState().setObservedThreadSettings('t', { effort: 'high', serviceTier: 'fast' }, nextObservationSeq());
    applyOpenResponse(response());
    expect(useModelStore.getState().observedEffortByThread.t).toBe('high');
  });

  it('orders concurrent opens even without intervening item or settings events', () => {
    const older = nextObservationSeq();
    const newer = nextObservationSeq();
    applyOpenResponse({ ...response(), reasoningEffort: 'high' }, newer);
    applyOpenResponse(response(), older);
    expect(useModelStore.getState().observedEffortByThread.t).toBe('high');
  });

  it('forgets the sequence alongside its model observations', () => {
    useModelStore.getState().setObservedThreadSettings('t', { effort: 'high', serviceTier: 'fast' }, nextObservationSeq());
    useModelStore.getState().forgetObservedThreadEffort('t');
    expect(useModelStore.getState().observedSettingsSeqByThread.t).toBeUndefined();
  });
});
