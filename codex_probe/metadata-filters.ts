/**
 * Measures the metadata needed by the shared overview projection on the pinned CLI.
 * Uses a temporary Codex home and a loopback provider that deliberately rejects
 * generation: real user-message persistence without calling or paying a model.
 * Run: pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/metadata-filters.ts
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import type { v2 } from '../src/codex/codex-schema';
import { AppServer, type RpcReply } from './harness';
import { codexVersion, resolveCodexBin } from './run';

/** A failed setup or read is inconclusive and must never print a passing verdict. */
function result<T>(reply: RpcReply<T>): T {
  if (reply.error || !reply.result)
    throw new Error(`Probe request failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

/** Runs only protocol operations and compares native filtering and ordering with the proposed local rules. */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-metadata-filter-'));
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
  let peer: AppServer | undefined;
  try {
    const first = result(
      await app.request<v2.ThreadStartResponse>({
        method: 'thread/start',
        params: { cwd: directory },
      }),
    ).thread;
    const run = await app.runTurn(
      first.id,
      `MetadataPreview_Mixed ${'x'.repeat(600)} HiddenNeedleAtEnd`,
      { timeoutMs: 10_000 },
    );
    assert.equal(
      run.completed,
      true,
      'The fixture must persist a real terminal turn',
    );
    result(
      await app.request({
        method: 'thread/name/set',
        params: { threadId: first.id, name: 'Alpha_BETA % café' },
      }),
    );
    const list = async (params: v2.ThreadListParams = {}) =>
      result(
        await app.request<v2.ThreadListResponse>({
          method: 'thread/list',
          params: { modelProviders: [], limit: 200, ...params },
        }),
      ).data;
    const baseline = (await list()).find((thread) => thread.id === first.id);
    assert.ok(baseline, 'A listable fixture is required');
    for (const searchTerm of [
      'Alpha',
      'alpha',
      'BETA',
      'beta',
      '_',
      '%',
      'café',
      'CAFÉ',
      'MetadataPreview',
      'Alpha%',
      'not%there',
      'HiddenNeedleAtEnd',
      '   ',
      '',
    ]) {
      const actual = (await list({ searchTerm })).some(
        (thread) => thread.id === first.id,
      );
      const expected: boolean =
        baseline.preview.includes(searchTerm) ||
        Boolean(baseline.name?.includes(searchTerm));
      assert.equal(
        actual,
        expected,
        `searchTerm=${JSON.stringify(searchTerm)}`,
      );
    }
    const relativeCwd = relative(process.cwd(), directory);
    assert.equal(resolve(relativeCwd), directory);
    assert.ok(
      (await list({ cwd: relativeCwd })).some(
        (thread) => thread.id === first.id,
      ),
    );
    console.log(
      'PASS: literal case-sensitive name OR preview matching, including renamed and long previews; relative cwd matching',
    );

    peer = await AppServer.start({ bin, home });
    const mark = app.mark();
    const fork = result(
      await peer.requestRaw<v2.ThreadForkResponse>('thread/fork', {
        threadId: first.id,
        excludeTurns: true,
      }),
    ).thread;
    const peerRun = await peer.runTurn(fork.id, 'External metadata fixture', {
      timeoutMs: 10_000,
    });
    assert.equal(
      peerRun.completed,
      true,
      'The external fork must become listable',
    );
    const discovered = (await list()).find((thread) => thread.id === fork.id);
    assert.ok(
      discovered,
      'Normal discovery must find an externally created fork',
    );
    const header = fork.path
      ? (JSON.parse((await readFile(fork.path, 'utf8')).split('\n')[0]) as {
          payload?: { forked_from_id?: string };
        })
      : null;
    console.log(
      JSON.stringify({
        historyMode: first.historyMode,
        returnedParent: fork.forkedFromId,
        listedParent: discovered.forkedFromId,
        headerParent: header?.payload?.forked_from_id,
        expectedParent: first.id,
      }),
    );
    const pushed = app
      .since(mark)
      .some(
        (note) =>
          note.method === 'thread/started' &&
          (note.params.thread as { id?: string } | undefined)?.id === fork.id,
      );
    console.log(
      `PASS: external fork discovered by thread/list; creation event on first transport=${pushed}`,
    );

    for (const sortKey of ['created_at', 'updated_at'] as const) {
      const actual = await list({ sortKey });
      const field = sortKey === 'created_at' ? 'createdAt' : 'updatedAt';
      const expected = [...actual].sort(
        (a, b) => b[field] - a[field] || b.id.localeCompare(a.id),
      );
      assert.deepEqual(
        actual.map((thread) => thread.id),
        expected.map((thread) => thread.id),
      );
      console.log(
        `PASS: ${sortKey} ordering for ${actual.length} threads (ties=${actual.some((thread, index) => index > 0 && thread[field] === actual[index - 1][field])})`,
      );
    }
  } finally {
    peer?.close();
    app.close();
    provider.closeAllConnections();
    provider.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
