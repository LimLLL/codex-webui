/**
 * Is a completed item durable BEFORE its turn ends?
 *
 * This gates the whole "refresh during a running turn loses the transcript"
 * fix. If persistence only happened at turn completion, nothing could be
 * recovered mid-turn and the fix would be impossible; if it happens per item,
 * a running turn already exposes everything the agent has finished.
 *
 * An earlier run of this question was inconclusive because the running turn
 * contained exactly one item and that item was itself unfinished — which cannot
 * separate "nothing persists until the turn ends" from "unfinished items do not
 * persist". This version issues a slow command and then a quick one, so one
 * turn holds a finished item alongside a running one.
 *
 * `thread/shellCommand` is used rather than a model turn because it produces
 * real turns and real items with no credentials and no token cost. It runs
 * unsandboxed by design, so it cannot answer anything about policy enforcement
 * — that is what the live-policy probe is for.
 *
 * Result on 0.153.2: the running turn reports `itemsView: full` with its
 * finished item present, while the `summary` view returns zero items even for a
 * completed command-only turn. Both halves matter: the first makes recovery
 * possible, the second is why the cheap open view looks blank mid-turn.
 */
import { delay, itemType, text } from '../harness';
import type { Probe } from '../run';

interface TurnHeader {
  id: string;
  status: string;
  items?: Array<Record<string, unknown>>;
}

export const itemPersistence: Probe = {
  name: 'item-persistence',
  question: 'Are finished items readable while their turn is still running?',
  run: async ({ app, workspace }) => {
    const start = await app.request<{ thread: { id: string } }>({
      method: 'thread/start',
      params: {
        cwd: workspace,
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
      },
    });
    if (start.error || !start.result) {
      console.log(`thread/start ERR ${JSON.stringify(start.error)}`);
      return;
    }
    const threadId = start.result.thread.id;

    /** Dumps every turn with its status and per-view item counts. */
    const survey = async (tag: string): Promise<void> => {
      const full = await app.request<{ data: TurnHeader[] }>({
        method: 'thread/turns/list',
        params: {
          threadId,
          limit: 10,
          sortDirection: 'desc',
          itemsView: 'full',
        },
      });
      const summary = await app.request<{ data: TurnHeader[] }>({
        method: 'thread/turns/list',
        params: {
          threadId,
          limit: 10,
          sortDirection: 'desc',
          itemsView: 'summary',
        },
      });
      console.log(`\n--- ${tag} ---`);
      for (const turn of full.result?.data ?? []) {
        const items = turn.items ?? [];
        const summarised =
          summary.result?.data.find((entry) => entry.id === turn.id)?.items ??
          [];
        console.log(
          `  turn ${turn.id.slice(-8)} status=${turn.status}` +
            ` fullItems=${items.length} summaryItems=${summarised.length}` +
            ` [${items.map((item) => `${itemType(item)}:${text(item.status)}`).join(' ')}]`,
        );
      }
    };

    const mark = app.mark();
    await app.request({
      method: 'thread/shellCommand',
      params: {
        threadId,
        command: 'echo SLOW_START; sleep 18; echo SLOW_DONE',
      },
    });
    await delay(1_200);

    const before = app.mark();
    await app.request({
      method: 'thread/shellCommand',
      params: {
        threadId,
        command: 'echo QUICK_DONE',
      },
    });
    await delay(3_000);
    const newTurns = app
      .since(before)
      .filter((note) => note.method === 'turn/started').length;
    console.log(
      newTurns === 0
        ? 'quick command joined the running turn'
        : 'quick command opened its own turn',
    );

    await survey('WHILE THE SLOW COMMAND IS STILL RUNNING');

    const expected = newTurns === 0 ? 1 : 2;
    for (let attempt = 0; attempt < 40; attempt++) {
      await delay(1_000);
      const completed = app
        .since(mark)
        .filter((note) => note.method === 'turn/completed').length;
      if (completed >= expected) break;
    }
    await delay(1_200);
    await survey('AFTER EVERYTHING COMPLETED');
  },
};
