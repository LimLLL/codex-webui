/**
 * Measures independent cold reattachments over the pinned stdio transport.
 * Seeds persisted shell history without model calls, then compares bounds
 * 1/2/4/8 with rotating order and a fresh process per sample. Seeding is excluded.
 * No production limiter is justified by this probe unless a repeatable gain is observed.
 * Run: pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/recovery-concurrency.ts
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppServer, type RpcReply } from './harness';
import { codexVersion, resolveCodexBin } from './run';
import type { v2 } from '../src/codex/codex-schema';

/** A missing result or refusal invalidates a timing sample. */
function result<T>(reply: RpcReply<T>): T {
  if (reply.error || reply.result === undefined)
    throw new Error(`Benchmark RPC failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

/** Creates listable threads with two persisted shell turns, without invoking a model. */
async function seed(
  app: AppServer,
  cwd: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const { thread } = result(
      await app.request<v2.ThreadStartResponse>({
        method: 'thread/start',
        params: { cwd, approvalPolicy: 'never', sandbox: 'read-only' },
      }),
    );
    ids.push(thread.id);
    for (let turn = 0; turn < 2; turn++) {
      const from = app.mark();
      result(
        await app.request({
          method: 'thread/shellCommand',
          params: {
            threadId: thread.id,
            command: 'printf RECOVERY_BENCHMARK',
          },
        }),
      );
      const done = await app.waitFor(
        (note) =>
          note.method === 'turn/completed' &&
          note.params.threadId === thread.id,
        { from, timeoutMs: 10_000 },
      );
      assert.ok(done, 'Seed shell turn did not complete');
      assert.equal(
        (done.params.turn as { status: string }).status,
        'completed',
      );
    }
  }
  return ids;
}

interface Sample {
  count: number;
  bound: number;
  round: number;
  elapsedMs: number;
  firstMs: number;
  p50Ms: number;
  p95Ms: number;
  interactiveMs: number[];
}

/** Reports the nearest-rank percentile without hiding individual samples. */
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/**
 * Times the production metadata/read + paged resume sequence and attachment goal read.
 * Independent requests are bounded; an unrelated metadata read observes contention.
 * Every resume must return the requested actual page, so omitted work is not a speedup.
 */
async function sample(
  app: AppServer,
  ids: string[],
  bound: number,
  round: number,
): Promise<Sample> {
  let next = 0;
  let firstMs = Infinity;
  const latencies: number[] = [];
  const interactiveMs: number[] = [];
  const goals: Promise<unknown>[] = [];
  const start = performance.now();
  const workers = Array.from(
    { length: Math.min(bound, ids.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= ids.length) return;
        const threadId = ids[index];
        const began = performance.now();
        result(
          await app.request({
            method: 'thread/read',
            params: { threadId, includeTurns: false },
          }),
        );
        // initialTurnsPage is documented but absent from the exported request schema.
        const opened = result(
          await app.requestRaw<
            v2.ThreadResumeResponse & {
              initialTurnsPage?: { data?: v2.Turn[] };
            }
          >('thread/resume', {
            threadId,
            excludeTurns: true,
            initialTurnsPage: {
              limit: 20,
              sortDirection: 'desc',
              itemsView: 'summary',
            },
          }),
        );
        assert.equal(opened.thread.id, threadId);
        assert.equal(
          opened.initialTurnsPage?.data?.length,
          2,
          'Initial history work was omitted',
        );
        // Inventory performs this attachment observation independently of the main sweep.
        goals.push(
          app
            .request({ method: 'thread/goal/get', params: { threadId } })
            .then(result),
        );
        latencies.push(performance.now() - began);
        firstMs = Math.min(firstMs, performance.now() - start);
      }
    },
  );
  // A fixed number of real interactive reads avoids a sampling timer changing load by bound.
  const interactive = (async () => {
    for (let index = 0; index < 3; index++) {
      const began = performance.now();
      result(
        await app.request({
          method: 'thread/read',
          params: { threadId: ids[0], includeTurns: false },
        }),
      );
      interactiveMs.push(performance.now() - began);
    }
  })();
  await Promise.all([...workers, interactive]);
  await Promise.all(goals);
  return {
    count: ids.length,
    bound,
    round,
    elapsedMs: performance.now() - start,
    firstMs,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    interactiveMs,
  };
}

/** Runs quiet, sequential process samples; no provider or background model work is involved. */
async function main(): Promise<void> {
  const bin = resolveCodexBin();
  console.log(codexVersion(bin));
  const samples: Sample[] = [];
  const bounds = [1, 2, 4, 8];
  for (const count of [8, 32]) {
    for (let round = 0; round < 4; round++) {
      for (const bound of [...bounds.slice(round), ...bounds.slice(0, round)]) {
        // Resume itself can change persisted state. Reusing a home caused
        // order-dependent timing drift, so every sample gets equivalent new
        // seed history; no rollout/database relocation is assumed safe.
        const root = await mkdtemp(join(tmpdir(), 'codex-recovery-bench-'));
        const home = join(root, 'home');
        const cwd = join(root, 'workspace');
        await mkdir(home);
        await mkdir(cwd);
        await writeFile(
          join(home, 'config.toml'),
          'approval_policy = "never"\n',
        );
        let app = await AppServer.start({ bin, home, cwd });
        let ids: string[];
        try {
          ids = await seed(app, cwd, count);
        } finally {
          await app.kill();
        }
        app = await AppServer.start({ bin, home, cwd });
        let measured: Sample;
        try {
          measured = await sample(app, ids, bound, round);
        } finally {
          await app.kill();
        }
        samples.push(measured);
        console.log(JSON.stringify(measured));
      }
    }
  }
  console.log(
    JSON.stringify({
      summary: [8, 32].flatMap((count) =>
        bounds.map((bound) => {
          const selected = samples.filter(
            (value) => value.count === count && value.bound === bound,
          );
          return {
            count,
            bound,
            p50SweepMs: percentile(
              selected.map((value) => value.elapsedMs),
              0.5,
            ),
            p95InteractiveMs: percentile(
              selected.flatMap((value) => value.interactiveMs),
              0.95,
            ),
          };
        }),
      ),
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(
    'INVALID_SAMPLE',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
