# Protocol probes

Small programs that drive `codex app-server` over stdio JSON-RPC to answer
questions about how the pinned CLI actually behaves.

## Why these exist

The vendored protocol README describes intent. Several conclusions this project
depends on contradicted both that document and careful reasoning about it, and
were only knowable by asking the binary:

| Question | What the docs implied | What was measured |
|---|---|---|
| Does `reloadUserConfig` reach a loaded thread? | Yes, it hot-reloads | No — approval policy and sandbox mode stay put, and no notification fires |
| When is an item persisted? | At turn completion | At **item** completion, so a running turn already exposes its finished items |
| Do live and persisted item order agree? | Assumed yes | No — live is start order, persisted is completion order, and nothing aligns them |
| Does a terminal payload carry a tail or the whole result? | Assumed a tail | The whole accumulated result, so repair is replacement, never concatenation |
| Is `thread/settings/update` usable? | Not in the exported schema | Works at runtime; schema silence is not evidence of absence |

Two of those were being asserted from reasoning until a probe proved them wrong.
That is the standing lesson: **measure before claiming**, and treat "the schema
does not export it" as a question rather than an answer.

## Setup

```bash
cp codex_probe/config.toml.exmaple codex_probe/config.toml   # then edit
export YOUR_PROVIDER_API_KEY=...                             # whatever env_key names
```

`config.toml`, `home/` and `workspace/` are gitignored. The runner resets the
same `home/` and `workspace/` directories inside the checkout on each run.
Runs must currently be sequential: concurrent runs can erase each other's
state. The child inherits the process working directory and environment; this
isolates Codex state between sequential runs, not the host filesystem or project
context. Output can include effective cwd values and raw server diagnostics;
these runtime logs are not sanitized publication artifacts.

## Running

```bash
pnpm probe --list          # what is available
pnpm probe settings-update # run one
```

The runner always uses the repo's pinned `@openai/codex` binary from
`node_modules/.bin`, never a globally installed one — a measurement against a
different CLI version describes a protocol this project does not target. Every
run prints the version it measured.

Probes marked `[spends tokens]` drive a real model turn and cost money. The
others use `thread/shellCommand`, which produces real turns and real items with
no credentials — but runs unsandboxed by design, so it can never answer anything
about policy enforcement.

## Completed shell-turn control

`pnpm probe turn-item-finality` compares complete item payloads, including output
content, after completion, a later shell turn, and a resume of the still-loaded
thread. On 0.153.2 those payloads were unchanged. Successful reads and resume are
required for that verdict. This does not prove model/subagent turn immutability
or cold-replay stability; the vendored README's late `subAgentActivity` case
remains outside this experiment.

## Writing one

Probes are TypeScript and are **typechecked**, not type-stripped. `ts-node`
compiles them before the app-server is spawned. For example, `turn/start`
takes `input` as a sequence, and passing the map shape that reads naturally
produces a runtime `-32600 invalid type: map, expected a sequence` that costs
more to diagnose than the types cost to write.

`AppServer.request()` takes the method and its params as **one object**, typed
as a discriminated union derived from the generated `ClientRequest`. The single
argument is deliberate. An earlier signature took them separately and inferred
the method from the first, which TypeScript abandons the moment a caller names
any type argument — it has no partial type-argument inference. Every probe named
its result type, so every probe silently fell back to the whole method union and
a `turn/start` call carrying `thread/start` params compiled without complaint.
Correlating the two fields in the type makes the check independent of what the
caller does with the result.

The result type is an assertion, not a check: the pinned schema types request
params but not responses. Methods the schema does not export go through
`requestRaw()` — kept separate rather than loosening `request()` so that every
untyped call is greppable, and the set of them is itself a record of where the
exported schema falls short.

Verdicts require the evidence they describe. `live-policy` checks a matching
settings notification and both successful turn statuses and file writes;
`item-ordering` requires both labelled items in one turn and compares the
persisted order with both observed orders. Its accumulation check counts only
SLOW's deltas and needs multiple chunks. The current `settings-update` run uses
explicit thread overrides; its reload section measures notification delivery,
not the original defaults-only control experiment.

Probes are deliberately not unit-tested. A probe really spawns the pinned binary
and really sends requests to the provider configured in `config.toml`; the
answer comes back from the app-server, which is the entire point. Testing one
would mean stubbing out that app-server, and the result could then only confirm
whatever the stub was written to assume — the exact failure this directory
exists to prevent. Guard a verdict by making it demand its own evidence in the
real run, then re-run the probe.

Add a probe by exporting a `Probe` from `probes/` and registering it in
`index.ts`. State the question in the module docblock along with the answer once
you have it — a probe whose result is only in a chat log has to be re-run to be
useful.

## Scope

Probes exercise **app-server directly**. They answer protocol questions and
nothing else: they do not touch this project's NestJS layer, its REST surface,
its Socket.IO routing, or any frontend logic. A defect in timeline
reconciliation or in a React store is not findable here and belongs in a unit
test.

## Standalone metadata probe

`pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/metadata-filters.ts`
uses its own temporary home and a loopback provider that rejects generation. No
provider config or model account is needed. It checks native search/cwd matching,
timestamp ordering, and discovery of a fork created by a second app-server. On
0.153.2 the creation event did not reach the first transport, and the listing
reported a null parent despite parentage in the fork response and rollout header.
See [backend recovery](../docs/conversation-recovery.md) for the implications.

## Newest history-window visibility

```bash
pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/history-window.ts
```

This standalone probe retains its own temporary home/workspace, prints their
location, and uses the pinned native binary through `AppServer`. A loopback
provider refuses generation and counts requests; the measured run made **zero**
model requests. It neither resets the shared probe directories nor touches the
WebUI database, REST API, Socket.IO, or frontend store.

Measured on **0.153.2, 2026-09-11**:

- Forty distinct shell turns were observed through matching start/completion
  notifications. Completed command items were also read through a second
  app-server process sharing the temporary home but not loading the thread.
- **139 compared pages had no missing or reordered turn IDs.** These include
  the first head read after each completion, 24 stationary reads each at
  4/20/21/40 turns (loaded list, unloaded list, and paged loaded resume), a read
  after the owner exited, cold resume, and a subsequent head read. Stationary
  controls require that no new turn starts during those reads. Notification
  detection uses the harness's polling; this is not an exhaustive submillisecond
  visibility test.
- With a shell held running until an explicit file release, its **turn header
  was present in all three page paths**, together with all three older turns.
  The unfinished command item was absent from persisted items. A completed
  auxiliary command was independently readable in that same running turn; the
  held item became readable after release and completion. Item absence and turn
  absence are different observations.
- The newest pages at 20 and 21 turns shared **19** turns. The pages at 20 and
  40 shared **zero**, following twenty actual new turns. Following the latter
  page's cursor returned all twenty earlier turns and exhausted pagination.
  In one run the twenty new shell turns plus intervening reads took 4.161 s;
  this demonstrates possible automation throughput, not a reconnect producing
  turns or a measurement of normal model-exchange throughput.
- No rollout-write or projection-failure diagnostics were observed.

The verdict is `NO_OMISSION_IN_MEASURED_READS`, not a universal impossibility
claim. Invalid setup, failed RPCs, missing required lifecycle/item evidence, or
unconfirmed teardown report `INCONCLUSIVE`. Successful pages that differ from
the observed sequence are retained as findings, not retried until they agree.

Source findings, **not additional runtime measurements**, from the local
`rust-v0.153.2` checkout:

- `app-server/src/request_processors/thread_processor.rs`,
  `thread_turns_list_response_inner`: paginated history returns before the
  legacy replay branch. The comments about compaction/rollback rebuilding old
  turns and the loaded-only active-turn overlay belong to that legacy branch.
  Paginated resume has its own active-turn overlay; standalone paginated listing
  reads stored turn rows and uses loaded status to normalize lifecycle.
- `core/src/session/mod.rs`, `replace_compacted_history`, appends a `Compacted`
  context record. `app-server-protocol/src/protocol/thread_history_projection.rs`
  ignores that record; canonical completed items and lifecycle events project
  into the existing turn identities. This path does not prune the paginated
  transcript. No model compaction run was needed to test the legacy-comment
  explanation.
- Paginated `thread/rollback` is explicitly rejected. `thread/revert` is a
  separate explicit operation that changes the retained history prefix under
  the same thread ID. Forks have separate IDs; deletion checks rollout references.
  These operations were not exercised by this probe.
- Core logs append failures, and `thread-store/src/local/live_writer.rs` logs
  projection failures without preventing all subsequent live delivery. Thus a
  live observation is not unconditional proof of a healthy durable index. This
  fault path was not injected and is not evidence it occurred in a user report.

Neither a delayed/shared backend promise nor an incomplete local timeline is
simulated here. Two complete newest-20 windows under append-only advancement
need twenty new turns to become disjoint; a sparse local set does not satisfy
that premise. A synthetic disjoint store fixture alone does not establish that
the reported reconnect incident reached that store branch.

## metadata-incremental

Answers whether the shared overview metadata can be maintained from
notifications instead of re-walking the stored conversation list.

Measured on 0.153.2:

- `Thread.updatedAt` has **second precision**. With 1.2 seconds between turns,
  even a refused-provider turn advances it. The original immediate consecutive
  turns falsely appeared unchanged because they ran within the same second.
  `turn/started` / `turn/completed` carry only `{ threadId, turn }`, with no
  replacement conversation timestamp. Ordering must remain explicitly stale
  until discovery when full enumeration is deferred.
- `thread/status/changed` is emitted around the turn independently, carrying an
  authoritative replacement status, so badges stay live without a walk.
- The fixture is **not listable immediately after `thread/start`**; its first turn
  is what makes it appear in `thread/list`. This is the one case where turn
  activity makes discovery urgent, and it was found only because the
  probe's first version failed on it.

The measurement covers a failed turn with thread status `systemError` (the probe's
provider deliberately refuses generation), not every turn outcome. The service
patches live status but marks other metadata stale until scheduled discovery.

## restart-recovery

Answers what survives an app-server crash while a turn is running — the one
question the backend's restart-recovery tests cannot answer, because they mock
the native calls and so only establish bookkeeping.

Method: four isolated cases cross goal/no-goal with plain/explicitly paged cold
resume. Each uses a failed seed, then confirms the exact running turn and receipt
of its held model request before SIGKILL. Goals are set after that request is held,
and read again before the new process's only resume. The provider stays held after
resume so a forced model failure cannot obscure native continuation. No model is
called and no tokens are spent.

Measured on 0.153.2:

- The same crashed turn is returned as **`interrupted`** in all four resume
  responses, but **does not reliably remain terminal**. After the four-second
  window the goal-free cases still read `interrupted`, while both active-goal
  cases read that turn id back as `inProgress` — no `turn/started` carried its
  id, and the goal's new turn has a different one. Whether that turn is actually
  executing is not measured; only its status field is.
- Both goal-free replacements emit `thread/goal/cleared` for a thread that never
  had a goal.
- Plain resume returns **`initialTurnsPage: null`**, not a populated page. It
  returns the two fixture turns in `thread.turns`. Explicit paging returns those
  turn headers in `initialTurnsPage`, with empty `thread.turns`. The exported
  response type omits the experimental page field; presence alone proves nothing.
- The persisted goal is active before attachment. Both active-goal cases start a
  distinct new turn and issue a model request after resume. Both goal-free cases
  start none during the four-second window. This is bounded observation, not an
  assertion about all future scheduling or all kinds of crash.

The "nothing dispatched before attachment" check waits for the model-request
count to stop moving before taking its baseline. A request already on the wire
when the process is SIGKILLed is still delivered afterwards, so a baseline taken
immediately races that delivery — the first version of this check failed on one
machine and passed on another, from timing alone. A probe that reports a
different answer depending on host speed is measuring the host.

The probe validates response contents and treats missing required evidence as a
failure. It does not use one warm resume to validate another cold-resume variant.
Its held provider demonstrates dispatch, not successful model work or tool effects.
Approval/input recovery and owner-controlled children remain outside this fixture.

**These findings were re-measured after a harness defect was fixed.** The pinned
npm entry is a shell script that `exec`s node, which spawns the native executable
as a further child and forwards only `SIGINT`/`SIGTERM`/`SIGHUP`. `SIGKILL` cannot
be caught and so was never forwarded: earlier runs killed the launcher, orphaned
the native process holding the home's write lock, and the orphan then shut down
gracefully on stdin EOF. Those runs measured a graceful exit, not a crash. The
harness now spawns the pinned native executable directly and requires its real
exit. Re-running changed only the durable-terminality claim; paging, goal
persistence and autonomous continuation reproduced. A corrected tool does not
retroactively validate earlier results — re-run anything that depended on killing
a launcher before relying on it.

## file-approval-context

Answers whether a client that did not receive a conversation's item stream can
still review a file approval it is being asked to grant.

The approval request carries only identities — `threadId`, `turnId`, `itemId`,
plus an optional reason and grant root. The proposed changes live in
`item/started`. So the question is whether history can supply them instead.

Method: a real model is asked to edit two files through the patch tool under
`on-request` / `read-only`, and the resulting approval is **held** rather than
answered, so the agent stays genuinely blocked while history is read. Answering
first and reading afterwards measures the world after the decision, which is a
different question. Requires a configured provider and spends tokens.

Measured on 0.153.2:

- **One approval covered two files**, each with its own `path`, `kind` and
  `diff`. A renderer that shows only the first change is asking the user to
  approve writes they cannot see.
- **The pending item was absent from `thread/items/list`** while the approval was
  outstanding, though three other items from the same conversation were readable
  through the same paging. The existing "persistence happens at item completion"
  finding therefore holds for file changes too.
- `kind` is an object union, not a string: `{type:'add'|'delete'}` or
  `{type:'update', move_path}`. A rename's destination exists only there.
  **This one came from the generated schema, not from that run** — the summary
  helper read `kind` as a string and printed `null` for every change, so the run
  said nothing either way. The helper now prints the value and the probe asserts
  the union, which is what will make it a measurement the next time it runs.
  Listing a schema-derived claim under "measured" is the failure this directory
  exists to prevent, and it survived a review because the shape was right.

Consequence: the approval subject cannot be recovered from history while it is
pending, so any client that must present the approval has to be given the subject
by the backend rather than fetch it. This is what makes backend retention a
correctness requirement rather than an optimization.

**Not established by the first run:** whether `item/started` *precedes* the
approval on the wire. Notifications and requests were recorded in separate lists,
and the first run only proved the item event existed by the time the request had
arrived — the log is read after the fact, so it cannot order the two. Retention
that captures the subject when the item starts depends on that ordering, so
`Note`/`IncomingRequest` now carry a shared `arrival` counter and the probe
reports `item-started-precedes-approval`. Until a run prints it, treat the
ordering as unmeasured: the backend publishes a file approval with a null subject
rather than withholding it, so a miss degrades review rather than stranding the
agent.

The fixture fails loudly when no file approval arrives — the model may use a
shell tool or decline the task, and a run that provoked nothing must not print a
verdict about the protocol.
