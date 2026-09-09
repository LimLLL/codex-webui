import { describe, expect, it } from 'vitest';
import type { TurnItem, TurnPlanState } from '@/types/timeline';
import { isPlanDisplayable, isTurnItemDisplayable } from './turn-item-display';

/** Builds an assistant message item, which is the one that produced the bug. */
function agentMessage(
  content: string,
  questions: Array<{ title: string; options: string[] | null }> = [],
): TurnItem {
  return {
    type: 'agentMessage',
    itemId: 'item-1',
    completed: false,
    content,
    questions,
  };
}

describe('isTurnItemDisplayable', () => {
  it('hides an assistant message that item/started inserted before its first delta', () => {
    // The reported blank strip: the turn holds this item, so the shell used to
    // render an avatar and bubble around a renderer emitting nothing.
    expect(isTurnItemDisplayable(agentMessage(''))).toBe(false);
    expect(isTurnItemDisplayable(agentMessage('  \n '))).toBe(false);
  });

  it('shows an assistant message once any content streams in', () => {
    expect(isTurnItemDisplayable(agentMessage('H'))).toBe(true);
  });

  it('shows a question-only assistant message', () => {
    // Questions render independently of the markdown body, so a text-only
    // check would hide a prompt the user is meant to answer.
    expect(
      isTurnItemDisplayable(
        agentMessage('', [{ title: 'Which one?', options: ['a', 'b'] }]),
      ),
    ).toBe(true);
  });

  it('matches the reasoning renderer, which bails on empty content only', () => {
    const reasoning = (content: string): TurnItem => ({
      type: 'reasoning',
      itemId: 'r',
      completed: false,
      content,
    });
    expect(isTurnItemDisplayable(reasoning(''))).toBe(false);
    // Whitespace still draws the collapsible "Thinking" header, so it counts.
    expect(isTurnItemDisplayable(reasoning(' '))).toBe(true);
  });

  it('shows activity items that are meaningful before they produce output', () => {
    // A running command and an in-flight tool call carry their own header and
    // lifecycle indicator; hiding them until output arrives would make the
    // agent look idle while it works.
    const command: TurnItem = {
      type: 'commandExecution',
      itemId: 'c',
      completed: false,
      content: '',
    };
    expect(isTurnItemDisplayable(command)).toBe(true);

    const toolCall: TurnItem = {
      type: 'mcpToolCall',
      itemId: 'm',
      completed: false,
      content: '',
      toolName: 'search',
      toolServer: 'srv',
      toolArgs: '{}',
    };
    expect(isTurnItemDisplayable(toolCall)).toBe(true);
  });
});

describe('isPlanDisplayable', () => {
  const emptyPlan: TurnPlanState = { explanation: null, steps: [] };

  it('rejects an absent plan and a plan the panel would refuse to draw', () => {
    expect(isPlanDisplayable(undefined)).toBe(false);
    expect(isPlanDisplayable(emptyPlan)).toBe(false);
    expect(
      isPlanDisplayable({ ...emptyPlan, planTextByItemId: { a: '   ' } }),
    ).toBe(false);
  });

  it('accepts a plan with an explanation, steps, or streamed text', () => {
    expect(isPlanDisplayable({ ...emptyPlan, explanation: 'why' })).toBe(true);
    expect(
      isPlanDisplayable({
        ...emptyPlan,
        steps: [{ step: 'do it', status: 'pending' }],
      }),
    ).toBe(true);
    expect(
      isPlanDisplayable({ ...emptyPlan, planTextByItemId: { a: 'draft' } }),
    ).toBe(true);
  });
});
