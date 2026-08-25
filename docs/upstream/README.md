# Vendored upstream documentation

Files in this directory are **verbatim copies of upstream Codex documentation**,
kept here so protocol questions can be answered from the exact revision this
project is pinned to rather than from whatever `main` happens to say today.

Do not edit them. Fix anything wrong by refreshing from upstream.

| File | Upstream path | Tag |
|---|---|---|
| `codex-app-server-0.149.1.md` | `codex-rs/app-server/README.md` | `rust-v0.149.1` |

The tag matches the `@openai/codex` version pinned in the root `package.json`.
Refresh after bumping that dependency — a protocol migration is exactly when a
stale copy is most likely to mislead:

```bash
VERSION=$(node -p "require('./package.json').devDependencies['@openai/codex']")
curl -fsSL \
  "https://raw.githubusercontent.com/openai/codex/rust-v${VERSION}/codex-rs/app-server/README.md" \
  -o "docs/upstream/codex-app-server-${VERSION}.md"
```

Note that the README documents the *intended* protocol. Several behaviours this
project depends on were established by measurement instead, because they are
either undocumented or contradict the text — the experimental `beforeTurnId`
fork boundary, the on-disk `history_base` record, and the exact wording of
rejection messages among them. Where this directory and
[../conversation-branches.md](../conversation-branches.md) disagree, the
measured behaviour recorded there is the one the code was written against.
