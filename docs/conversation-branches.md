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

| Table | Purpose |
|---|---|
| `conversation_branch_groups` | One version group per `(tree root, common prefix turn)`. |
| `conversation_branch_versions` | Original and branch siblings with preview text and the user-message turn id once known. A thread holds one row per group it participates in, so the tree root appears in every group created from its own turns. |
| `conversation_branch_edges` | Per-child fork provenance: parent, tree root, fork boundary, and `inheritedTurnIds`. Keyed by child because a thread has exactly one origin but participates in as many groups as it has edited turns — inlining provenance into version rows would duplicate it. |

## Provenance Read-Through

Token usage, turn diffs, and turn errors are **not copied** on fork. They are resolved at read time by walking the ancestor chain, which works because turn ids survive forking unchanged.

The walk is bounded by `inheritedTurnIds`, captured from the fork response (which returns the complete inherited prefix, so one hop already covers every ancestor). Without that bound a branch would surface per-turn data its parent produced *after* the fork point — most visibly by making "latest token usage" report the parent's newest turn.

Shared logic lives in `src/conversation-branches/provenance.ts` (`selectProvenanceRows`), with the nearest ancestor winning per turn.

Never inherited: pending approvals, user-input requests, active turn state, terminal contexts. These are bound to a generation, a request id, or a live connection.

## REST API

| Endpoint | Purpose |
|---|---|
| `GET /api/threads/branch-trees` | List locally tracked branch trees. |
| `GET /api/threads/:threadId/branch-tree` | Read one locally tracked branch tree. |
| `GET /api/threads/:threadId/branch-state` | Guard state from local topology only, so clients can disable compact without a round trip. |
| `POST /api/threads/:threadId/branches` | Fork before `editedTurnId`, persist topology, return the fork plus a tree snapshot. |

## Lifecycle Constraints

- **Archive/unarchive** operate on the whole known local tree. Every member is attempted even if one fails, then the first error is rethrown — stopping early leaves a half-archived tree, which is the broken-switcher state whole-tree semantics exist to prevent. Clients invalidate on settled, not on success.
- **Compact** is blocked when the thread has local descendants (checked first — it is free and authoritative, and must not be masked by an app-server outage) or app-server-visible external fork descendants. The external scan walks the full thread list, so it only runs on this write path; `branch-state` stays local-only because clients hit it on every thread open.

  This guard is **ours, not upstream's**. Measured against 0.149.0 with a real parent/child pair: `thread/compact/start` on a thread with a fork returns success. We block it anyway because compaction rewrites earlier turns while paginated forks address the parent by ordinal and byte offset (`history_base`), so a descendant's base can silently stop lining up. Not proven to corrupt — blocked as the conservative reading of a mechanism we cannot observe.
- **Delete** has no WebUI surface. The backend's `thread/delete` is used only to clean up a just-created untracked child. Upstream *does* reject deleting a forked-from thread — measured: `-32600: cannot delete thread <id>: forked history still references it`, with the child's history intact afterwards.
- Forks created outside this client stay ordinary conversations. Their `forkedFromId` is used for compact guarding only — they are never auto-adopted, because app-server does not expose the fork boundary and any adoption would have to guess it.

## Frontend

| Concern | Location |
|---|---|
| Version lookup + branch creation | `web/src/hooks/use-message-branches.ts` |
| `< n/m >` switcher | `web/src/components/chat/message-version-switcher.tsx` |
| Edit entry point + confirm dialog | `web/src/components/chat/chat-timeline.tsx` |
| Sidebar folding / activity lift / root highlight | `web/src/components/chat/sidebar/sidebar-types.ts` + `thread-sidebar.tsx` |

- **Timeline turn ids.** User entries carry `turnId`, filled during hydration and bound on `turn/started` for optimistically appended messages — mirroring `attachPendingVersionTurn` on the server. A message without a turn id cannot be branched, which is exactly the window in which branching is invalid anyway.
- **Cache invalidation.** A branch version has no turn until its edited message is sent, and the backend binds it during `turn/start`. `chat-input` therefore invalidates the branch-tree queries on a successful turn start; otherwise the switcher would stay hidden until the cache happened to expire.
- **Sidebar folding.** Branch members are folded into their tree root's row, and activity from a hidden branch is lifted onto that row so it does not sink in the list. A member is only folded when its root is on the same page — an active branch can sort onto page 1 while its older root does not, and folding it away then would make the whole conversation unreachable. Activity aggregation is likewise page-local.
- **Attention lift.** Running / awaiting-approval state from hidden branches surfaces on the visible root row, since the branch has no row of its own.
- **Deep links.** `/t/:branchThreadId` highlights the root row the branch lives under.
- **Layout stability.** The edit button stays mounted and disabled rather than unmounting, and both the populated and empty timeline states use `scrollbar-gutter: stable` — switching versions passes through the empty state, and a gutter appearing with it visibly shifts the whole message column.

## Empty Threads Report Differently Per Mode

A thread that was created but never sent to has no turns to read, and the two
history modes report that state with neither the same wording nor the same code
(measured on 0.149.1):

| Mode | `thread/read` with `includeTurns` |
|---|---|
| legacy | `-32600 ... is not materialized yet; includeTurns is unavailable before first user message` |
| paginated | `-32601 list_turns is not supported yet` — names the unimplemented backing call, not the state |

`isNotMaterializedError` must match both. Because `thread/start` marks the new
thread as resumed, the client's first `resume` goes through `readAsResume` →
`thread/read includeTurns` and hits this immediately: missing the paginated
wording makes every newly created conversation fail with 502.

This is also why the predicate is not gated on an error code — the codes differ
per mode.

## Protocol Notes

The generated app-server type surface includes neither `historyMode` nor `beforeTurnId`, so both are isolated behind local type extensions. Both were verified against a live 0.149.0 app-server: `historyMode` *is* echoed on the returned thread, and a paginated fork response *does* carry the inherited prefix turns.

`thread/turns/list` replays the whole rollout per page (confirmed from upstream source), so pagination saves transfer but not server IO. Nothing here depends on cheap random-access pagination — branch creation uses `thread/read includeTurns`, and inherited data comes from local provenance.

## Explicitly Excluded

Per the "no native primitive, no feature" rule: regenerating an assistant reply (no turn-level primitive), branch merging (no merge primitive, and injecting items across branches produces silent context confusion), and workspace/file-state branching (`GhostCommit` was removed in 0.149; a git-based substitute would fight the user over a shared working tree).

Not built yet, but possible: branch deletion, branch graph visualization, startup reconciliation of local topology against server state.
