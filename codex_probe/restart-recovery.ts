/**
 * Measures crash recovery using isolated goal/no-goal and plain/paged cold resumes.
 * Each case materializes a seed turn with a refusing loopback provider, holds a
 * second request until receipt is observed, then SIGKILLs that app-server. The
 * replacement reads persisted goal state BEFORE its one and only resume. Holding
 * subsequent model requests separates autonomous dispatch from model failure.
 * No real model or account is used. A missing/invalid response fails the probe.
 * Run: pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/restart-recovery.ts
 */
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import type { v2 } from '../src/codex/codex-schema';
import { AppServer, type Note, type RpcReply } from './harness';
import { codexVersion, resolveCodexBin } from './run';

const OBSERVATION_MS = 4_000;
type TurnHeader = { id: string; status: string };

/** RPC failures cannot become a successful negative finding. */
function result<T>(reply: RpcReply<T>): T {
  if (reply.error || !reply.result)
    throw new Error(`Probe request failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

/** Reject malformed turn arrays rather than reporting missing evidence as zero turns. */
function turnStatuses(data: unknown): TurnHeader[] {
  assert.ok(Array.isArray(data), 'Expected an actual turn array');
  return data.map((entry: unknown) => {
    assert.ok(entry !== null && typeof entry === 'object');
    assert.ok(
      'id' in entry && typeof entry.id === 'string' && entry.id.length > 0,
    );
    assert.ok('status' in entry && typeof entry.status === 'string');
    return { id: entry.id, status: entry.status };
  });
}

/** A property present with null is distinct from a populated initial page. */
function initialPage(response: object) {
  if (!('initialTurnsPage' in response))
    return { kind: 'absent', turns: [] as TurnHeader[] };
  const page = response.initialTurnsPage;
  if (page === null) return { kind: 'null', turns: [] as TurnHeader[] };
  assert.ok(page !== null && typeof page === 'object' && 'data' in page);
  return { kind: 'page', turns: turnStatuses(page.data) };
}

/** Match both thread and turn so an autonomous turn cannot satisfy the fixture's start. */
function isTurn(note: Note, method: string, threadId: string, turnId?: string) {
  const turn = note.params.turn as { id?: unknown } | undefined;
  return (
    note.method === method &&
    note.params.threadId === threadId &&
    typeof turn?.id === 'string' &&
    (turnId === undefined || turn.id === turnId)
  );
}

/**
 * Waits until the model-request count stops changing, then returns it.
 *
 * Used after a crash: the dead process's last request can still be delivered,
 * and a baseline taken before that lands turns a timing artifact into a false
 * "the replacement dispatched before attachment".
 *
 * @param count - Reads the current number of model requests received
 * @returns The count once it has held steady
 */
async function settleRequests(count: () => number): Promise<number> {
  const deadline = Date.now() + 10_000;
  let stable = count();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await delay(50);
    const current = count();
    if (current !== stable) {
      stable = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 1_500) {
      return stable;
    }
  }
  return count();
}

/** Bounded receipt wait; elapsed time by itself is not proof a model request arrived. */
async function waitForReceipt(received: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!received() && Date.now() < deadline) await delay(20);
  assert.ok(
    received(),
    'The target model request must reach the hanging provider',
  );
}

/** Each controlled case owns its process pair and home; no warm resume contaminates a cold one. */
async function runCase(
  bin: string,
  withGoal: boolean,
  variant: 'plain' | 'paged',
) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-restart-'));
  const home = join(directory, 'home');
  await mkdir(home);
  let holdRequests = false;
  let heldRequests = 0;
  const held = new Set<ServerResponse>();
  const provider = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end();
      return;
    }
    if (holdRequests) {
      heldRequests++;
      held.add(response);
      response.once('close', () => held.delete(response));
      return;
    }
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { message: 'Probe deliberately refuses model execution' },
      }),
    );
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  let first: AppServer | null = null;
  let second: AppServer | null = null;
  try {
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    await writeFile(
      join(home, 'config.toml'),
      `model_provider = "probe"\nmodel = "probe"\n[model_providers.probe]\nname = "probe"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
    );
    first = await AppServer.start({ bin, home });
    const thread = result(
      await first.request<v2.ThreadStartResponse>({
        method: 'thread/start',
        params: { cwd: directory },
      }),
    ).thread;
    const seed = await first.runTurn(thread.id, 'Restart fixture seed', {
      timeoutMs: 10_000,
    });
    assert.ok(
      seed.completed && seed.turnId,
      'The seed must finish and become persisted',
    );
    assert.ok(
      result(
        await first.request<v2.ThreadListResponse>({
          method: 'thread/list',
          params: { modelProviders: [], limit: 200 },
        }),
      ).data.some((row) => row.id === thread.id),
      'The fixture must be listed before the crash',
    );

    holdRequests = true;
    const mark = first.mark();
    const running = result(
      await first.request<v2.TurnStartResponse>({
        method: 'turn/start',
        params: {
          threadId: thread.id,
          input: [
            { type: 'text', text: 'Restart fixture hang', text_elements: [] },
          ],
        },
      }),
    ).turn;
    assert.equal(running.status, 'inProgress');
    assert.ok(
      await first.waitFor(
        (note) => isTurn(note, 'turn/started', thread.id, running.id),
        { from: mark, timeoutMs: 10_000 },
      ),
    );
    await waitForReceipt(() => heldRequests > 0 && held.size > 0);
    // Set the goal only after the explicit turn is held. Setting it while idle
    // would introduce a competing autonomous dispatch before the intended crash.
    if (withGoal) {
      const goal = result(
        await first.request<v2.ThreadGoalSetResponse>({
          method: 'thread/goal/set',
          params: {
            threadId: thread.id,
            objective: 'Probe goal that must outlive a crash',
            status: 'active',
          },
        }),
      ).goal;
      assert.equal(goal.status, 'active');
    }
    const goalBeforeCrash = result(
      await first.request<v2.ThreadGoalGetResponse>({
        method: 'thread/goal/get',
        params: { threadId: thread.id },
      }),
    ).goal;
    assert.equal(goalBeforeCrash?.status ?? null, withGoal ? 'active' : null);
    const beforeCrash = result(
      await first.request<v2.ThreadReadResponse>({
        method: 'thread/read',
        params: { threadId: thread.id },
      }),
    ).thread;
    assert.equal(beforeCrash.status.type, 'active');
    assert.equal(
      first
        .since(mark)
        .some((note) => isTurn(note, 'turn/completed', thread.id, running.id)),
      false,
    );
    await first.kill();
    for (const response of held) response.destroy();
    held.clear();
    // A request already on the wire when the process died is still delivered to
    // this server afterwards, so the count keeps moving for a moment after exit.
    // Capturing the baseline immediately makes "no dispatch before attachment"
    // race that delivery: the same run passes or fails purely on machine speed.
    // Wait for the count to stop moving, then take the baseline.
    const requestsAtCrash = await settleRequests(() => heldRequests);

    second = await AppServer.start({ bin, home });
    const beforeResume = result(
      await second.request<v2.ThreadReadResponse>({
        method: 'thread/read',
        params: { threadId: thread.id },
      }),
    ).thread;
    assert.equal(beforeResume.status.type, 'notLoaded');
    const goalBeforeResume = result(
      await second.request<v2.ThreadGoalGetResponse>({
        method: 'thread/goal/get',
        params: { threadId: thread.id },
      }),
    ).goal;
    // This establishes persistence without attributing a post-resume mutation
    // (such as blocked after replaying failure evidence) to the crash itself.
    assert.equal(
      goalBeforeResume?.objective ?? null,
      goalBeforeCrash?.objective ?? null,
    );
    assert.equal(
      heldRequests,
      requestsAtCrash,
      'No model request may precede attachment',
    );

    const resumeMark = second.mark();
    const resumed =
      variant === 'plain'
        ? result(
            await second.request<v2.ThreadResumeResponse>({
              method: 'thread/resume',
              params: { threadId: thread.id },
            }),
          )
        : result(
            await second.requestRaw<v2.ThreadResumeResponse>('thread/resume', {
              threadId: thread.id,
              excludeTurns: true,
              initialTurnsPage: {
                limit: 20,
                sortDirection: 'desc',
                itemsView: 'summary',
              },
            }),
          );
    assert.equal(resumed.thread.id, thread.id);
    const page = initialPage(resumed);
    const embedded = turnStatuses(resumed.thread.turns);
    if (variant === 'paged')
      assert.equal(
        page.kind,
        'page',
        'Requested initial page must be populated',
      );
    const responseTurns = variant === 'paged' ? page.turns : embedded;
    const crashedInResponse = responseTurns.find(
      (turn) => turn.id === running.id,
    );
    assert.ok(
      crashedInResponse,
      'The bounded two-turn fixture must include the crashed turn',
    );

    // Negative findings are bounded to this window, never a claim about all
    // future scheduling. Keep the provider hanging so new dispatch cannot be
    // confused with what a refusing model makes that new turn/goal become.
    await delay(OBSERVATION_MS);
    const notes = second.since(resumeMark);
    const started = notes.filter((note) =>
      isTurn(note, 'turn/started', thread.id),
    );
    const startedIds = started.map(
      (note) => (note.params.turn as { id: string }).id,
    );
    const currentTurns = result(
      await second.request<v2.ThreadTurnsListResponse>({
        method: 'thread/turns/list',
        params: {
          threadId: thread.id,
          limit: 20,
          sortDirection: 'desc',
          itemsView: 'notLoaded',
        },
      }),
    ).data;
    const crashedAfterWindow = turnStatuses(currentTurns).find(
      (turn) => turn.id === running.id,
    );
    assert.ok(
      crashedAfterWindow,
      'The crashed turn must remain distinguishable from new work',
    );
    const goalAfterWindow = result(
      await second.request<v2.ThreadGoalGetResponse>({
        method: 'thread/goal/get',
        params: { threadId: thread.id },
      }),
    ).goal;
    const autonomousTurnIds = startedIds.filter((id) => id !== running.id);
    const evidence = {
      withGoal,
      variant,
      historyMode: thread.historyMode,
      observationMs: OBSERVATION_MS,
      crashedTurnId: running.id,
      targetRequestReachedProvider: requestsAtCrash > 0,
      goalBeforeCrash: goalBeforeCrash?.status ?? null,
      goalBeforeResume: goalBeforeResume?.status ?? null,
      initialTurnsPageKind: page.kind,
      initialTurnsPageCount: page.turns.length,
      embeddedTurnCount: embedded.length,
      crashedTurnStatusInResponse: crashedInResponse.status,
      crashedTurnStatusAfterWindow: crashedAfterWindow.status,
      crashedTurnStartedAgain: startedIds.includes(running.id),
      autonomousTurnIds,
      newModelRequests: heldRequests - requestsAtCrash,
      goalAfterWindow: goalAfterWindow?.status ?? null,
      goalNotifications: notes.filter(
        (note) =>
          note.params.threadId === thread.id &&
          note.method.startsWith('thread/goal/'),
      ),
      notificationMethods: notes.map((note) => note.method),
    };
    console.log(JSON.stringify(evidence, null, 2));
    console.log(
      `OBSERVED goal=${withGoal} resume=${variant} old-turn=${crashedAfterWindow.status} new-turns-in-${OBSERVATION_MS}ms=${autonomousTurnIds.length}`,
    );
    return evidence;
  } finally {
    // Await termination before disposing provider connections or starting the
    // next case. Earlier probes still retain their existing close() behavior.
    try {
      await Promise.all([first?.kill(), second?.kill()]);
    } finally {
      for (const response of held) response.destroy();
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

async function main(): Promise<void> {
  const bin = resolveCodexBin();
  console.log(codexVersion(bin));
  for (const withGoal of [false, true]) {
    for (const variant of ['plain', 'paged'] as const)
      await runCase(bin, withGoal, variant);
  }
  console.log(
    'Completed four isolated cases. Findings cover a persisted root thread, a failed seed, and a model request stalled before any response; not tools, approvals, owner-controlled children, or every crash boundary.',
  );
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
