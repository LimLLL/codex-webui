/**
 * Does a mid-conversation security policy change reach a REAL model turn?
 *
 * Every earlier measurement used `thread/shellCommand`, which runs unsandboxed
 * by design and never raises an approval — so it could show that
 * `thread/settings/update` is accepted, but never that a model tool call obeys
 * the new policy. That gap is exactly where the original defect lived: the UI
 * promised full access and the agent still asked for approval.
 *
 * Result on 0.153.2: on-request/read-only asked for approval; after the update
 * to never/danger-full-access the same task ran without asking. The
 * `thread/settings/updated` notification carries the full effective settings,
 * which is why a client can settle a pending selection from it rather than
 * treating it as a bare change hint.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { itemType, type TurnRun } from '../harness';
import type { Probe } from '../run';

const WRITE_TASK =
  'Run a shell command that writes the word HELLO into a file named probe.txt in the current directory. Do it now, do not ask me anything.';
const SECOND_TASK =
  'Now run a shell command that writes the word WORLD into a file named probe2.txt in the current directory. Do it now, do not ask me anything.';

/**
 * Requires both a successful terminal turn and the requested filesystem effect.
 * Zero approval requests from a refused, timed-out or idle turn prove nothing.
 * @param turn - Captured model turn
 * @param file - File the task was asked to write in the throwaway workspace
 * @param expected - Expected file content, ignoring the shell's final newline
 * @returns Whether the turn actually completed the requested task
 */
async function completedWrite(
  turn: TurnRun,
  file: string,
  expected: string,
): Promise<boolean> {
  if (turn.error || !turn.completed || !turn.turnId) return false;
  const succeeded = turn.events.some((note) => {
    const terminal = note.params.turn as
      | { id?: string; status?: string }
      | undefined;
    return (
      note.method === 'turn/completed' &&
      terminal?.id === turn.turnId &&
      terminal?.status === 'completed'
    );
  });
  if (!succeeded) return false;
  try {
    return (await readFile(file, 'utf8')).trim() === expected;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

export const livePolicy: Probe = {
  name: 'live-policy',
  question:
    'Is a mid-conversation approval/sandbox change consumed by the next real model turn?',
  needsModel: true,
  run: async ({ app, workspace }) => {
    const start = await app.request<{ thread: { id: string } }>({
      method: 'thread/start',
      params: {
        cwd: workspace,
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
      },
    });
    if (start.error || !start.result) {
      console.log(`thread/start failed: ${JSON.stringify(start.error)}`);
      return;
    }
    const threadId = start.result.thread.id;
    console.log(`thread started on on-request / read-only`);

    const before = await app.runTurn(threadId, WRITE_TASK);
    if (
      !(await completedWrite(
        before,
        path.join(workspace, 'probe.txt'),
        'HELLO',
      ))
    ) {
      console.log(
        'INCONCLUSIVE — the first turn did not complete the requested write',
      );
      return;
    }
    const approvalsBefore = before.requests.filter((request) =>
      request.method.endsWith('requestApproval'),
    );
    console.log(`phase 1 approvals requested: ${approvalsBefore.length}`);

    const mark = app.mark();
    // `requestRaw`: the pinned schema does not export this method, though the
    // binary implements it. That absence is itself one of this probe's findings.
    const update = await app.requestRaw('thread/settings/update', {
      threadId,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    console.log(
      `settings update: ${update.error ? `ERROR ${JSON.stringify(update.error)}` : 'ok'}`,
    );
    if (update.error) {
      console.log('INCONCLUSIVE — the policy patch was refused');
      return;
    }
    // A matching effective-settings notification is the evidence needed before
    // the second turn. A fixed sleep or an unrelated settings event is not.
    const settingsNote = await app.waitFor(
      (note) => {
        const settings = note.params.threadSettings as
          | Record<string, unknown>
          | undefined;
        const sandbox = settings?.sandboxPolicy as
          | { type?: string }
          | undefined;
        return (
          note.method === 'thread/settings/updated' &&
          note.params.threadId === threadId &&
          settings?.approvalPolicy === 'never' &&
          sandbox?.type === 'dangerFullAccess'
        );
      },
      { from: mark, timeoutMs: 5_000 },
    );
    console.log(
      `thread/settings/updated fired: ${settingsNote ? 'YES' : 'NO'}`,
    );
    if (settingsNote) {
      const settings = settingsNote.params.threadSettings as Record<
        string,
        unknown
      >;
      console.log(`  keys: ${Object.keys(settings).join(', ')}`);
      console.log(
        `  approvalPolicy: ${JSON.stringify(settings.approvalPolicy)}`,
      );
      console.log(`  sandboxPolicy: ${JSON.stringify(settings.sandboxPolicy)}`);
    } else {
      console.log('INCONCLUSIVE — no matching effective policy was observed');
      return;
    }

    const after = await app.runTurn(threadId, SECOND_TASK);
    if (
      !(await completedWrite(
        after,
        path.join(workspace, 'probe2.txt'),
        'WORLD',
      ))
    ) {
      console.log(
        'INCONCLUSIVE — the second turn did not complete the requested write',
      );
      return;
    }
    const approvalsAfter = after.requests.filter((request) =>
      request.method.endsWith('requestApproval'),
    );
    console.log(`phase 2 approvals requested: ${approvalsAfter.length}`);

    console.log('\nVERDICT');
    console.log(
      approvalsBefore.length > 0 && approvalsAfter.length === 0
        ? '  mid-conversation policy change IS consumed by a real turn'
        : '  INCONCLUSIVE — see the counts above',
    );

    // Ordering on an ordinary serial turn, for contrast with the overlap case
    // measured by the item-ordering probe.
    const startedOrder = after.events
      .filter((note) => note.method === 'item/started')
      .map((note) => itemType(note.params.item));
    const completedOrder = after.events
      .filter((note) => note.method === 'item/completed')
      .map((note) => itemType(note.params.item));
    const full = await app.request<{
      data: Array<{ id: string; items: unknown[] }>;
    }>({
      method: 'thread/turns/list',
      params: {
        threadId,
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'full',
      },
    });
    const summary = await app.request<{
      data: Array<{ id: string; items: unknown[] }>;
    }>({
      method: 'thread/turns/list',
      params: {
        threadId,
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'summary',
      },
    });
    const persisted = full.result?.data.find(
      (turn) => turn.id === after.turnId,
    );
    const summarised = summary.result?.data.find(
      (turn) => turn.id === after.turnId,
    );
    console.log('\nORDER / VIEW on this turn');
    console.log(`  live started   : [${startedOrder.join(', ')}]`);
    console.log(`  live completed : [${completedOrder.join(', ')}]`);
    console.log(
      `  persisted full : [${(persisted?.items ?? []).map(itemType).join(', ')}]`,
    );
    console.log(`  summary items  : ${(summarised?.items ?? []).length}`);
  },
};
