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
