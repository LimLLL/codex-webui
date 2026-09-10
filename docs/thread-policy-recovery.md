# Thread policy and history recovery contracts

## Next-turn security policy

`GET /api/threads/:threadId/security-policy` reads the backend's current
observation without loading the thread. It returns `observed`, `source`
(`response`, `notification`, or `unknown`), `approvalPolicy`, `sandboxPolicy`,
and `approvalsReviewer`. Unknown fields are null, never inferred from global
configuration.

`PATCH /api/threads/:threadId/security-policy` accepts only `approvalPolicy`
and `sandboxPolicy`, with at least one present. Omission preserves a field;
null does not reset it. Approval policy supports `on-request`, `never`, and
the complete granular object. Sandbox policy accepts the pinned `readOnly`,
`workspaceWrite`, `dangerFullAccess`, and `externalSandbox` variants. Roots,
network access, and temporary-directory flags must be explicit where required
by that variant. Unknown fields, including nested misspellings, are rejected.

The backend verifies that the thread is loaded in this process with a
metadata-only read. It never resumes a thread to acquire ownership for this
mutation. Unloaded threads return a conflict; app-server enforces parent-owned
child restrictions, managed requirements, and unload races. Errors propagate;
no failure falls back to writing global config.

The successful response is HTTP **202**, `{ "status": "accepted" }`. This is
a queued acknowledgement, not an effective-settings response. The caller must
confirm matching current observed settings before sending the next `turn/start`.
The acknowledgement alone never confirms a change. An already observed matching
value covers a no-op without waiting for an acknowledgement or another
notification. An in-flight turn is untouched.

Start/resume/fork responses seed the observer only when no observation exists.
Full `thread/settings/updated` notifications retain all settings, including
security fields, and win over a seed arriving later. Repeat opens read the
current observation after their asynchronous history reads. Accepted
collaboration-mode requests no longer replace observed settings; they only
record displaced effort for the existing Plan-mode restoration behavior.
Closed/deleted threads and process-generation changes invalidate observations.
Responses from start/fork work crossing a generation cannot reseed the cache.

`POST /api/codex/approval-policy` and `/api/codex/sandbox-mode` remain global
default editors. Measurements against the pinned app-server show that their
`config/batchWrite` with `reloadUserConfig: true` changes new-thread defaults,
but not approval policy or sandbox mode in already-loaded threads. This result
does not generalize to every other config field. On cold resume, approval
policy and permission-profile identity follow request override, persisted
thread setting, then current configuration. Concrete historical sandbox
permissions are not necessarily restored when no active profile ID exists.

End-to-end enforcement was measured against a real model turn on the pinned
app-server. A thread started on `on-request` / read-only asked for approval to
write a file. After a `thread/settings/update` to `never` /
`danger-full-access`, the same task ran without any approval request. The
`thread/settings/updated` notification fired for that update and carried the
full effective settings, `approvalPolicy` and `sandboxPolicy` among them — it
is a complete observation, not a change hint, which is why a client can settle
a pending selection from it. This closes the earlier gap: `thread/shellCommand`
runs outside the sandbox by design and could never have validated model-tool
policy enforcement.

## Persisted item coverage

`GET /api/threads/:threadId/turns/:turnId/items` returns:

| Field | Meaning |
|---|---|
| `items` | Full accumulated persisted item payloads, in upstream completion order |
| `complete` | This read reached explicit cursor exhaustion |
| `nextCursor` | Continuation after a capped read; accepted as the endpoint's optional `cursor` query |
| `incompleteReason` | Null, `pageLimit`, `cursorCycle`, `invalidResponse`, or `pagingUnavailable` |

Each request walks at most 20 pages of 500 items. Cursor cycles and malformed
responses cannot certify completeness. The pinned item-pagination refusal
conflates unmaterialized history and unsupported stores; it returns an
incomplete `pagingUnavailable` outcome, not a certified empty turn. Other RPC
failures remain errors. A null cursor alone is not proof of completeness.

`complete` describes coverage from the supplied cursor at read time. It says
nothing about whether the turn has finished or whether additional items will
arrive later. Strict fork-provenance readers remain fail-fast and do not
consume these partial UI outcomes.

Measurements with shell-command turns establish item-level persistence:
completed items are readable while their turn is still running; unfinished
items are absent. Both `item/completed.aggregatedOutput` and the persisted
command item contain accumulated output, so terminal payloads replace missed
stream fragments rather than concatenate with them. Summary view can remain
empty even for completed command-only turns.

Overlapping commands persist in completion order, while live clients first
place them in start order. Backend reads preserve upstream order without
inventing timestamps or sorting IDs. The client preserves positions already
known live and inserts restored gaps by persisted adjacency. A cold refresh
can therefore change the order of overlapping items. An ordinary serial model
turn was measured to agree across all three orderings — started, completed and
persisted — so the divergence is specific to genuine overlap rather than a
routine hazard. Late subagent activity may also add an item to an
already-completed turn; completed-turn history is not an indefinitely immutable
cache.

Consumers must therefore honour `complete` rather than publishing every
response as the turn's full history. Marking an incomplete read `full` retires
the turn from further top-up, so one `pagingUnavailable` response — which can
carry zero items — leaves the transcript truncated for the rest of the session.
An incomplete read is merged under the recovery rules and stays refetchable;
only a complete one may claim to be the whole turn.

## Client-side confirmation ordering

The confirmation contract lives entirely in the frontend policy store, not in
the component that renders the badge.

Observations carry a monotonic sequence stamped when a read is **issued**, and
a later-issued read always wins. This is not defensive style: with the read
held in a TanStack query, an invalidation fired by the confirming
`thread/settings/updated` was measured to produce **no second request at all**
while the first read was still in flight, so the pre-notification body became
the cached answer. The notification therefore triggers a direct read rather
than an invalidation.

Confirmation is owned per conversation, not per mounted view. Both the badge
and the composer read this state, and per-mount timers gave one selection two
competing deadlines that restarted on every re-render. The deadline is an
absolute timestamp recorded with the selection.

Each asynchronous continuation belongs to its original selection, including a
deadline read or a PATCH refusal that arrives after a re-selection. Superseded
reads cannot confirm through their return value after the store discarded them.
An older cache entry cannot confirm while a newer read is outstanding or failed.
Each policy read is aborted after eight seconds; the eight-second selection
window can therefore be followed by at most eight seconds for the final read.
Transport loss on PATCH is uncertain delivery and follows the read/confirmation
path. Only explicit client-error refusals immediately produce `rejected`.

A selection ends in one of four stated outcomes, and they are not
interchangeable:

| Outcome | Meaning |
|---|---|
| `pending` | Still waiting for a matching observation; Send is held |
| `rejected` | The patch was refused, so nothing was queued and the old policy stands |
| `ineffective` | The wait expired and a fresh read showed the request did not take effect |
| `unknown` | The wait expired and the policy could not be read at all |

Expiry **reads** rather than assumes. A missing confirmation is consistent both
with "it applied and the notification was lost" and with "it never applied",
and only the read separates them. `ineffective` reverts the badge to the
measured effective value and says so; `unknown` says nothing was established.
Both are announced outside the popover, which is closed by the time they fire.

Confirming a sandbox compares every field the request named, not the variant
tag. Two `workspaceWrite` policies differing only in writable roots or network
access authorize materially different things, and confirming on the tag alone
reported a change effective while the conversation ran under a different
sandbox. A sandbox option that must state a network flag is not offered at all
until the current one is known, because inventing `false` silently revokes
network access the conversation may have had.

Global defaults for new conversations are edited in Settings; this badge
changes one conversation. Both controls must exist: the two are different
operations, and a period where each pointed at the other left the global
default editable only through the raw TOML escape hatch.

## Approval payload preservation

The backend stores and forwards approval request params unchanged, including
experimental `additionalPermissions` and `networkApprovalContext`. REST pending
request recovery preserves the same payload as websocket delivery. Filesystem
entries retain access type and structured path/glob/special-path semantics. A
special path is an **object union** in the pinned schema (`root`, `minimal`,
`project_roots` with a sub-path, `tmpdir`, `slash_tmp`, `unknown` with its own
path), never a string, so a client testing it for a string discards every
structured scope — and an overlay whose only entry was one collapses to null
and disappears from the card. The scope tag is the security-relevant part and
is rendered;
network enablement retains omission/null rather than defaulting to unrestricted.
Network-only requests may omit command and cwd entirely. The environment
identifier is not consumed by this deployment's UI. No additional backend
projection or permission inference is introduced.
