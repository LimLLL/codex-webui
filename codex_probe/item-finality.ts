/**
 * Measures completed-item stability across cold replay or a deliberately held child.
 * Run with `cold` or `late`; both use the configured provider and spend tokens.
 * Each run owns its home and workspace. Missing fixture evidence is inconclusive,
 * never proof of finality. RPC deadlines do not release the child's held tool.
 */
import { strict as assert } from 'node:assert';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppServer, HOLD, delay, type Note, type RpcReply } from './harness';
import { CONFIG_PATH, codexVersion, resolveCodexBin } from './run';
import type { v2 } from '../src/codex/codex-schema';

const EVENT_DEADLINE_MS = 180_000;

/** Rejects failed or absent RPC replies instead of interpreting them as empty history. */
function result<T>(reply: RpcReply<T>): T {
  if (reply.error || reply.result === undefined)
    throw new Error(`RPC failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

/** Creates a disposable, provider-configured home without modifying the user's config. */
async function directories() {
  const root = await mkdtemp(join(tmpdir(), 'codex-item-finality-'));
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  await mkdir(home);
  await mkdir(cwd);
  await copyFile(CONFIG_PATH, join(home, 'config.toml'));
  return { home, cwd };
}

/** Matches exact thread/turn identity; another turn cannot satisfy the fixture. */
function turnEvent(note: Note, threadId: string, turnId: string): boolean {
  return (
    note.method === 'turn/completed' &&
    note.params.threadId === threadId &&
    (note.params.turn as { id?: string } | undefined)?.id === turnId
  );
}

/** Requires a successful model turn, not just a terminal notification. */
async function completeTurn(
  app: AppServer,
  threadId: string,
  prompt: string,
): Promise<string> {
  const run = await app.runTurn(threadId, prompt, {
    timeoutMs: EVENT_DEADLINE_MS,
  });
  assert.ok(run.turnId && run.completed, 'Model turn did not complete');
  const done = run.events.find((note) =>
    turnEvent(note, threadId, run.turnId!),
  );
  assert.equal(
    (done?.params.turn as { status?: string })?.status,
    'completed',
    'Model turn did not succeed',
  );
  return run.turnId;
}

/**
 * Reads every item page and cross-checks the full turn view.
 * Both APIs must return the exact completed turn and agree on its item payloads.
 * Cursor limits or malformed pages fail the read, never imply completeness.
 */
async function snapshot(app: AppServer, threadId: string, turnId: string) {
  const items: v2.ThreadItem[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const response: v2.ThreadItemsListResponse = result(
      await app.request<v2.ThreadItemsListResponse>({
        method: 'thread/items/list',
        params: { threadId, turnId, limit: 2, sortDirection: 'asc', cursor },
      }),
    );
    assert.ok(Array.isArray(response.data), 'Missing item page');
    for (const entry of response.data) {
      assert.equal(entry.turnId, turnId);
      items.push(entry.item);
    }
    assert.ok(
      response.nextCursor === null || typeof response.nextCursor === 'string',
    );
    cursor = response.nextCursor;
    if (cursor === null) break;
    assert.ok(!seen.has(cursor), 'Repeated item cursor');
    seen.add(cursor);
  }
  assert.equal(cursor, null, 'Item page budget exhausted');
  const turns = result(
    await app.request<v2.ThreadTurnsListResponse>({
      method: 'thread/turns/list',
      params: { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' },
    }),
  );
  const turn = turns.data.find((entry) => entry.id === turnId);
  assert.ok(turn, 'Target turn absent from full turn view');
  assert.equal(turn.status, 'completed');
  assert.deepEqual(items, turn.items, 'Item and full-turn views disagree');
  return items;
}

/** Prints identity, ordering and payload differences separately, with full payload evidence. */
function comparison(
  label: string,
  before: v2.ThreadItem[],
  after: v2.ThreadItem[],
) {
  const ids = (items: v2.ThreadItem[]) => items.map((item) => item.id);
  const same = isDeepStrictEqual(before, after);
  console.log(
    JSON.stringify({
      label,
      equal: same,
      beforeIds: ids(before),
      afterIds: ids(after),
      before,
      after,
    }),
  );
  return same;
}

/** Tests graceful and abrupt process replacement independently of subagent cooperation. */
async function cold(bin: string): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const dirs = await directories();
    let app = await AppServer.start({ bin, ...dirs });
    try {
      const { thread } = result(
        await app.request<v2.ThreadStartResponse>({
          method: 'thread/start',
          params: {
            cwd: dirs.cwd,
            approvalPolicy: 'never',
            sandbox: 'read-only',
          },
        }),
      );
      const turnId = await completeTurn(
        app,
        thread.id,
        'Reply with exactly COLD_FINALITY_CONTROL. Do not use tools or delegate.',
      );
      const before = await snapshot(app, thread.id, turnId);
      assert.ok(before.length > 0, 'Empty control is not a useful measurement');
      console.log(JSON.stringify({ nativeExit: await app.kill(signal) }));
      app = await AppServer.start({ bin, ...dirs });
      const beforeResume = await snapshot(app, thread.id, turnId);
      result(
        await app.request({
          method: 'thread/resume',
          params: { threadId: thread.id, excludeTurns: true },
        }),
      );
      const afterResume = await snapshot(app, thread.id, turnId);
      const readStable = comparison(
        `${signal}:cold-read`,
        before,
        beforeResume,
      );
      const resumeStable = comparison(
        `${signal}:cold-resume`,
        before,
        afterResume,
      );
      console.log(
        JSON.stringify({
          verdict: readStable && resumeStable ? 'STABLE_CONTROL' : 'CHANGED',
          signal,
          threadId: thread.id,
          turnId,
        }),
      );
    } finally {
      await app.kill();
    }
  }
}

/**
 * Spawns one real child and withholds only its explicit wait-tool response.
 * The baseline is read after parent completion, before releasing that child.
 * A failed prerequisite leaves the operation held until process cleanup.
 */
async function late(bin: string, attempt: number): Promise<boolean> {
  const dirs = await directories();
  let app = await AppServer.start({
    bin,
    ...dirs,
    onServerRequest: (request) =>
      request.method === 'item/tool/call' ? HOLD : {},
  });
  let stage = 'start-parent';
  try {
    const params: v2.ThreadStartParams & {
      dynamicTools: v2.DynamicToolSpec[];
    } = {
      cwd: dirs.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      dynamicTools: [
        {
          type: 'function',
          name: 'finality_wait',
          description:
            'Child-only measurement barrier. Call once, wait for its response, then return CHILD_DONE. The parent must not call this tool.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
    };
    const { thread } = result(
      await app.requestRaw<v2.ThreadStartResponse>('thread/start', params),
    );
    const started = result(
      await app.request<v2.TurnStartResponse>({
        method: 'turn/start',
        params: {
          threadId: thread.id,
          input: [
            {
              type: 'text',
              text_elements: [],
              text: 'This is an explicitly authorized subagent timing experiment. Spawn exactly one child named finality_child, inheriting the tools. Tell it to call finality_wait once, await its response, then reply CHILD_DONE. You, the parent, must finish immediately after spawning with PARENT_DONE, WITHOUT waiting for the child or calling finality_wait yourself. Returning before the child completes is the required outcome of this experiment. Do not perform other work or spawn additional children.',
            },
          ],
        },
      }),
    );
    stage = 'child-wait-request';
    const held = await app.waitForRequest(
      (request) =>
        request.method === 'item/tool/call' &&
        request.params.tool === 'finality_wait' &&
        request.params.threadId !== thread.id,
      { timeoutMs: EVENT_DEADLINE_MS },
    );
    assert.ok(held, 'No child reached the controlled wait tool');
    const childId = String(held.params.threadId);
    const child = result(
      await app.request<v2.ThreadReadResponse>({
        method: 'thread/read',
        params: { threadId: childId },
      }),
    );
    assert.equal(
      child.thread.parentThreadId,
      thread.id,
      'Wait caller is not an owned child',
    );
    stage = 'parent-completed-before-release';
    const done = await app.waitFor(
      (note) => turnEvent(note, thread.id, started.turn.id),
      { timeoutMs: EVENT_DEADLINE_MS },
    );
    assert.ok(done, 'Parent did not finish while child was held');
    assert.equal((done.params.turn as { status: string }).status, 'completed');
    stage = 'complete-baseline';
    const before = await snapshot(app, thread.id, started.turn.id);
    assert.ok(
      app.held().some((request) => request.id === held.id),
      'Child wait was not held',
    );
    if (attempt === 2)
      await completeTurn(
        app,
        thread.id,
        'Reply LATER_PARENT_CONTROL without waiting for or interacting with the child.',
      );
    stage = 'release-and-child-success';
    app.release(held.id, {
      success: true,
      contentItems: [
        { type: 'inputText', text: 'Barrier released; reply CHILD_DONE now.' },
      ],
    } satisfies v2.DynamicToolCallResponse);
    const childDone = await app.waitFor(
      (note) => turnEvent(note, childId, String(held.params.turnId)),
      { timeoutMs: EVENT_DEADLINE_MS },
    );
    assert.ok(childDone, 'Child did not complete after release');
    assert.equal(
      (childDone.params.turn as { status: string }).status,
      'completed',
    );
    stage = 'late-parent-activity';
    const activity = await app.waitFor(
      (note) => {
        const item = note.params.item as
          | { type?: string; kind?: string; agentThreadId?: string }
          | undefined;
        return (
          note.method === 'item/completed' &&
          note.params.threadId === thread.id &&
          note.params.turnId === started.turn.id &&
          item?.type === 'subAgentActivity' &&
          item.kind === 'completed' &&
          item.agentThreadId === childId
        );
      },
      { timeoutMs: 10_000 },
    );
    // An absent activity leaves `before` and `after` trivially equal, which
    // reads exactly like measured stability. The two are different results and
    // the fixture must not be able to report the weaker one as the stronger:
    // no activity means this run never reached the question being asked.
    assert.ok(
      activity,
      'Child succeeded but no completion activity reached the parent turn',
    );
    await delay(1_000);
    const after = await snapshot(app, thread.id, started.turn.id);
    const same = comparison('late-child', before, after);
    const activityStart = app.notes.find(
      (note) =>
        note.method === 'item/started' &&
        note.params.threadId === thread.id &&
        note.params.turnId === started.turn.id &&
        (note.params.item as { id?: string } | undefined)?.id ===
          (activity.params.item as { id: string }).id,
    );
    assert.ok(
      activityStart,
      'Completion activity was not preceded by its start',
    );
    assert.ok(
      activityStart.arrival > done.arrival &&
        activityStart.arrival < activity.arrival,
      'Late activity did not arrive after the parent turn completed',
    );
    assert.equal(
      (activity.params.item as { id: string }).id,
      `subagent-completed-${String(held.params.turnId)}`,
    );
    // Reaching here means an item was appended to a turn that had already
    // completed, so equality would contradict the observed notifications.
    assert.ok(!same, 'Observed a late item the history read does not show');
    console.log(
      JSON.stringify({
        verdict: 'LATE_APPEND_TO_COMPLETED_TURN',
        attempt,
        threadId: thread.id,
        parentTurnId: started.turn.id,
        childId,
        waitArrival: held.arrival,
        parentDoneArrival: done.arrival,
        childDoneArrival: childDone.arrival,
        lateActivityStart: activityStart,
        lateActivity: activity,
        observationMs: 11_000,
      }),
    );
    stage = 'late-items-cold-replay';
    console.log(JSON.stringify({ nativeExit: await app.kill() }));
    app = await AppServer.start({ bin, ...dirs });
    const coldItems = await snapshot(app, thread.id, started.turn.id);
    result(
      await app.request({
        method: 'thread/resume',
        params: { threadId: thread.id, excludeTurns: true },
      }),
    );
    const resumedItems = await snapshot(app, thread.id, started.turn.id);
    comparison('late-child:cold-read', after, coldItems);
    comparison('late-child:cold-resume', after, resumedItems);
    return true;
  } catch (error) {
    console.log(
      JSON.stringify({
        verdict: 'INCONCLUSIVE',
        attempt,
        stage,
        reason: error instanceof Error ? error.message : String(error),
        events: app.notes.filter((note) =>
          [
            'thread/started',
            'turn/completed',
            'item/completed',
            'error',
          ].includes(note.method),
        ),
        heldRequests: app.held(),
      }),
    );
    return false;
  } finally {
    await app.kill();
  }
}

/** Runs one experiment family at a time; model fixture failures remain visible in the exit status. */
async function main(): Promise<void> {
  const bin = resolveCodexBin();
  console.log(codexVersion(bin));
  const mode = process.argv[2];
  if (mode === 'cold') return cold(bin);
  assert.equal(mode, 'late', 'Expected cold or late');
  let conclusive = 0;
  for (let attempt = 1; attempt <= 3; attempt++)
    if (await late(bin, attempt)) conclusive++;
  console.log(JSON.stringify({ conclusive, attempts: 3 }));
  if (conclusive === 0) process.exitCode = 2;
}

void main().catch((error: unknown) => {
  console.error(
    'INCONCLUSIVE',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 2;
});
