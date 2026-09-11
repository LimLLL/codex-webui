# Backend conversation discovery and recovery

The backend separates sidebar metadata, pending interactions, and execution
obligations. Browser room membership controls delivery of detailed events only.
It does not decide which sessions survive app-server replacement.

## Shared overview metadata

`ThreadMetadataService` owns one in-memory collection of stored thread metadata,
including the archive partition that listed each thread. A complete acquisition
walks each partition once with 200-thread pages, all providers, and the upstream
default source scope. No history/items are requested. Concurrent cold readers
share that acquisition; warm overview requests never enumerate upstream threads.

`ThreadsOverviewService` filters this complete collection, merges existing
local/adopted edges with reported `forkedFromId`, selects the highest matching
ancestor, aggregates matching members, sorts, and only then paginates. Workspace,
archive and search filters do not operate on a pre-collapsed global page. Active
member pointers and pending counts are still read locally when projecting.

Discovery runs once per backend, every 30 seconds after an acquisition completes.
Thread discovery/deletion/settings changes advance the next acquisition to a
500 ms coalescing window. Name and status replacements update held rows locally;
archive changes move held rows between partitions. Turn activity marks metadata
stale without scheduling a full walk, except for the same started-but-unlisted
conversation's first activity. Pending-listing urgency expires after five minutes,
is pruned on discovery even without subsequent turns, and is cleared on listing,
close, deletion, or process replacement. After expiry, periodic discovery still
finds a newly materialized conversation. Unrelated turns never inherit its urgency.
Further events cannot indefinitely postpone the coalescing window. Token and item
deltas do not trigger acquisition. Backend shutdown stops scheduling. No database,
configuration flag, or persistent cache was introduced.

Both archive partitions publish together. Failure, invalid/repeating pagination,
a process change, or a membership/partition mutation during acquisition leaves
the previous usable collection in place. Live name/status patches observed during
the walk are retained and applied only to rows the complete walk actually lists,
including during cold acquisition. Turn/name/close staleness raised during the
walk remains explicit after publication. A superseded acquisition schedules one replacement;
a failed acquisition waits for the backend schedule rather than retrying for every
browser. Positive deletion notifications remove the affected row immediately and
invalidate outstanding discovery. No partial acquisition is published as complete.

`GET /api/threads/overview` retains `data` and `nextCursor`, adding:

```json
{
  "freshness": {
    "generation": 2,
    "refreshedAt": 1789060000000,
    "stale": false,
    "refreshing": false
  }
}
```

- `generation`: the app-server generation that supplied the collection.
- `refreshedAt`: successful complete acquisition time in Unix milliseconds.
- `stale`: known changes, failed discovery, expired discovery age, or a different
  current process generation mean that the collection is last-known data.
- `refreshing`: an acquisition is currently in flight.

These fields describe metadata freshness; the joined local pending counts and
active-member pointer may be newer. With no usable collection, the endpoint
returns HTTP 503 rather than an empty list. A full paginated traversal is not a
transactional upstream snapshot. This collection never authorizes deletion or
substitutes for the existing live deletion/compaction checks.

### Measured filter and external-discovery limits

`codex_probe/metadata-filters.ts` drives the pinned 0.153.2 binary using an isolated
home and a loopback provider that rejects model execution. Its real failed turns
materialize user-message metadata without using a model account. Measurements:

- Search matches a literal, case-sensitive substring in either the explicit name
  or the original preview, including after renaming. `%` and `_` are literal.
- Relative cwd filters resolve against the app-server process working directory.
- Timestamp ordering in the fixture breaks ties by descending thread id.
- A listable fork created by a second app-server is discovered by `thread/list`,
  but its creation event does not reach the first stdio transport.
- In that fixture, the fork response and rollout header carry the parent while
  `thread/list` reports `forkedFromId: null`. Unmaterialized forks are not assumed
  listable. Existing local/adopted edges continue to supply known relationships;
  listing alone does not establish complete external ancestry.

The startup adoption scanner and provenance boundaries remain unchanged. The
normal upstream scan-and-repair list behavior is retained; `useStateDbOnly` is
not enabled. Periodic discovery is necessary for external changes, but does not
upgrade missing upstream parent metadata into an authoritative relationship.

`codex_probe/metadata-incremental.ts` separates consecutive refused-provider turns
by 1.2 seconds because `Thread.updatedAt` has second precision. The second turn
advances `updatedAt`; the earlier same-second measurement concealed this change.
Turn notifications carry `{ threadId, turn }` and status notifications carry the
replacement status, but neither supplies a replacement `Thread.updatedAt`.
The service therefore updates badges immediately while leaving ordering explicitly
stale until the next successful scheduled discovery (30-second interval plus scan
time, longer on failure). It does not invent timestamps from the backend clock.
The measurement covers a failed turn with `systemError`, not all outcomes. The
same fixture verifies absence immediately after start and presence after its first
persisted turn.

Lagging recency order is a **deliberate trade**, not an outstanding defect. Before
this read model every turn re-enumerated both archive partitions to keep ordering
immediate; that enumeration is the cost this design exists to remove. Restoring
immediate ordering means a targeted per-conversation metadata read on turn
completion — a bounded option, but one that reintroduces per-turn upstream work
and needs its own measurement first, because nothing here establishes that
`updatedAt` has already advanced at the instant `turn/completed` is delivered.

### Displayed sidebar rows and pending actions

`selectSidebarRows` indexes the displayed views only: home includes both active
rows and the archived preview; detail includes its current page. Click targets,
badges and deep-link highlighting all use that index. Archive completion is an
asynchronous action and captures its known member ids when confirmation opens,
then transfers them into the mutation's own context when confirmed.
It uses those ids for subscription cleanup and checking whether the selected
conversation was archived, even if navigation or a refetch has removed its row.
The neighbour is still chosen from the currently displayed list.
These captured members are the projection's matching members, not an authoritative
archive cascade. Cross-workspace members can be absent even though the backend
archives the full known tree. Complete client cleanup for that case needs an
authoritative mutation scope or per-thread archival reconciliation; inactive query
caches cannot supply that guarantee.

## Global socket invalidations

Namespace: `/ws`. Sockets join the internal authenticated room only after token
authentication succeeds. Thread-room membership is not required for either event.

| Event | Payload | Consumer action |
|---|---|---|
| `conversation.overview.changed` | `{ "generation": number }` | Invalidate the displayed overview query variants. |
| `conversation.pending.changed` | `{ "generation": number }` | Re-read and reconcile the global pending-request set. |

Both are invalidation hints, never snapshots, transcript events, or replay
cursors. Generation is scoped to one backend lifetime. Fetch baselines on every
connection even if the number equals one seen before a complete backend restart.
The gateway emits both hints after authentication. Clients should coalesce hints
with their own initial/focus/reconnect refresh and should not reopen conversations
in response to an overview hint.

Overview hints follow collection publication/freshness changes and committed
local topology or active-member changes. Pending changes also invalidate overview
counts without starting another metadata traversal. Creation, committed response,
upstream resolution, cancellation, generation expiry, and startup expiry notify
pending consumers. An unsuccessful response transaction emits nothing. Creation
while deletion holds the thread guard defers its hint; guard release emits a
pending hint so requests belonging to surviving threads become discoverable.
Existing suppression and replay of the detailed server request are preserved.

Pending reconciliation remains request-time ordered and multi-device responses
remain first-writer-wins. A hint does not prove acceptance or resolution. The
existing detailed `codex.notification` contract remains thread-scoped. Human
`codex.serverRequest` events now reach the authenticated room with additive
`instanceId`, `generation`, `reviewSubject`, `presentation` and `negativeOnlyReason` fields; `conversation.pending.resolved` retires
them globally after committed resolution, cancellation or expiry. Token/item
deltas emit no global invalidation.

Pending reads return `{ generation, requests, failures }`; requests include submitted decisions awaiting confirmation. Responses and retirement require the immutable instance, because generation counters reset with the backend. A read whose scope intersects
a deletion guard fails with HTTP 409 (`threads.delete_in_progress`), rather than
returning a successful set with hidden rows that falsely appear resolved. Guard
release emits another pending-change hint. Thus a successful response still
covers its entire requested scope and a failed read resolves nothing. Internal
deletion planning continues to inspect the underlying pending rows.

File approvals include the complete proposed change set retained from the
preceding item event. The pinned `file-approval-context` probe found the pending
item absent from history despite other readable items, so opening history cannot
replace this context. Retention follows live items and pending requests only;
backend startup already expires old requests and needs no subject migration.
See [approval.md](approval.md#global-attention-contract) for exact payloads and
browser reconciliation obligations. Receiving attention never acquires a
transcript subscription or triggers session reattachment.

## Browser restore

The route owns explicit opening (including page load), navigation and read-only
fallback. `applyOpenResponse` already refreshed policy before this integration;
it now shares item/lifecycle repair with `thread-restore.ts` and re-reads the
backend's recorded token usage, turn diffs and errors. There is no remaining
bulk page-load restoration call and no unused `pageLoad` reason.

| Entry | Reads |
|---|---|
| Route open / page load | Resume/open snapshot, policy, item/lifecycle repair, recorded auxiliary data, goal and collaboration-mode queries |
| `appServerRestart` | For viewed threads the backend successfully reattached: `recordActive:false` resume/open, then the same applier |
| `reconnect` | Passive metadata/history/items, policy and recorded auxiliary data; refresh viewed goal/mode queries; no upstream resume |

Initial HTTP hydration and Socket.IO joining are independent. The transcript
paints from the open response immediately; an acknowledged join is followed by
a fresh history read to cover events missed before joining. The first socket
connection also repairs a view already hydrated over HTTP. Recovery iterations
supersede older item reads, while reopen/deletion/restart invalidate the whole
conversation incarnation. A transport repair does not discard a valid open
response merely because both overlap. Policy confirmation retains its separate
direct fresh read and is never routed through generic query deduplication.

Recent history uses explicit descending summary pages, bounded to ten pages of
20 turns. The anchor is captured before the read; a newly received live turn
cannot hide a gap behind it. Returned turns are merged by identity and page
order, including interior holes, and terminal lifecycle never moves backwards.
Full item top-ups are eager for unfinished turns and the newest page; older
summary rows use the existing on-demand reader. If no pre-read anchor is found,
the latest bounded window and its actual cursor replace the disconnected old
window, preserving observations made during the read. Absence never proves that a turn finished or was deleted. Forks and branch
switches retain separate thread identities. This is not a claim that history is
permanently append-only or that several pages form an atomic snapshot. The
pinned protocol rejects rollback for paginated threads; pruning retained rows
for other external history rewrites requires explicit deletion evidence.

Rooms follow the viewed transcript: selection leaves the old room, route exit
leaves the current one, and reconnect rejoins only the final desired set rather
than buffered navigation history. Backend restart inventory ids do not create
background browser runtimes. Background running badges come from the overview;
stale cached lifecycle cannot override it. Global attention supplies requests
without joining a transcript room or reattaching upstream execution.

Both global hints, mount, focus and reconnect feed shared refresh ownership.
Overview invalidation coalesces for at most 300 ms and includes flat lists and
branch projections; only active queries refetch. An already-running initial
query is allowed to settle before issuing the post-hint read. Per-notification
list invalidations are removed. Pending reads coalesce bursts and allow one
trailing read when a hint arrives during a read. They are unscoped and aborted
when the authenticated socket effect unmounts; a deletion-guard 409 retains
state without an error toast. Other read failures remain visible.

The configured idle limit bounds safe eviction candidates, not total retained
runtimes. Selected, running, pending-interaction, history-loading and pending
policy-confirmation state remains protected. Cached running state may remain
conservatively retained after leaving its room. Eviction invalidates outstanding
reads, so a late response cannot recreate the discarded runtime.

## Execution inventory and child replacement

`ThreadExecutionInventoryService` observes the managed transport independently
of browsers. It records active turn ids, approval/input-blocked activity, active
goals between turns, and observed spawned-child owner ids. It observes successful
start/review acknowledgements as well as notifications, so an acknowledgement
cannot resurrect a turn whose terminal notification arrived first. Goal mutation
responses carry local wire observation order; an older acknowledgement cannot
undo a later goal notification. Attachment reads persisted goal state without
letting a late read overwrite live changes.

A terminal turn retires only that turn. Idle status is not termination evidence.
A paused, blocked, limited, completed or cleared goal retires its continuation
obligation without retiring unrelated running turns. Runtime closure ends its
turns but does not declare a separately persisted active goal complete. Deletion
removes all obligations and rejects late observations. Unknown goal payloads and
failed reads never establish termination.

Uncorrelated active status remains conservative: unrelated historical completed
turns cannot prove that activity ended. It can remain a recovery target until a
running turn is identified and terminalized, or the runtime closes or is deleted.
An arbitrary terminal header is deliberately not used to prune this state.
Goal reads add one upstream request per observed attachment, shared while in
flight. They discover persisted active goals that attachment metadata does not
carry; there is no new browser HTTP request or per-overview goal fan-out. Sequential
introductions after a read settles can read again. This cost is retained for
correctness, and is separate from the removed bulk browser recovery work.

Child exit retains the inventory. On the next ready generation, `AutoResumeService`
reattaches these targets sequentially, including required owners before their
children. Observed owner ids survive replacement, so an owner can be restored
before reading an unloaded child; fresh contradictory owner metadata fails the
reattachment. Shared parents are restored once per pass. Targets and process
generation are rechecked as work advances. All opens use `recordActive:false`.
Writer refusal is reported as a failed reattachment, not successful recovery.

Only returned turn headers can settle old turn obligations; absence from a
bounded page is not proof of completion. Failed or unresolved obligations remain
available for subsequent recovery. The accepted-work tracker retains its separate
catalog restart-barrier semantics and is not used as the restoration inventory.

The existing `codex.lifecycle` event `autoResumeCompleted` keeps its payload:
`{ type, generation, resumedThreadIds, failedThreadIds }`. Here "resumed" means
session reattachment acquired a writable session. It does **not** promise that a
pre-crash turn continued. Recovery never submits a user message, replays a command,
or starts a replacement turn.

### What a crash actually leaves behind (measured)

`codex_probe/restart-recovery.ts` runs four independent process pairs and temporary
homes: goal/no-goal crossed with plain/explicitly paged cold resume. Each case
materializes a failed seed, observes the target turn's exact id and receipt of its
next model request, holds that request without replying, and SIGKILLs the child.
An active goal is set only after that turn is running, avoiding idle goal dispatch
before the intended crash. The replacement reads the persisted goal before its
single resume. On pinned 0.153.2:

- The same crashed turn is returned as **`interrupted`** in all four cases and
  stays terminal through the observation window. This is positive evidence that
  retires that turn's obligation. It says nothing about an absent/uncovered turn,
  uncorrelated activity, or every possible crash boundary.
- Plain resume returns **`initialTurnsPage: null`**, with the two fixture turns
  in legacy `thread.turns`. Property presence is not page population. The backend's
  explicit `excludeTurns` + `initialTurnsPage` request returns a populated page
  and empty `thread.turns`; generated response types omit that experimental field.
- The goal is **active before attachment**, establishing persistence independently
  of any goal changes caused by attachment or later execution.
- Both active-goal cases start a **distinct new turn** and issue a new model
  request after attachment. Neither goal-free case starts a turn within the
  four-second observation window. Negative observations are bounded to that
  window, not promises that no future native scheduling can occur.

Post-resume model requests remain held, so the observed continuation stays running
and the goal stays active. A refusing provider can instead make it fail or change
the goal; such outcomes do not establish behavior under a working model. This
probe covers a persisted root thread stalled before a model response. It does not
cover tool side effects, unanswered approvals/input, owner-controlled children,
ephemeral sessions, or a complete backend restart.

Native goal continuation is consistent with the approved recovery of active goals.
The backend never replays a user submission, and retiring the old turn does not
retire a new native turn. Disabling unattended goal continuation would be a product
policy change; no new switch or unverified "attach without executing" mode is added.

**Durability scope:** the inventory survives replacement of the app-server child
while NestJS remains alive. It does not survive a complete backend/host restart.
There is no durable job scheduler, automatic submission replay, or promise to
recover nonpersisted sessions. The sidebar metadata collection is also in memory
and is not a complete inventory of executing or ephemeral subagents.

## Verification

Behavior tests cover shared/paged discovery, partial failure, periodic external
discovery, cursor failures, deletion races, filtering and collapsed pagination;
authenticated invalidations and committed pending transitions; and execution
recovery after every browser's Socket.IO rooms have been removed, including
blocked work, active goals, retained owners, terminal ordering and writer refusal.
The pure branch DTO and group-cleanup helpers retain the existing behavior tests.
