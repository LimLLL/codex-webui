/**
 * Measures whether conversation metadata can be maintained from notifications
 * instead of re-enumerating the stored list on every turn.
 *
 * The shared overview collection currently re-walks both archive partitions
 * whenever a turn starts or completes. Those notifications carry only a turn,
 * so the question is what they imply about the conversation row: does turn
 * activity move `updatedAt`, and is a status notification emitted alongside it?
 *
 * Run: pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/metadata-incremental.ts
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import type { v2 } from '../src/codex/codex-schema';
import { AppServer, type RpcReply } from './harness';
import { codexVersion, resolveCodexBin } from './run';

/** A failed setup or read is inconclusive and must never print a passing verdict. */
function result<T>(reply: RpcReply<T>): T {
  if (reply.error || !reply.result)
    throw new Error(`Probe request failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-metadata-incr-'));
  const home = join(directory, 'home');
  await mkdir(home);
  const provider = createServer((_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { message: 'Probe deliberately refuses model execution' },
      }),
    );
  });
  await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
  const address = provider.address();
  if (!address || typeof address === 'string')
    throw new Error('Loopback provider failed to start');
  await writeFile(
    join(home, 'config.toml'),
    `model_provider = "probe"\nmodel = "probe"\n[model_providers.probe]\nname = "probe"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
  );
  const bin = resolveCodexBin();
  console.log(codexVersion(bin));
  const app = await AppServer.start({ bin, home });
  try {
    const thread = result(
      await app.request<v2.ThreadStartResponse>({
        method: 'thread/start',
        params: { cwd: directory },
      }),
    ).thread;

    const initiallyListed = result(
      await app.request<v2.ThreadListResponse>({
        method: 'thread/list',
        params: { modelProviders: [], limit: 200 },
      }),
    ).data.some((row) => row.id === thread.id);

    const read = async () => {
      const listed = result(
        await app.request<v2.ThreadListResponse>({
          method: 'thread/list',
          params: { modelProviders: [], limit: 200 },
        }),
      ).data.find((row) => row.id === thread.id);
      assert.ok(listed, 'The fixture must stay listable');
      return listed;
    };

    // A started thread is not yet listable: the stored list only carries
    // conversations with persisted content, so the baseline needs one turn
    // before `updatedAt` can be compared across a second one.
    const seed = await app.runTurn(thread.id, 'Metadata baseline fixture', {
      timeoutMs: 10_000,
    });
    assert.equal(seed.completed, true, 'The seed turn must persist');
    const before = await read();
    // Thread timestamps have SECOND precision. Two immediate failed turns can
    // look unchanged merely because both updates fell in the same second.
    await delay(1_200);
    const mark = app.mark();
    const run = await app.runTurn(thread.id, 'Metadata increment fixture', {
      timeoutMs: 10_000,
    });
    assert.equal(run.completed, true, 'The fixture must persist a real turn');
    const after = await read();

    const notes = app.since(mark);
    const methods = notes.map((note) => note.method);
    const statusNotes = notes.filter(
      (note) => note.method === 'thread/status/changed',
    );

    // Question 1: does turn activity move the row the sidebar sorts on?
    const updatedAtMoved = after.updatedAt !== before.updatedAt;
    // Question 2: is a status notification emitted around the turn at all?
    const hasStatusNotification = statusNotes.length > 0;
    // Question 3: do the turn notifications carry any conversation fields?
    const turnNote = notes.find((note) => note.method === 'turn/completed');
    const turnNoteKeys = Object.keys(turnNote?.params ?? {}).sort();

    console.log(
      JSON.stringify(
        {
          initiallyListed,
          updatedAtBefore: before.updatedAt,
          updatedAtAfter: after.updatedAt,
          updatedAtMoved,
          updatedAtDeltaSeconds: after.updatedAt - before.updatedAt,
          turnOutcome: (turnNote?.params.turn as v2.Turn | undefined)?.status,
          statusNotificationCount: statusNotes.length,
          statusValues: statusNotes.map(
            (note) =>
              (note.params as { status?: { type?: string } }).status?.type,
          ),
          turnCompletedParamKeys: turnNoteKeys,
          methodsAroundTurn: methods,
        },
        null,
        2,
      ),
    );

    console.log(
      `VERDICT updatedAt-moves-on-turn=${updatedAtMoved} status-notification-emitted=${hasStatusNotification}`,
    );
    if (updatedAtMoved && !hasStatusNotification) {
      console.log(
        'CONSEQUENCE: turn notifications cannot be dropped from metadata invalidation without making updated_at ordering stale until the next periodic discovery.',
      );
    }
    if (updatedAtMoved && hasStatusNotification) {
      console.log(
        'CONSEQUENCE: status notifications accompany turn activity, so invalidation can key on status alone only if updatedAt is separately repaired.',
      );
    }
    if (!updatedAtMoved) {
      console.log(
        'CONSEQUENCE: this refused-provider turn did not move updatedAt; this does not establish the behavior of successful turns.',
      );
    }
  } finally {
    app.close();
    provider.closeAllConnections();
    provider.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
