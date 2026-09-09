/**
 * Decides whether a turn item or plan currently paints anything.
 *
 * The turn shell used to treat "this turn holds items" as "this turn has
 * something to show". They are not the same: `item/started` inserts an item
 * before its first delta arrives, so a turn can hold an assistant message whose
 * content is still empty. The shell rendered its avatar and bubble around a
 * renderer that emitted nothing, which is the blank strip users reported.
 *
 * These predicates mirror what the renderers actually do, so the shell and its
 * contents agree. They are pure and exhaustive over the *internal* item union on
 * purpose: adding a member there is a compile error here rather than a silently
 * blank bubble later. Unknown wire types are a separate concern and never reach
 * this exhaustiveness — the normalizer already folds them into
 * `unknownActivity`, which renders a visible unsupported-activity marker.
 */
import type { TurnItem, TurnPlanState } from '@/types/timeline';

/** Exhaustiveness guard — a new item type must be classified explicitly. */
function assertNever(value: never): never {
  void value;
  throw new Error('Unclassified turn item in display predicate');
}

/**
 * Reports whether an item renders anything on its own.
 *
 * Callers must additionally treat an item as visible when a blocking request
 * card is attached to it: those cards are rendered beside the item body, so an
 * invisible body can still own visible, interactive content.
 *
 * @param item - Normalized turn item.
 * @returns True when the item's own renderer produces output.
 */
export function isTurnItemDisplayable(item: TurnItem): boolean {
  switch (item.type) {
    // Mirrors the renderer's own `if (!item.content) return null`. Deliberately
    // falsiness rather than a trimmed check: whitespace-only content still
    // draws the collapsible "Thinking" header, which is not a blank bubble.
    case 'reasoning':
      return Boolean(item.content);

    // Markdown of nothing but whitespace paints nothing, but the questions
    // block below it is independent and renders on its own.
    case 'agentMessage':
      return item.content.trim().length > 0 || item.questions.length > 0;

    // Everything below is visible from the moment it exists, without any body
    // text: each renders a header, identity, lifecycle state or media of its
    // own — a command shows its command line and running indicator before any
    // output, a tool call shows its name and arguments while in flight, and the
    // output cards deliberately state that output was empty.
    case 'mcpToolCall':
    case 'commandExecution':
    case 'fileChange':
    case 'contextCompaction':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
    case 'hookPrompt':
    case 'functionCallOutput':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'subAgentActivity':
    case 'webSearch':
    case 'imageView':
    case 'sleep':
    case 'imageGeneration':
    case 'unknownActivity':
      return true;
  }
  return assertNever(item);
}

/**
 * Reports whether a turn plan renders anything.
 *
 * Mirrors the plan panel, which bails out when it has neither an explanation,
 * nor steps, nor non-empty streamed plan text. Testing the plan object for
 * mere existence would readmit an empty plan the panel refuses to draw.
 *
 * @param plan - Turn-level plan state, when the turn has one.
 * @returns True when the plan panel produces output.
 */
export function isPlanDisplayable(plan: TurnPlanState | undefined): boolean {
  if (!plan) return false;
  if (plan.explanation) return true;
  if (plan.steps.length > 0) return true;
  return Object.values(plan.planTextByItemId ?? {}).some(
    (text) => text.trim().length > 0,
  );
}
