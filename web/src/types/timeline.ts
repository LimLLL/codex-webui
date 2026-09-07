/** Internal, display-oriented timeline model shared by live and persisted history. */

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

interface TurnItemBase {
  itemId: string;
  completed: boolean;
}

export interface ReasoningTurnItem extends TurnItemBase {
  type: 'reasoning';
  content: string;
}

export interface AgentMessageTurnItem extends TurnItemBase {
  type: 'agentMessage';
  content: string;
  questions: Array<{ title: string; options: string[] | null }>;
}

export interface McpToolCallTurnItem extends TurnItemBase {
  type: 'mcpToolCall';
  content: string;
  toolName: string;
  toolServer: string;
  toolArgs: string;
  toolProgress?: string;
}

export interface CommandExecutionTurnItem extends TurnItemBase {
  type: 'commandExecution';
  content: string;
  command?: string;
  exitCode?: number;
}

export interface FileChangeTurnItem extends TurnItemBase {
  type: 'fileChange';
  content: string;
  filePath?: string;
  fileDiff?: string;
}

export interface ContextCompactionTurnItem extends TurnItemBase {
  type: 'contextCompaction';
  content: '';
}

export interface ReviewMarkerTurnItem extends TurnItemBase {
  type: 'enteredReviewMode' | 'exitedReviewMode';
  content: string;
}

export interface HookPromptTurnItem extends TurnItemBase {
  type: 'hookPrompt';
  fragments: Array<{ text: string; hookRunId: string }>;
}

export type FunctionCallOutputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string; detail: string | null }
  | { type: 'audio'; audioUrl: string }
  | { type: 'encrypted' };

export interface FunctionCallOutputTurnItem extends TurnItemBase {
  type: 'functionCallOutput';
  name: string;
  namespace: string | null;
  textOutput: string | null;
  outputParts: FunctionCallOutputPart[];
}

export type DynamicToolOutputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string }
  | { type: 'audio'; audioUrl: string };

export interface DynamicToolCallTurnItem extends TurnItemBase {
  type: 'dynamicToolCall';
  namespace: string | null;
  tool: string;
  toolArgs: string;
  status: string;
  contentItems: DynamicToolOutputPart[];
  success: boolean | null;
  durationMs: number | null;
}

export interface CollabAgentState {
  threadId: string;
  status: string;
  message: string | null;
}

export interface CollabAgentToolCallTurnItem extends TurnItemBase {
  type: 'collabAgentToolCall';
  tool: string;
  status: string;
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentStates: CollabAgentState[];
}

export interface SubAgentActivityTurnItem extends TurnItemBase {
  type: 'subAgentActivity';
  activityKind: 'started' | 'interacted' | 'interrupted' | 'completed';
  agentThreadId: string;
  agentPath: string;
}

export type WebSearchAction =
  | { type: 'search'; query: string | null; queries: string[] }
  | { type: 'openPage'; url: string | null }
  | { type: 'findInPage'; url: string | null; pattern: string | null }
  | { type: 'other' };

export interface WebSearchResultPreview {
  title: string | null;
  url: string | null;
  snippet: string | null;
}

export interface WebSearchTurnItem extends TurnItemBase {
  type: 'webSearch';
  query: string;
  action: WebSearchAction | null;
  resultCount: number | null;
  resultPreviews: WebSearchResultPreview[];
}

export interface ImageViewTurnItem extends TurnItemBase {
  type: 'imageView';
  path: string;
}

export interface SleepTurnItem extends TurnItemBase {
  type: 'sleep';
  durationMs: number;
}

export interface ImageGenerationTurnItem extends TurnItemBase {
  type: 'imageGeneration';
  status: string;
  revisedPrompt: string | null;
  previewUrl: string | null;
  hasUnpreviewableResult: boolean;
  transparentBackground: boolean | null;
  savedPath: string | null;
  failure: { type: string; limitId: string | null; resetsAt: number | null } | null;
}

/** Safe fallback produced by the normalizer for a future protocol variant. */
export interface UnknownActivityTurnItem extends TurnItemBase {
  type: 'unknownActivity';
  protocolType: string;
}

/** Every item the renderer understands; adding a member requires a switch case. */
export type TurnItem =
  | ReasoningTurnItem
  | AgentMessageTurnItem
  | McpToolCallTurnItem
  | CommandExecutionTurnItem
  | FileChangeTurnItem
  | ContextCompactionTurnItem
  | ReviewMarkerTurnItem
  | HookPromptTurnItem
  | FunctionCallOutputTurnItem
  | DynamicToolCallTurnItem
  | CollabAgentToolCallTurnItem
  | SubAgentActivityTurnItem
  | WebSearchTurnItem
  | ImageViewTurnItem
  | SleepTurnItem
  | ImageGenerationTurnItem
  | UnknownActivityTurnItem;

/** Structured terminal failure shown live and restored from local persistence. */
export interface TurnFailure {
  turnId: string;
  message: string;
  errorCategory: string | null;
  additionalDetails: string | null;
  misalignmentErrorType: string | null;
  misalignmentExplanation: string | null;
}

/** A user message, system message, structured failure, or full AI turn. */
export type TimelineEntry =
  | {
      kind: 'user';
      content: string;
      images?: string[];
      /** Turn this message opened; absent only before `turn/started`. */
      turnId?: string;
    }
  | {
      kind: 'system';
      content: string;
      severity?: 'info' | 'warning' | 'error';
      turnId?: string;
    }
  | { kind: 'turnFailure'; turnId: string; failure: TurnFailure }
  | {
      kind: 'turn';
      turnId: string;
      items: TurnItem[];
      completed: boolean;
      /** Turn-level unified diff across all file changes. */
      diff?: string;
      /** Structured/streamed AI plan for this turn. */
      plan?: TurnPlanState;
      /** Detail level used to decide whether this turn needs a full-item top-up. */
      itemsView?: 'notLoaded' | 'summary' | 'full';
    };
