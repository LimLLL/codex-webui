/**
 * Checks whether a completed shell turn changes after another shell turn and a
 * resume of the still-loaded thread, using the pinned binary and full payloads.
 *
 * This is a narrow control experiment, not proof that every completed turn is
 * immutable. It does not exercise model turns or late subAgentActivity items
 * attributed to a completed parent, nor a cold reload from the rollout.
 */
import { isDeepStrictEqual } from 'node:util';
import { delay } from '../harness';
import type { Probe } from '../run';

interface TurnHeader {
  id: string;
  status: string;
  items?: Array<Record<string, unknown>>;
}

export const turnItemFinality: Probe = {
  name: 'turn-item-finality',
  question:
    'Does a completed shell turn change across another shell turn and a loaded resume?',
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

    /** Reads one turn's full items, or undefined when the turn is absent. */
    const readTurn = async (
      turnId: string,
    ): Promise<TurnHeader | undefined> => {
      const page = await app.request<{ data: TurnHeader[] }>({
        method: 'thread/turns/list',
        params: {
          threadId,
          limit: 20,
          sortDirection: 'desc',
          itemsView: 'full',
        },
      });
      if (page.error) return undefined;
      return page.result?.data.find((turn) => turn.id === turnId);
    };

    /** Runs one shell command and waits for its turn to complete. */
    const runCommand = async (command: string): Promise<string | undefined> => {
      const mark = app.mark();
      const response = await app.request({
        method: 'thread/shellCommand',
        params: { threadId, command },
      });
      if (response.error) return undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        await delay(1_000);
        const done = app
          .since(mark)
          .find((note) => note.method === 'turn/completed');
        if (done) {
          const turn = done.params.turn as { id?: string } | undefined;
          return turn?.id;
        }
      }
      return undefined;
    };

    const firstTurnId = await runCommand('echo FIRST_ONE; echo FIRST_TWO');
    if (!firstTurnId) {
      console.log('INCONCLUSIVE — the first turn never completed');
      return;
    }
    await delay(1_000);

    const before = await readTurn(firstTurnId);
    if (!before || before.status !== 'completed' || !before.items?.length) {
      console.log('INCONCLUSIVE — the first turn is not readable as completed');
      return;
    }
    const beforePrint = JSON.stringify(before.items);
    console.log(`turn ${firstTurnId.slice(-8)} status=${before.status}`);
    console.log(`  items right after completion : ${beforePrint}`);

    // Compare the entire original payload after a later shell turn.
    const secondTurnId = await runCommand('echo SECOND');
    if (!secondTurnId) {
      console.log('INCONCLUSIVE — the second turn never completed');
      return;
    }
    await delay(1_500);

    const afterTurn = await readTurn(firstTurnId);
    const afterTurnPrint = JSON.stringify(afterTurn?.items);
    console.log(`  items after a later turn ran : ${afterTurnPrint}`);

    // This resumes an already-loaded thread. It does not test cold replay.
    const resumed = await app.request({
      method: 'thread/resume',
      params: { threadId, excludeTurns: true },
    });
    console.log(
      `  thread/resume: ${resumed.error ? `ERR ${JSON.stringify(resumed.error)}` : 'ok'}`,
    );
    if (resumed.error || !resumed.result) {
      console.log('INCONCLUSIVE — resume did not succeed');
      return;
    }
    await delay(1_000);
    const afterResume = await readTurn(firstTurnId);
    const afterResumePrint = JSON.stringify(afterResume?.items);
    console.log(`  items after resume           : ${afterResumePrint}`);

    console.log('\nVERDICT');
    if (
      afterTurn?.status !== 'completed' ||
      !afterTurn.items ||
      afterResume?.status !== 'completed' ||
      !afterResume.items
    ) {
      console.log(
        '  INCONCLUSIVE — the completed turn stopped being readable at all',
      );
      return;
    }
    const stable =
      isDeepStrictEqual(before.items, afterTurn.items) &&
      isDeepStrictEqual(before.items, afterResume.items);
    console.log(
      stable
        ? "  This shell turn's full item payloads were unchanged across a later\n" +
            '  shell turn and loaded resume. Model/subagent finality remains unmeasured.'
        : "  A completed turn's items CHANGED afterwards — an indefinite cache of\n" +
            '  that read will show a stale transcript. See the three lines above.',
    );
  },
};
