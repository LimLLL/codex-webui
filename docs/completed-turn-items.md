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

Foreground opens and older history pages request full items. Rendering a completed
turn never itself fetches or enriches it. A full snapshot is coverage of that
read, not proof that the turn's item membership is permanently closed.

Open/reconnect/app-server readiness own freshness. They reconcile full pages and
repair retained older turns outside that window with bounded item paging (four
workers). Partial responses can repair fragments but report incomplete coverage;
failed refresh leaves warm content readable. Request baselines and recovery epochs
reject superseded evidence, including after deletion or runtime eviction.

Late events route by their supplied thread/turn IDs. A late item start preserves
its turn's completed state; completion finishes the item by ID. Replayed events
cannot duplicate an item, downgrade a terminal payload or stop a newer submission.
Readiness includes viewed completed owners absent from the backend's execution
reattachment list. Sibling workspace tabs retain that conversation's subscription.

This does not poll every retained background transcript, infer recipients from
parent relationships, or use a timer as proof of finality. See
[workspace-tabs.md](workspace-tabs.md) for display gating and inline anchoring.

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
