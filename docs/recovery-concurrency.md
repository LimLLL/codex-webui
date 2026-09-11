# Recovery concurrency measurement

The backend retains serial execution reattachment. The pinned 0.153.2 benchmark
did not establish a repeatable useful throughput improvement that justified a
production limiter, and higher bounds increased per-conversation tail latency.

## Method

`codex_probe/recovery-concurrency.ts` compares bounds 1, 2, 4 and 8 with four
rotating-order repetitions for 8 and 32 independent conversations. Each sample
gets a separately seeded home containing two completed shell turns per thread.
Seeding is excluded from timing; the native seed process must exit before a fresh
process performs recovery. Every resume must return the requested two-turn page.

The measured sequence is metadata read, resume with the initial summary page,
and the attachment's goal read. Three unrelated metadata reads measure contention.
There are no model calls. Samples run sequentially without concurrent test/build
jobs. A preliminary reused-home comparison drifted with run order and was not used
for the decision. A prior wrapper-termination sample failed with a writer refusal
and was invalidated rather than retried.

## Results

Wall-clock milliseconds; each median below is the mean of the middle two samples.
The task-tail column is the median of each run's per-conversation p95.

| Threads | Bound | Sweep samples | Median sweep | Median task p95 |
|---|---|---|---|---|
| 8 | 1 | 162, 155, 125, 138 | 146 | 29 |
| 8 | 2 | 134, 132, 118, 139 | 133 | 46 |
| 8 | 4 | 115, 118, 138, 144 | 128 | 77 |
| 8 | 8 | 122, 116, 128, 131 | 125 | 124 |
| 32 | 1 | 4078, 4312, 3994, 4169 | 4124 | 306 |
| 32 | 2 | 3985, 4110, 8894, 3937 | 4047 | 551 |
| 32 | 4 | 4187, 4134, 4122, 3826 | 4128 | 899 |
| 32 | 8 | 3906, 3923, 5827, 4141 | 4032 | 1791 |

At eight threads the small absolute gains reversed in later trials. At 32 threads
the median differences were about two percent or less, with large outliers rather
than a repeatable scaling benefit. The p95 of the sampled interactive reads at
32 threads was 26/268/35/112 ms for bounds 1/2/4/8 respectively; four repetitions
are too few to treat these tail estimates as a general latency guarantee.

Pinned source explains why multiplexing alone does not imply parallel recovery:
the stdio processor awaits `process_request` in `app-server/src/lib.rs`, and
`thread_resume_inner` in `request_processors/thread_processor.rs` awaits its work
while holding a thread-list state permit. Some other operations explicitly spawn
background tasks, so this is not a claim that every app-server method is serial.

No scheduler, retry layer, or new setting was introduced. Existing parent ordering,
deduplication, deletion checks, generation abandonment, failure isolation and the
whole-sweep catalog admission claim remain unchanged.

## Reproduction and scope

```sh
pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/recovery-concurrency.ts
```

The final JSON summary uses nearest-rank p50; the full samples are printed so
other summaries can be computed without rerunning. A failed request or teardown
invalidates the run. This measures independent persisted roots on the tested host,
not owner-controlled children, active-goal continuation, remote execution, or
every history size. Those limitations do not justify adding a limiter without
positive evidence of a benefit in the workload it would serve.
