# Slash Commands

Composer slash commands bring native Codex command affordances into the web UI:
typing `/` at the start of the draft opens a palette, and selecting a row runs
the command.

Covered commands: `/plan`, `/goal`, `/review`, `/compact`, `/feedback`.

## Scope rationale

Commands that already have a composer popover — model, reasoning effort,
approvals, MCP, skills — are deliberately **not** in the palette. Two surfaces
writing the same setting would be two sources of truth for it.

Terminal-only native commands (`/vim`, `/raw`, `/pets`, `/statusline`, `/theme`,
`/cd`, `/pwd`, `/ps`, `/quit`, `/ide`, `/copy`) have no meaning in a browser.

`/init` is excluded because it has no app-server RPC behind it — it is a prompt
macro, and the official ACP adapter does not implement it either.

See [remaining-tasks.md](remaining-tasks.md) for what is explicitly deferred
(`/shell`, `/side`, turn queue, `/prompts:<name>`) and why.

## Dispatch model

There is **no** generic `executeSlashCommand(name, args)` and **no** backend
`/slash/execute` endpoint. A UI-only command, a thread-state mutation, and a
next-turn setting have different preconditions and different failure modes;
collapsing them would hide that, and a single catch-all endpoint would
centralize unrelated security policy into one hard-to-review place.

Instead `lib/slash-commands.ts` holds a typed catalog, and each command declares
a dispatch kind:

| Kind | Commands | Behavior |
| --- | --- | --- |
| `ui` | `/goal`, `/review`, `/feedback` | Opens a dialog. Nothing is sent until the user confirms, so a mistyped command costs nothing |
| `threadMutation` | `/compact` | Calls an existing semantic endpoint immediately |
| `nextTurnSetting` | `/plan` | Writes thread settings that apply to the next turn |

Each command also carries an `unavailableReason(availability)` predicate, so the
palette can grey a row out **and** explain why rather than silently failing.

The catalog also holds each row's `icon` (a `lucide-react` component). Icons are
deliberately shared with the UI the command produces — `/plan` uses the plan-mode
badge glyph, `/goal` the goal-progress-row glyph, `/review` and `/compact` their
turn-marker glyphs — so the palette entry and the resulting state read as the
same feature rather than two unrelated affordances.

## Trigger rules

The palette opens only when `/` is the first character of the draft and no
whitespace has been typed yet. A slash anywhere else is prose — `and/or` and
`see src/a.ts` must not be treated as commands.

Because a trailing space closes the palette, the send path re-parses the draft:
a draft that is entirely a known command runs the command instead of being sent
to the model. Without that, typing `/compact ` and pressing Enter would ship the
literal text as a message.

## Availability

| Command | Needs thread | Blocked when read-only | Blocked during active turn |
| --- | --- | --- | --- |
| `/plan` | yes | yes | no — it only affects the next turn |
| `/goal` | yes | yes | no |
| `/review` | yes | yes | **yes** |
| `/compact` | yes | yes | **yes** |
| `/feedback` | yes | no | no |

`/review` and `/compact` start their own turn, and app-server rejects
`turn/steer` for review and manual-compaction turn kinds, so they cannot be
queued behind a running turn.

`/feedback` stays available on read-only threads and during turns, because a
broken thread is exactly what someone wants to report.

## Plan mode

Plan mode is a **thread setting**, not a turn parameter. The backend writes it
through `thread/settings/update` and never injects it into `turn/start`.

app-server exposes no side-effect-free read for the current mode: neither
`thread/start` nor `thread/resume` returns `collaborationMode`. The backend
therefore keeps an in-memory observed-settings cache fed by
`thread/settings/updated` notifications and by its own accepted writes, and
reports `observed: false` when it genuinely does not know.

Consequences the UI must honor:

- An unknown mode is never rendered as a confirmed "Default".
- `/plan` means "set Plan mode", not "toggle from Default" — there is no
  confirmed baseline to toggle from when the state is unknown.
- Multi-tab sync is free: `thread/settings/updated` is authoritative, last
  writer wins.
- The cache is per app-server generation and is cleared on restart, and drops a
  thread on `thread/deleted` so it cannot outlive what it describes.

### Reasoning effort is restored across mode switches

`collaborationMode/list` reports the Plan preset with `reasoning_effort: medium`
and the Default preset with `reasoning_effort: null`. That null means *this
preset does not select an effort* — but app-server treats a **written** null as
clearing the thread's effort.

Two distinct problems follow, and both are handled:

1. **Never write null.** Echoing the preset verbatim silently downgraded users:
   switching to Plan and back left the thread at `effort: null` even if it
   started at `xhigh`.
2. **Restore what Plan displaced.** Entering Plan makes app-server genuinely
   rewrite the thread effort to medium, and it keeps no record of the previous
   value. Leaving Plan can therefore only restore `xhigh` if the backend
   remembered it on the way in.

The backend records the *displaced* effort when entering a preset that dictates
its own, and writes it back on exit. The saved value is wrapped rather than
stored bare, because "the thread had no effort" and "nothing was displaced" are
different states that must restore differently.

Lifecycle details that are easy to get wrong:

| Case | Behavior |
| --- | --- |
| Re-entering the same mode | Does not overwrite the saved value with the preset's own |
| Leaving the mode elsewhere (TUI, another tab) | The settings notification clears the saved value — nothing is left to restore, and keeping it would let a later exit overwrite the user's current effort |
| app-server restart | Displaced effort survives, because the imposed effort was persisted server-side; observed settings do not, because they describe one generation |
| Thread deleted | Both are dropped |

`Settings.model` is likewise a required non-null string, so the current model is
always echoed back; the request fails fast if no model can be resolved.

### Effort display versus effort override

The composer badge and the value sent with `turn/start` are deliberately
different things. `effortOverride` is a user choice and rides along on every
turn; an effort merely *observed* from a thread must never be written there, or
one thread's Plan-imposed medium would be forced onto the next thread the user
sends to. Observed efforts are therefore recorded per thread and used for
display only, behind any explicit user override.

## Goals

A goal is a persistent objective that survives turns, so it is thread state
rendered as a fixed row above the composer — not a timeline entry.

- Set / update / clear map to `thread/goal/{set,get,clear}`.
- Native statuses: `active`, `paused`, `blocked`, `usageLimited`,
  `budgetLimited`, `complete`.
- Objective text is capped at 4000 characters, rejected at the REST boundary so
  the user gets a field error instead of an opaque app-server rejection.
- Goals work on threads that have never run a turn, which is looser than the
  protocol README implies.

**Pause semantics**: pausing stops future goal continuation. It does **not**
interrupt a turn that is already running, and the UI copy says so rather than
implying a hard stop. Interrupting is a separate, explicit action.

Because goal state is persisted server-side, frontend idle-subscription cleanup
does not need to keep goal-bearing threads subscribed; the goal is refetched
when the thread becomes visible again.

## Review

Inline only. `review/start` is always sent with `delivery: "inline"`, and an
explicit non-inline `delivery` is rejected: the protocol documents detached
review as unsupported when the parent thread is paginated, and this project
always paginates history.

Four targets are supported: `uncommittedChanges`, `baseBranch`, `commit`, and
`custom`. For an inline review the response's `reviewThreadId` equals the
original thread id.

Review progress arrives as ordinary turn items plus `enteredReviewMode` /
`exitedReviewMode` markers.

## History detail and on-demand top-up

Opening a thread fetches history with app-server's `summary` items view, which
is what makes the metadata-first open cheap. That view **omits `reasoning` and
`plan` items** — measured on a 5.4 MB conversation, `summary` returns 97 KB
against `full`'s 501 KB.

The consequence only became visible once Plan mode shipped: a plan generated in
Plan mode disappeared on refresh, and so did reasoning, which had been silently
missing from reopened threads all along.

Rather than paying for `full` across the whole first page, each turn tops
*itself* up. A turn entry records the `itemsView` it was fetched at, and a turn
rendered at `summary` detail fetches its own full items once via
`thread/items/list` filtered to that `turnId`, then marks itself `full`.

Because the transcript is virtualized, "when it renders" already means "when it
is on screen", and React Query dedupes by turn id — so on-screen-only fetching
needs no viewport bookkeeping. Persisted items for a completed turn never
change, so the query never refetches.

Turns assembled from live notifications carry no `itemsView` and are complete by
construction, so they are never topped up.

Three constraints keep the top-up from doing damage:

- **Only completed turns.** A running turn is being assembled from live
  notifications, so a persisted snapshot of it is behind by construction.
- **Merge, never replace.** A snapshot that lands after live items arrived only
  contributes items the turn does not already have, and never displaces a plan
  that streamed in.
- **Follow the cursor.** `thread/items/list` stays paged even when filtered to
  one turn, so reading a single page would silently truncate a long turn and —
  since the result is then marked `full` — never retry.
- **Empty-thread refusal is empty, not a compatibility fallback.** Pinned
  0.151.0 returns `-32601 thread/items/list is not supported yet` before the
  first user message. The backend matches method + code + exact wording,
  records a warning because the sentence is also used for a store without item
  pagination, and returns `[]`. It never walks full-detail turn pages.

A turn that is genuinely empty in summary view still gets a timeline entry so
the top-up has somewhere to mount, but renders nothing until it has content;
otherwise a turn whose only item was the user message would show a bare
assistant avatar.

## Turn markers

`contextCompaction`, `enteredReviewMode`, and `exitedReviewMode` render as
hairline dividers rather than cards — they punctuate the transcript instead of
contributing to it, and a card would read as another agent action.

Compaction can also start on its own via auto-compaction, so the marker is not
tied to `/compact` having been used.

## Fork with goal

`thread/fork` accepts a `deferGoalContinuation` flag that carries the source
thread's goal into the fork. It is **opt-in at the protocol level**, so an
ordinary native fork does not carry the goal — defaulting it on would diverge
from native behavior and leave two threads spending tokens on one objective.

The frontend therefore keeps one-click fork as-is and only prompts when the
source thread has a goal in a non-terminal status (`active`, `paused`,
`blocked`). The checkbox starts unchecked. The goal is fetched on demand at
click time, so listing threads costs no extra requests.

Carrying a goal is incompatible with ephemeral forks; the backend rejects that
combination, and this endpoint does not expose ephemeral forks at all.
