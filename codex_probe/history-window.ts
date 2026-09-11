/**
 * Measures newest-page identity against observed shell turns on pinned Codex.
 * Uses an isolated home and an unloaded reader process; no real model is used.
 * Run: pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/history-window.ts
 *
 * A failed prerequisite is INCONCLUSIVE. Missing turns in otherwise successful
 * reads are findings, not assertions that can be changed to make the run pass.
 * This exercises native RPC, not NestJS promise sharing or browser state.
 * On 0.153.2, 139 compared pages matched the observed shell-turn sequence;
 * running headers survived even while the command item was not yet persisted.
 * See README.md for the measured scope and source-only exclusions.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { v2 } from '../src/codex/codex-schema';
import { AppServer } from './harness';
import {
  result,
  report,
  page,
  head,
  open,
  shell,
  storedItems,
  overlap,
  liveBoundary,
  type Page,
} from './history-window-fixture';
import { codexVersion, resolveCodexBin } from './run';

/** Runs stationary reads, a live-only boundary, page turnover, and cold reopening. */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-history-window-'));
  const home = join(directory, 'home');
  const workspace = join(directory, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  let providerRequests = 0;
  const provider = createServer((_request, response) => {
    providerRequests++;
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { message: 'No model required for history-window probe' },
      }),
    );
  });
  await new Promise<void>((done, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', done);
  });
  let owner: AppServer | undefined;
  let reader: AppServer | undefined;
  const mismatches: Array<Record<string, unknown>> = [];
  let samples = 0;
  try {
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    await writeFile(
      join(home, 'config.toml'),
      `model_provider = "probe"\nmodel = "probe"\n[model_providers.probe]\nname = "probe"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
    );
    const bin = resolveCodexBin();
    const version = codexVersion(bin);
    assert.equal(
      version,
      'codex-cli 0.153.2',
      'This measurement targets the pinned version only',
    );
    report({ case: 'setup', version, directory, pageSize: 20 });
    owner = await AppServer.start({ bin, home, cwd: workspace });
    reader = await AppServer.start({ bin, home, cwd: workspace });
    const thread = result(
      await owner.request<v2.ThreadStartResponse>({
        method: 'thread/start',
        params: {
          cwd: workspace,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never',
        },
      }),
    ).thread;
    assert.equal(thread.historyMode, 'paginated');
    const ids: string[] = [];
    let window20: string[] = [];
    let window21: string[] = [];
    let window20At = 0;
    const begin = Date.now();

    /** Compare actual responses with turns whose lifecycle this connection observed. */
    const inspect = (label: string, response: Page) => {
      samples++;
      const expected = ids.slice(-20).reverse();
      const actual = response.data.map((turn) => turn.id);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches.push({
          label,
          expected,
          actual,
          nextCursor: response.nextCursor,
        });
      }
    };

    while (ids.length < 40) {
      const id = await shell(owner, thread.id, `printf TURN_${ids.length + 1}`);
      assert.ok(!ids.includes(id), 'Shell must produce a distinct turn');
      ids.push(id);
      // No pre-read delay or polling: preserve the first read after completion.
      inspect(`immediate-after-${ids.length}`, await head(owner, thread.id));
      const durable = await storedItems(reader, thread.id, id);
      assert.ok(
        durable.some(
          (item) =>
            item.type === 'commandExecution' && item.status === 'completed',
        ),
        'Latest completed shell must be independently durable',
      );
      if (ids.length === 3) {
        const liveId = await liveBoundary(
          owner,
          reader,
          thread.id,
          workspace,
          ids,
        );
        ids.push(liveId);
        inspect('released-live', await head(owner, thread.id));
      }
      if ([4, 20, 21, 40].includes(ids.length)) {
        const readMark = owner.mark();
        const sampleStart = samples;
        const unloaded = result(
          await reader.request<v2.ThreadLoadedListResponse>({
            method: 'thread/loaded/list',
            params: {},
          }),
        );
        assert.ok(
          !unloaded.data.includes(thread.id),
          'Reader must not own a loaded copy',
        );
        const first = await head(owner, thread.id);
        if (ids.length === 20) {
          window20 = first.data.map((turn) => turn.id);
          window20At = Date.now();
        }
        if (ids.length === 21) window21 = first.data.map((turn) => turn.id);
        for (let trial = 0; trial < 8; trial++) {
          // Sequential on purpose: none of these reads supersedes another.
          inspect(
            `stationary-${ids.length}-owner-${trial}`,
            await head(owner, thread.id),
          );
          inspect(
            `stationary-${ids.length}-reader-${trial}`,
            await head(reader, thread.id),
          );
          inspect(
            `stationary-${ids.length}-resume-${trial}`,
            await open(owner, thread.id),
          );
        }
        assert.ok(
          !owner
            .since(readMark)
            .some(
              (note) =>
                note.method === 'turn/started' &&
                note.params.threadId === thread.id,
            ),
          'Stationary control must not advance',
        );
        report({
          case: 'stationary',
          totalTurns: ids.length,
          samples: samples - sampleStart,
          expectedNewestId: ids.at(-1),
          ids: first.data.map((turn) => turn.id),
          nextCursor: first.nextCursor,
          mismatches: mismatches.length,
        });
      }
    }
    const finalPage = await head(owner, thread.id);
    report({
      case: 'turnover',
      totalTurns: ids.length,
      elapsedMs: Date.now() - begin,
      twentyNewTurnsElapsedMs: Date.now() - window20At,
      overlap20To21: overlap(window20, window21),
      overlap20To40: overlap(
        window20,
        finalPage.data.map((turn) => turn.id),
      ),
      idsAt20: window20,
      idsAt40: finalPage.data.map((turn) => turn.id),
    });
    assert.ok(finalPage.nextCursor, 'Forty turns must expose older history');
    const earlier = page(
      result(
        await reader.request<Page>({
          method: 'thread/turns/list',
          params: {
            threadId: thread.id,
            cursor: finalPage.nextCursor,
            limit: 20,
            sortDirection: 'desc',
            itemsView: 'summary',
          },
        }),
      ),
    );
    assert.deepEqual(
      earlier.data.map((turn) => turn.id),
      ids.slice(0, 20).reverse(),
    );
    assert.equal(earlier.nextCursor, null);
    report({
      case: 'paging',
      olderIds: earlier.data.map((turn) => turn.id),
      complete: true,
    });

    const stderr = owner.stderr();
    report({ case: 'owner-exit', ...(await owner.kill('SIGTERM')) });
    owner = undefined;
    inspect('owner-unloaded', await head(reader, thread.id));
    owner = await AppServer.start({ bin, home, cwd: workspace });
    inspect('cold-resume', await open(owner, thread.id));
    inspect('after-cold-resume', await head(owner, thread.id));
    report({
      case: 'cold-reopen',
      ids: (await head(owner, thread.id)).data.map((turn) => turn.id),
    });
    const diagnostics = [stderr, reader.stderr(), owner.stderr()].flatMap(
      (text) =>
        text
          .split('\n')
          .filter((line) =>
            /failed to (record rollout|project durable|project.*rollout)/i.test(
              line,
            ),
          ),
    );
    report({
      case: 'summary',
      samples,
      mismatches,
      providerRequests,
      persistenceDiagnostics: diagnostics,
      verdict: mismatches.length
        ? 'OMISSION_OR_ORDER_CHANGE_OBSERVED'
        : 'NO_OMISSION_IN_MEASURED_READS',
      limits:
        'Healthy paginated shell fixtures only; not a proof for every interleaving, persistence failure, rewrite, backend shared promise, or browser timeline.',
    });
    assert.equal(providerRequests, 0, 'This fixture must not require a model');
  } finally {
    // Stop both children even if the other teardown fails; retain scratch evidence.
    const closed = await Promise.allSettled([
      owner?.kill('SIGTERM'),
      reader?.kill('SIGTERM'),
    ]);
    provider.closeAllConnections();
    await new Promise<void>((done, reject) =>
      provider.close((error) => (error ? reject(error) : done())),
    );
    for (const entry of closed)
      if (entry.status === 'rejected') {
        console.error('INCONCLUSIVE: native teardown failed', entry.reason);
        process.exitCode = 2;
      }
  }
}

void main().catch((error: unknown) => {
  console.error(
    'INCONCLUSIVE:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 2;
});
