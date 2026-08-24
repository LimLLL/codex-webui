export type TurnPlanStepStatus = 'pending' | 'inProgress' | 'completed';

export interface TurnPlanStep {
  step: string;
  status: TurnPlanStepStatus;
}

export interface TurnPlanState {
  explanation: string | null;
  steps: TurnPlanStep[];
  planTextByItemId?: Record<string, string>;
}

/** A single item within an AI turn. */
export interface TurnItem {
  type:
    | 'reasoning'
    | 'agentMessage'
    | 'mcpToolCall'
    | 'commandExecution'
    | 'fileChange';
  itemId: string;
  content: string;
  completed: boolean;
  toolName?: string;
  toolServer?: string;
  toolArgs?: string;
  /** Latest progress message for mcpToolCall items. */
  toolProgress?: string;
  /** File path for fileChange items. */
  filePath?: string;
  /** Pure diff content from changes[0].diff (fileChange only). */
  fileDiff?: string;
  /** Shell command for commandExecution items. */
  command?: string;
  /** Exit code for commandExecution items. */
  exitCode?: number;
}

/** A user message, system message, or a full AI turn. */
export type TimelineEntry =
  | {
      kind: 'user';
      content: string;
      images?: string[];
      /**
       * Turn this message opened. Absent between optimistic append and the
       * `turn/started` notification, which is also exactly the window in which
       * the message cannot be branched.
       */
      turnId?: string;
    }
  | { kind: 'system'; content: string; severity?: 'info' | 'warning' | 'error'; turnId?: string }
  | {
      kind: 'turn';
      turnId: string;
      items: TurnItem[];
      completed: boolean;
      /** Turn-level unified diff across all file changes. */
      diff?: string;
      /** Structured/streamed AI plan for this turn. */
      plan?: TurnPlanState;
    };
