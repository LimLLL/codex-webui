/**
 * Adds the native "carry goal into fork" opt-in to the fork action.
 *
 * Codex's fork RPC takes a deferred-goal-continuation flag, but it is opt-in
 * at the protocol level, so an ordinary fork does NOT carry the goal. Defaulting
 * it on would diverge from native behaviour and quietly leave two threads
 * spending tokens on the same objective, so the checkbox starts unchecked and
 * only appears when the source thread actually has a live goal.
 */
import { useCallback, useState } from 'react';
import { threadCommandsReadGoal } from '@/generated/api/sdk.gen';

/** Goal states that are still driving work, and so worth carrying over. */
const CARRYABLE_STATUSES = new Set(['active', 'paused', 'blocked']);

/** A fork waiting on the user's decision about the source thread's goal. */
export interface PendingForkPrompt {
  threadId: string;
  objective: string;
}

interface UseForkWithGoalParams {
  /** Performs the actual fork once the goal question is settled. */
  onFork: (threadId: string, carryGoal: boolean) => void;
}

export function useForkWithGoal({ onFork }: UseForkWithGoalParams) {
  const [prompt, setPrompt] = useState<PendingForkPrompt | null>(null);

  /**
   * Starts a fork, asking about the goal first only when one exists.
   *
   * The goal is fetched on demand rather than tracked for every sidebar row:
   * this costs one request at click time instead of one per listed thread.
   */
  const requestFork = useCallback(
    async (threadId: string) => {
      let objective: string | null = null;
      try {
        const { data } = await threadCommandsReadGoal({ path: { threadId } });
        const goal = data?.goal;
        if (goal && CARRYABLE_STATUSES.has(goal.status)) {
          objective = goal.objective;
        }
      } catch {
        // A goal lookup failure must not block forking. Falling through forks
        // without carrying the goal, which is the safe default anyway.
      }

      if (objective === null) {
        onFork(threadId, false);
        return;
      }
      setPrompt({ threadId, objective });
    },
    [onFork],
  );

  const confirm = useCallback(
    (carryGoal: boolean) => {
      if (!prompt) return;
      onFork(prompt.threadId, carryGoal);
      setPrompt(null);
    },
    [prompt, onFork],
  );

  const cancel = useCallback(() => setPrompt(null), []);

  return { requestFork, prompt, confirm, cancel };
}
