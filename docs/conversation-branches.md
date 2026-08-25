# Conversation Branches

## Scope

Message-level conversation branching. Editing a historical user message creates a sibling version by calling `thread/fork` before the edited turn; the original continuation stays available as another version, switchable via a `< n/m >` control on the message.

Each version is a real app-server thread. Switching versions is therefore ordinary thread navigation — the chat route is already fully driven by the URL thread id, so no store surgery was needed.

## Server Rules

- New `POST /api/threads` requests include experimental `historyMode: "paginated"`. If app-server does not confirm paginated mode, the backend best-effort deletes the new thread and fails the request.
- Branch creation uses only `thread/fork` with experimental `beforeTurnId`. The in-place `thread/revert` path is intentionally unused: it rewrites history while keeping the thread id, which would give the client two sources of truth that are indistinguishable by id.
- `beforeTurnId` is preferred over `lastTurnId` because it also accepts interrupted turns. `lastTurnId` rejects them, and interrupted turns are roughly 1 in 13 in practice — all of which would otherwise be uneditable.
- The fork response is validated against the expected prefix before anything is persisted. A mismatch deletes the child and fails the request rather than recording a branch whose history is not what was asked for.
- The original version is stored as a normal version row. Branch versions are created with `messageTurnId = null` and bound to the next `turn/start` for that child thread.
- Metadata is written in one transaction after a successful fork and before the client sends the edited message. If persistence fails, the backend attempts `thread/delete` on the child; cleanup failure is reported rather than swallowed.

## Grouping Key

```
(treeRootThreadId, commonPrefixTurnId | "__start__")
```

The key is the **last turn of the common prefix**, not the edited turn. Editing the same logical message from inside a branch names a different edited turn each time (`T2` vs `T2b`) while the prefix is unchanged, so keying on the edited turn would split one expected switcher into several. `__start__` is the sentinel for an empty prefix, i.e. editing the first message — which needs no special path, because `beforeTurnId` on the first turn returns an empty prefix.

**Groups are path-local.** The original version row is written for the thread the edit was made in. Editing a turn inherited from an ancestor therefore registers a switcher inside the branch, but not in the ancestor. This is intended: the ancestor's copy of that turn is byte-identical and is not an alternative version of anything.

## SQLite Tables

| Table                          | Purpose                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `conversation_branch_groups`   | One version group per `(tree root, common prefix turn)`.                                                                                                                                                                                                                                         |
| `conversation_branch_versions` | Original and branch siblings with preview text, source (`local` or `adopted`), and the user-message turn id once known. A thread holds one row per group it participates in, so the tree root appears in every group created from its own turns.                                                 |
| `conversation_branch_edges`    | Per-child fork provenance: parent, tree root, fork boundary, source (`local` or `adopted`), and `inheritedTurnIds`. Keyed by child because a thread has exactly one origin but participates in as many groups as it has edited turns — inlining provenance into version rows would duplicate it. |

## Startup Adoption Scanner

At app-server readiness, the backend runs a one-shot scanner over Codex session rollout files under `codexHome` as reported by `initialize`. It reads private `session_meta` headers and, for paginated forks, the `history_base` record to adopt forks this client did not create.

The scan is deliberately two-pass. Every file contributes only its metadata header — read by pulling bytes until the first newline, not by loading the file — and only files that take part in a fork chain (both ends of every fork, plus ancestors, since an inherited prefix can span the chain) are then parsed in full. A Codex home accumulates far more history than fork topology: measured on a real home of 1120 rollouts totalling 1.6 GB, the header pass covers all 1120 while only 15 files need a full read, finishing in ~320 ms against ~4.7 s for parsing everything. This matters beyond startup cost because deletion is gated on scanner readiness.

Scanner rules:

- Locally created rows always win. The scanner never overwrites rows with `source = "local"`.
- Scanner-owned rows are disposable. Each scan replaces previous `source = "adopted"` rows with the current observation.
- Paginated forks with a reconstructible boundary become normal topology edges. They become **version** rows only when the boundary replaces a user message **and the child actually carries a replacement message of its own**. Both halves matter: an abandoned or probe fork that forked at a message boundary but never sent anything would otherwise appear in the user's `< n/m >` switcher as an edit nobody made. Such forks are still adopted — as topology, which is all that can honestly be said about them.
- Plain forks and forks after the parent's last known turn are adopted as topology only, using `__end__` as the boundary sentinel. They do not render as message-version switchers.
- Legacy-history forks with no `history_base` are skipped and reported as diagnostics rather than guessed.
- Malformed files, impossible offsets, cycles, and contradictions with local rows are logged as diagnostics. Error diagnostics block deletion for affected trees.

`GET /api/threads/branch-adoption/status` exposes scanner readiness, counts, and diagnostics. Destructive deletion is gated on this scanner state; preview and execute fail while the scanner is pending, running, or failed.

Two traps worth recording, both found by measurement:

- **`originator` in the rollout header does not identify the client.** Threads this WebUI created report `originator: codex-tui` just as TUI-created ones do. Ownership is decided solely by our own `source` column, never by anything read off disk.
- **The scan and app-server answer different questions.** The scanner reads what is on disk; the planner reads what app-server currently lists. Adopted topology is therefore an observation, not an authority, and deletion always re-derives its cascade from a live `thread/list` rather than trusting adopted rows.

## Provenance Read-Through

Token usage, turn diffs, and turn errors are **not copied** on fork. They are resolved at read time by walking the ancestor chain, which works because turn ids survive forking unchanged.

The walk is bounded by `inheritedTurnIds`, captured from the fork response (which returns the complete inherited prefix, so one hop already covers every ancestor). Without that bound a branch would surface per-turn data its parent produced _after_ the fork point — most visibly by making "latest token usage" report the parent's newest turn.

Shared logic lives in `src/conversation-branches/provenance.ts` (`selectProvenanceRows`), with the nearest ancestor winning per turn.

Never inherited: pending approvals, user-input requests, active turn state, terminal contexts. These are bound to a generation, a request id, or a live connection.

## REST API

| Endpoint                                    | Purpose                                                                                                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/threads/branch-trees`             | List locally tracked branch trees. Roots are the **union of version-group roots and fork-edge roots** — a topology-only fork has an edge but no group, and enumerating from groups alone hid those trees from every caller that discovers descendants through this list. |
| `GET /api/threads/branch-adoption/status`   | Read startup adoption scanner status and diagnostics.                                                                                                                                                     |
| `GET /api/threads/:threadId/branch-tree`    | Read one locally tracked branch tree.                                                                                                                                                                     |
| `GET /api/threads/:threadId/branch-state`   | Guard state from persisted local/adopted topology, so clients can disable compact without a per-request app-server scan.                                                                                  |
| `POST /api/threads/:threadId/branches`      | Fork before `editedTurnId`, persist topology, return the fork plus a tree snapshot.                                                                                                                       |
| `GET /api/threads/:threadId/delete-preview` | Plan deletion of a thread and every fork descendant. Returns the exact id set, leaf-to-root order, running threads, pending approvals, and blockers.                                                      |
| `POST /api/threads/:threadId/delete`        | Execute deletion for the confirmed `expectedThreadIds` set. Replans before execution and after auto-interrupt; drift returns a structured conflict/partial result instead of deleting an unconfirmed set. |

## Lifecycle Constraints

- **Archive/unarchive** operate on the whole known local tree. Every member is attempted even if one fails, then the first error is rethrown — stopping early leaves a half-archived tree, which is the broken-switcher state whole-tree semantics exist to prevent. Clients invalidate on settled, not on success.
- **Compact** is blocked when the thread has local descendants (checked first — it is free and authoritative, and must not be masked by an app-server outage) or app-server-visible external fork descendants. The external scan walks the full thread list, so it only runs on this write path; `branch-state` stays local-only because clients hit it on every thread open.

  This guard is **ours, not upstream's**. Measured against 0.149.0 with a real parent/child pair: `thread/compact/start` on a thread with a fork returns success. We block it anyway because compaction rewrites earlier turns while paginated forks address the parent by ordinal and byte offset (`history_base`), so a descendant's base can silently stop lining up. Not proven to corrupt — blocked as the conservative reading of a mechanism we cannot observe.

- **Delete** is exposed as one backend primitive: delete the target thread and every descendant in fork topology. The frontend uses the same primitive for whole-tree deletion (target is the root) and version deletion (target is that version thread).
- Delete previews and execution plans are topology-based, not version-group-based. A version delete can remove descendants belonging to other groups, and the preview must enumerate that true cascade set.
- Execution is non-atomic and order-constrained: replan against `expectedThreadIds`, claim the in-process delete guard, auto-interrupt active doomed turns, replan again, then call `thread/delete` leaf-to-root. Local cleanup is committed after each server-side success or confirmed already-gone response.
- Pending approvals in doomed threads are marked `cancelled` only once the thread has actually been interrupted or removed. Requests that arrive mid-delete are still recorded as `pending` and merely suppressed from the live broadcast: terminalizing them on arrival would strand the request if the delete then aborts, since the UI never displayed it, `respond` refuses an already-resolved row, and app-server would still be waiting. Late approval responses are rejected for as long as the thread is under the delete guard.
- A server-side not-found response for a confirmed doomed thread is treated as convergence toward gone, but local branch rows are only reaped if doing so will not orphan a surviving local child.
- Version groups are dissolved when fewer than two versions survive. Surviving groups are resequenced by prior `versionIndex`; provenance roles are never promoted or rewritten.
- Runtime state tied to removed threads is torn down during local cleanup: branch rows, token usage, turn diffs, turn errors, pending approvals, and resume registry entries.

## Frontend

| Concern                                          | Location                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| Version lookup + branch creation                 | `web/src/hooks/use-message-branches.ts`                                   |
| `< n/m >` switcher                               | `web/src/components/chat/message-version-switcher.tsx`                    |
| Edit entry point + confirm dialog                | `web/src/components/chat/chat-timeline.tsx`                               |
| Sidebar folding / activity lift / root highlight | `web/src/components/chat/sidebar/sidebar-types.ts` + `thread-sidebar.tsx` |
| Tidy-tree layout (renderer-free)                 | `web/src/lib/branch-graph-layout.ts`                                      |
| Branch graph surfaces + node body                | `web/src/components/branches/branch-graph.tsx`, `branch-graph-node.tsx`   |
| Browse graph dialog                              | `web/src/components/branches/branch-graph-dialog.tsx`                     |
| Cascade delete confirmation                      | `web/src/components/branches/delete-conversation-dialog.tsx`              |
| Delete preview/mutation + scanner gating         | `web/src/hooks/use-thread-deletion.ts`                                    |

- **Timeline turn ids.** User entries carry `turnId`, filled during hydration and bound on `turn/started` for optimistically appended messages — mirroring `attachPendingVersionTurn` on the server. A message without a turn id cannot be branched, which is exactly the window in which branching is invalid anyway.
- **Cache invalidation.** A branch version has no turn until its edited message is sent, and the backend binds it during `turn/start`. `chat-input` therefore invalidates the branch-tree queries on a successful turn start; otherwise the switcher would stay hidden until the cache happened to expire.
- **Sidebar folding.** Branch members are folded into their tree root's row, and activity from a hidden branch is lifted onto that row so it does not sink in the list. A member is only folded when its root is on the same page — an active branch can sort onto page 1 while its older root does not, and folding it away then would make the whole conversation unreachable. Activity aggregation is likewise page-local.
- **Attention lift.** Running / awaiting-approval state from hidden branches surfaces on the visible root row, since the branch has no row of its own.
- **Deep links.** `/t/:branchThreadId` highlights the root row the branch lives under.
- **Layout stability.** The edit button stays mounted and disabled rather than unmounting, and both the populated and empty timeline states use `scrollbar-gutter: stable` — switching versions passes through the empty state, and a gutter appearing with it visibly shifts the whole message column.

### Branch Graph

Rendered with `@xyflow/react` over a `d3-hierarchy` tidy-tree layout. Layout is a pure function with no renderer dependency, so the same coordinates drive both surfaces; the surfaces themselves are separate components rather than one behind a `mode` flag, because the browse graph owns pan/zoom while the confirmation thumbnail must stay inert.

- **Why a library.** Layout is the part worth buying: a naive depth/sibling placement overlaps subtrees as soon as the shape is uneven, and d3 implements Reingold–Tilford properly. React Flow then supplies the viewport, node virtualization, and DOM-rendered (screen-reader reachable) nodes. **Only React Flow is lazily imported** (its own ~179 kB chunk); `d3-hierarchy` sits in the entry chunk, because the confirmation dialog's authoritative indented list is built from the same layout and must render synchronously. That is the intended trade — d3-hierarchy is a few kB gzipped, and putting an async boundary in front of the list would delay the part of the dialog that actually matters.
- **Dark mode.** React Flow scopes its dark variables to `.react-flow.dark`, not to an ancestor, so the app's `.dark` on `<html>` does not reach it. The `colorMode` prop is mirrored from the theme store; without it the built-in controls and the attribution badge stay light on a dark dialog.
- **Node clicks go through `onNodeClick`.** With selection and dragging both disabled React Flow stops delivering pointer events to the node body, so a handler on the node's own element silently never fires.
- **A node is a thread, and a thread belongs to more than one group.** It is the `branch` row of the group it was forked into, and the `original` row of every group created by editing one of its own later messages — each with a different preview. Collapsing those onto the thread id lets whichever row is read last win, which labels a branch after an edit made *inside* it and makes its real label disappear from the graph. `BranchTreeMemberDto.commonPrefixTurnId` exists to resolve this: it names the group that created the member, so a client can pick the row that says how the member differs from its parent. The tree root has none (it was not forked from anything) and falls back to the group its children forked out of, then to the app-server's own thread preview.
- **A group's `original` is never deletable from that group's switcher.** Every other version in a group is a fork of the original, so the cascade that removes it removes the whole group — and the thread hosting it, which the user knows by an entirely different message. The check is per group, not per thread: one thread is the `original` of the group made from its own later turns while remaining a deletable `branch` of the outer group it was forked into, so the same trash icon is correct on one switcher and wrong on another. This subsumes the earlier root/non-root rule, since the tree root is just the `original` of the outermost group. The button stays visible but disabled with the reason, because silently omitting it on version 1 of every group teaches the user nothing. The underlying property is asserted in `conversation-branches.service.spec.ts` rather than left to the UI.
- **Edges carry the edited message.** The parent's label only says which message *it* was named after, so when a child branched from some later message inside the parent, nothing else on screen says which one. The edge is therefore labelled with the `original` row of the child's group — but only when that differs from the parent's own label, since otherwise it just restates the parent node. The lookup is guarded on the child actually being a member of that group: a topology-only fork carries a common prefix without belonging to any group, and matching on the prefix alone would hand it the message of whichever real group shares that prefix.
- **`external` and `boundaryUnknown` are different claims.** Adoption reconstructs a fork point precisely from `history_base`, so an adopted branch is *not* a branch whose fork point is unknown. Every member of a branch tree comes from a persisted edge, and an edge is only written once the boundary is known — so `boundaryUnknown` is always false in the browse graph. Forks whose boundary really is unrecorded never become edges; they reach the delete planner from app-server's `forkedFromId` (`source: 'server'`), which is the only place that flag belongs.
- **Node contents.** Preview text, creation time, plus running / pending-approval / archived / external-branch markers. Creation time is joined from the thread list rather than stored locally. **Turn count is deliberately absent**: `thread/list` returns an always-empty `turns` array, and the only source is a full `thread/read includeTurns` per node — measured at 3 MB / 174 ms for a single 39-turn thread, so a ten-node graph would fetch tens of megabytes to print one number. Counting locally persisted per-turn rows was rejected as well: it silently undercounts turns produced outside this client.
- **Doomed styling is not colour-only.** Nodes in a pending cascade get a destructive tint, a strikethrough label, and an icon, so the marking survives low-contrast dark themes and colour vision deficiency.
- **`Selected for deletion` only appears in the confirmation.** It marks the node the cascade was launched from. In the browse graph every node is equally "the one you opened it from", so the badge is suppressed there rather than restating the entry point.

### Delete Confirmation

- The **indented list is authoritative** and is the sole affordance on narrow screens; the graph beside it explains structure that indentation conveys poorly. Both are built from the server's plan, never from local topology, so what is shown is what the server will act on.
- The preview query is uncached (`staleTime: 0`, `gcTime: 0`). The backend re-plans and rejects a mismatched id set, so a stale preview cannot delete the wrong things — but it could describe the wrong things, which is the failure the flow exists to prevent.
- Navigation away happens on mutate, not on success: the user has already consented, and remaining inside a doomed thread produces resume and turn requests the backend now rejects.
- **Where it navigates to depends on the entry point.** Deleting a version is not deleting the conversation, so the switcher's delete steps back to the nearest earlier surviving version — the one `< n/m >` would have moved to — and only falls through to the empty state when nothing in the group survives. The sidebar's delete removes a whole tree and therefore always lands on the empty state. The sibling ordering is captured when the dialog opens rather than looked up on confirm, because the group is about to change underneath it.
- Local runtime for destroyed threads is dropped through `forgetThreads`, not `unsubscribeThread`. The latter only leaves the socket room; the runtime survives in `threadsById` and would be handed back to a deep link or a back navigation. The selected thread needs care of its own: it lives in top-level store fields, and the ordinary `selectThread(null)` path persists it into `threadsById` on the way out, resurrecting exactly what is being deleted.
- **Refresh is coalesced.** A delete produces `thread/status/changed`, `thread/deleted`, *and* the mutation's own settle callback. Each used to invalidate independently, so the thread list refetched twice at different times; because the sidebar reorders rows from that data (branch activity is lifted onto the root row), the row visibly moved twice per delete. All three now share the debounced invalidators in `web/src/lib/query-invalidation.ts`.
- Every delete entry point is disabled until the adoption scanner reports `ready`, with the reason surfaced in the tooltip.

## Empty Threads Report Differently Per Mode

A thread that was created but never sent to has no turns to read, and the two
history modes report that state with neither the same wording nor the same code
(measured on 0.149.1):

| Mode      | `thread/read` with `includeTurns`                                                              |
| --------- | ---------------------------------------------------------------------------------------------- |
| legacy    | `-32600 ... is not materialized yet; includeTurns is unavailable before first user message`    |
| paginated | `-32601 list_turns is not supported yet` — names the unimplemented backing call, not the state |

`isNotMaterializedError` must match both. Because `thread/start` marks the new
thread as resumed, the client's first `resume` goes through `readAsResume` →
`thread/read includeTurns` and hits this immediately: missing the paginated
wording makes every newly created conversation fail with 502.

This is also why the predicate is not gated on an error code — the codes differ
per mode.

## Protocol Notes

The generated app-server type surface includes neither `historyMode` nor `beforeTurnId`, so both are isolated behind local type extensions. Both were verified against a live 0.149.0 app-server: `historyMode` _is_ echoed on the returned thread, and a paginated fork response _does_ carry the inherited prefix turns.

`thread/turns/list` replays the whole rollout per page (confirmed from upstream source), so pagination saves transfer but not server IO. Nothing here depends on cheap random-access pagination — branch creation uses `thread/read includeTurns`, and inherited data comes from local provenance.

## Why Editing a Message Forks

`thread/fork` with `beforeTurnId` is what the upstream TUI itself uses for its
Esc-Esc "edit the previous user message" flow — the parameter was added for that
purpose (openai/codex#33211, _"use before-turn forks for TUI backtracking and
safety retries"_), and the CLI docs describe the gesture as forking the chat from
that point. So the primitive here matches upstream rather than working around it.

What does **not** match upstream is the presentation. The TUI forks and simply
moves the user into the new thread; there is no version switcher, and the old
thread is just another entry in the session list. Surfacing the fork as a
first-class version topology — switchers, groups, cascade rules — is this
client's own layer, and every sharp edge documented above (a thread belonging to
several groups, an `original` that cannot be deleted, label ambiguity) is a cost
of that layer, not of the fork.

`thread/revert` (experimental, added by openai/codex#38440) would give in-place
rewind semantics instead: it replaces a loaded paginated thread's durable history
with the prefix before `beforeTurnId` and keeps the thread id. It is
**deliberately not used**. Two reasons, in order: keeping the thread id while
rewriting history makes local branch metadata and server history two sources of
truth that cannot be reconciled from the id alone, and the rewind is
irreversible, which is a strictly weaker product than a switcher the user can
move back and forth on. Its existence is not a defect in the current design —
choosing it would be choosing a different product.

## Explicitly Excluded

Per the "no native primitive, no feature" rule: regenerating an assistant reply (no turn-level primitive), branch merging (no merge primitive, and injecting items across branches produces silent context confusion), and workspace/file-state branching (`GhostCommit` was removed in 0.149; a git-based substitute would fight the user over a shared working tree).

Not built yet, but possible: durable background delete jobs, periodic scanner reruns, per-node turn counts in the graph (needs either a lazy per-node fetch or a lightweight server-side count endpoint), and replacing the private-file scanner if app-server exposes fork boundaries through JSON-RPC.
