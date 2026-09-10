# Vendored upstream documentation

Files in this directory are **verbatim upstream artifacts** kept so protocol
questions can be answered from the exact revision this project is pinned to
rather than from whatever `main` happens to say today.

Do not edit them. Fix anything wrong by refreshing from upstream.

Starting with `rust-v0.154.0`, upstream removed
`codex-rs/app-server/README.md`. The versioned local copy therefore stops at
0.153.2; current protocol intent is documented on the official Codex App Server
documentation site, while the exact pinned wire contract is generated locally
with `pnpm codex:schema`.

Note that the README documents the *intended* protocol. Several behaviours this
project depends on were established by measurement instead, because they are
either undocumented or contradict the text — the experimental `beforeTurnId`
fork boundary, the on-disk `history_base` record, and the exact wording of
rejection messages among them. Where this directory and
[../conversation-branches.md](../conversation-branches.md) disagree, the
measured behaviour recorded there is the one the code was written against.

## Bundled model catalog

`model-catalog-0.154.0.json` is the complete deterministic output of the pinned binary's
`codex debug models --bundled`, including instruction text and hidden entries. Refresh
with `pnpm codex:catalog`; update the script's versioned target when bumping the CLI.
It is a bundled baseline, not an authenticated account's effective remote catalog.
`CODEX-LICENSE` and `CODEX-NOTICE` retain upstream distribution notices.
