# Completed turn item freshness

Turn completion ends execution; it does not close the turn's item membership.
`full` describes the detail retrieved, and `complete` describes a successful
bounded history read. Neither is a promise that no item can arrive later.

## Evidence on 0.153.2

`codex_probe/item-finality.ts late` ran three successful real-model fixtures.
Each child reached a dynamic tool whose response was explicitly withheld. The
parent completed and its full item pages were read before releasing the child.
All three original turns subsequently acquired a `subAgentActivity` completion
item. One case ran another parent turn before release; the activity still
belonged to the original initiating turn. Both `item/started` and
`item/completed` arrived after that turn's completion, using the same item ID.

After each successful late-child case, the native process was SIGKILLed and its
exit awaited. The accumulated item payloads were unchanged when read by a new
process, both before and after resume. Separate ordinary completed-model
controls were unchanged after SIGTERM and SIGKILL. These are scoped stability
observations, not evidence that every completed turn is immutable.

The pinned upstream source adds semantic precision:

- `core/src/session/mod.rs`, `forward_child_completion_to_parent`: this activity
  requires successful completion and a recorded initiating turn. If the initiating
  agent differs from the immediate parent, its thread is resolved separately.
- `core/src/agent/control.rs`, `emit_sub_agent_activity`: sends the started and
  completed pair through the raw event path without starting a turn.
- The item ID is `subagent-completed-{child_turn_id}`. Ingestion uses the supplied
  identity, not a content comparison.
- `core/tests/suite/subagent_notifications.rs` asserts the paired events and
  persistence, absence of this completion activity for unsuccessful outcomes,
  and peer-followup attribution to the requester thread and turn. Its parent/root
  metadata assertions distinguish those identities from the emitting child.

All source paths above are under `codex-rs/` at upstream tag `rust-v0.153.2`.
The source inspection does not substitute for a locally run peer-followup probe.

## Client behavior

- Completed rendered turns remain eligible for item queries even when already
  `full`; full-item application accepts those refreshed reads.
- Complete query results are reused between explicit invalidations. Opening or
  rejoining a conversation cancels pre-gap item requests and invalidates that
  conversation's item queries. Mounted turns refetch; other cached turns refresh
  when rendered. Partial responses remain refetchable and never establish full
  coverage.
- Process replacement cancels old item requests. Readiness invalidates queries,
  including visible completed owners absent from `autoResumeCompleted`'s target
  list. Passive history refresh does not acquire writer ownership or create
  background runtimes.
- Late events route by their supplied thread and turn IDs. For a retained terminal
  turn, item start preserves turn completion while introducing an unfinished item;
  item completion finishes it by ID. Replayed starts cannot downgrade a terminal
  item, and replayed completion does not append a duplicate or stop a newer turn.
- Refreshed pages merge under the existing item authority rules: retain newer live
  terminal observations and repair fragments without concatenating full payloads.

This does not continuously refresh every retained background transcript, infer
recipients from parent relationships, or use a timer as a claim of finality.

## Reproduction and limits

Run sequentially from the repository root:

```sh
pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/item-finality.ts cold
pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/item-finality.ts late
```

Both commands use `codex_probe/config.toml` and spend model tokens. Each fixture
owns an isolated home and process cwd. Failed spawn, missing held-child request,
unsuccessful turn, incomplete read, or unconfirmed termination is reported as
inconclusive. An RPC deadline never releases a held operation or retries a write.

A run that provokes no late activity is also inconclusive rather than a stability
result. With no appended item the before/after payloads are trivially equal, which
is indistinguishable in shape from measured immutability but answers a different
question — the fixture never reached the one being asked. The same applies when the
notification arrives but the history read does not expose it: that is a delivery
and persistence disagreement to investigate, not evidence either way. Only a run
that observes the paired events, the expected item ID, arrival after the parent's
completion, and a correspondingly changed history read reports a verdict.

The harness now resolves and directly spawns the pinned native executable. Native
exit, rather than npm-wrapper exit, is awaited before replacement. The shared
runner also awaits normal SIGTERM teardown; legacy `close()` initiates bounded
teardown and marks a failed confirmation inconclusive. New sequential probes use
the awaited termination API. Earlier wrapper-based crash results were not
retroactively validated, and the separate published crash-recovery findings were
not remeasured as part of this work.
