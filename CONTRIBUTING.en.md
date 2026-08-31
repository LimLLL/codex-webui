# Contributing

Thanks for wanting to help out with Codex WebUI.

[简体中文](./CONTRIBUTING.md)

---

## Before you start

**Codex WebUI is a web frontend for the [OpenAI Codex CLI](https://github.com/openai/codex), not a standalone agent implementation.** That draws three boundaries:

1. **`codex app-server` is the single source of truth.** Threads, turns and rollout history all come from the app-server; the WebUI only projects them and persists what it has to locally (branch topology, token usage, approval state, and so on).
2. **Capabilities the upstream has no primitive for are not simulated client-side.** If a feature requires the WebUI to fake semantics the app-server does not provide, it usually won't be accepted — patches like that inevitably rot as the protocol evolves. Skim the vendored protocol docs in [`docs/upstream/`](docs/upstream/README.md) before proposing one.
3. **No new third-party dependencies on your own initiative.** Prefer what the project already depends on, or the standard library. If a new dependency really is needed, explain why in an issue and wait for confirmation — don't slip it in with a PR.

Before you write code:

- **Fixing a bug** — open a [bug issue](../../issues/new?template=bug_report.yml), or send a PR referencing the issue number.
- **New feature / refactor** — **please open an issue to discuss the approach first.** A large PR heading in the wrong direction is expensive to redo, for both of us.
- **Docs and typos** — just send the PR, no issue needed.

---

## Development setup

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 20 (the image uses 22) | `node-pty` and `better-sqlite3` are native modules and must be rebuilt after switching Node versions |
| pnpm | 10.x | `corepack enable` is recommended so the version follows the `packageManager` field |
| Codex CLI | follows the devDependency | No global install needed, see below |

`pnpm install` pulls `@openai/codex` in as a devDependency at `node_modules/.bin/codex`, and the build scripts prefer that binary — so **protocol type generation does not depend on whichever codex you have installed globally**. Actually running a conversation still needs a Codex environment (`~/.codex`) that is logged in or configured with an API key.

### Steps

The backend and the frontend are **two separate pnpm projects** (`web/` has its own lockfile), so dependencies are installed twice:

```bash
git clone https://github.com/LimLLL/codex-webui.git
cd codex-webui

pnpm install                 # backend deps
cd web && pnpm install && cd ..   # frontend deps

cp .env.example .env         # at minimum, fill in WEBUI_API_KEY

pnpm start:dev               # backend, port 8172 by default
cd web && pnpm dev           # frontend, port 5173, proxies /api and /socket.io
```

Open `http://localhost:5173` and log in with the `WEBUI_API_KEY` from `.env`.

The first build/test/lint automatically runs `pnpm codex:schema`, generating the app-server TS types into `src/codex/codex-schema/`. **That directory is not checked in** — it is regenerated whenever it's missing locally.

### After changing Node versions

Native modules have to be rebuilt or the backend won't start:

```bash
cd node_modules/.pnpm/node-pty@*/node_modules/node-pty && npx node-gyp rebuild
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npx node-gyp rebuild
```

---

## Common commands

| Command | What it does |
|---------|--------------|
| `pnpm start:dev` | Backend in watch mode |
| `pnpm build` | Compile the backend into `dist/` |
| `pnpm test` / `pnpm test:cov` | Backend tests / with coverage |
| `pnpm lint` | ESLint with auto-fix — **also runs the frontend lint** |
| `pnpm codex:schema` | Regenerate the app-server TS types |
| `pnpm generate:api` | Regenerate the frontend SDK from the backend OpenAPI spec (backend must be running) |
| `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:studio` | Generate a migration / apply migrations / open Drizzle Studio |
| `cd web && pnpm dev` / `pnpm build` / `pnpm test` | Frontend dev / build into `../public/` / tests |
| `npx vitest run src/files/files.service.spec.ts` | Run a single test file |

**Verify your changes with `pnpm lint`, not `tsc --noEmit`.**

---

## Project layout

The architecture overview is in [`docs/codexwebui-architecture.md`](docs/codexwebui-architecture.md), and the per-module doc index lives in [`CLAUDE.md`](CLAUDE.md) (that file is written for AI assistants, but the module table and doc index are just as useful for humans).

- `src/` — NestJS backend, one module per feature (controller + service + module)
- `web/src/` — React frontend: `routes/` pages, `components/` components, `stores/` Zustand, `hooks/` custom hooks, `generated/api/` the generated SDK
- `docs/` — implementation docs, **version-controlled and public**
- `drizzle/` — database migrations

**Don't change the established directory structure or layering without saying so.**

---

## Code conventions

- **Backend**: NestJS module pattern — one controller + service + module per feature.
- **Frontend**: components in `components/`, state in `stores/`, hooks in `hooks/`, types in `types/`.
- **Formatting**: ESLint (`recommendedTypeChecked`) + Prettier, single quotes, trailing commas. The generated schema and SDK are excluded.
- **File length**: aim for at most 500 lines per file (comments included); split it once you go over.
- **Comments**: a one-line purpose comment at the top of each module; JSDoc on public methods (purpose / params / returns / throws); JSDoc on TS `interface`, `type` and `enum`; inline comments only for logic that isn't obvious — don't restate the code.
- **i18n**: all copy goes through `react-i18next`, where **the key is the English source string**, with Chinese translations added to `web/src/locales/zh-CN.json`. Don't hardcode display strings into components.
- **Logging**: use Pino. Log inputs, branch decisions and exceptions; **never log inside loops or hot paths**; sensitive fields rely on the redact config.
- **Error handling**: handle recoverable errors close to where they happen and log them; let unrecoverable ones fail fast and propagate. **Don't swallow exceptions silently.**
- **Scope**: one PR does one thing. If you spot an unrelated problem you could fix in passing, open a separate issue or PR.

---

## Tests

Both sides use Vitest, with test files colocated next to the code under test (`.spec.ts` / `.spec.tsx`).

**Worth testing**: core business logic (input → expected output), boundaries and error paths that regress easily, external integrations (with minimal mocking).

**Not worth testing**: anything written just to bump coverage, duplicate or redundant tests, implementation details (specific colour values, class names), and tests so heavily mocked they no longer reflect reality.

Two traps that are easy to fall into:

- **The backend must use SWC as its only transformer** (`unplugin-swc` + `esbuild: false` + `oxc: false`). Both esbuild and Oxc drop the `emitDecoratorMetadata` that NestJS dependency injection reads, and the failure surfaces as an "unresolvable parameter index" rather than a build error — which makes it very hard to track down. `app.module.spec.ts` compiles the whole dependency graph as a canary.
- **DB-backed services use the in-memory SQLite from `src/database/database.testing.ts`**, which applies the real `drizzle/` migrations, so schema drift fails the suite outright. **Never hand-copy DDL into a spec.**

---

## Database migrations

After changing a schema under `src/database/`:

```bash
pnpm db:generate    # generate the migration
pnpm db:migrate     # apply it locally
```

Commit the newly generated files under `drizzle/` along with your change. **Don't hand-write migration files, and don't modify migrations that have already been committed** — other people's databases have already run them.

---

## Backend API changes

The frontend SDK (`web/src/generated/api/`) is generated from the backend's OpenAPI spec. After changing a controller or a DTO:

```bash
pnpm start:dev            # start the backend first
pnpm generate:api         # in another terminal
```

Commit the generated output. **Don't hand-edit files under `generated/`** — the next generation wipes them.

---

## Upgrading the Codex CLI

The `@openai/codex` devDependency pins the entire protocol surface. **Bumping it is a protocol migration, not a version bump.** The process is:

1. Change the version and reinstall.
2. Run `pnpm codex:schema` to regenerate the types, and **diff them field by field** for removals, renames and semantic changes.
3. Update the vendored protocol docs under [`docs/upstream/`](docs/upstream/README.md), keeping them on the same tag as the CLI.
4. Run the full test suite, paying particular attention to JSON-RPC calls and notification handling.

One thing worth knowing: **not exported in the schema ≠ unsupported at runtime.** Methods described in the upstream docs but missing from the generated types are usually callable; confirm by testing rather than assuming they're unavailable.

---

## Documentation

**Updating the docs is part of shipping a change, not an optional extra.** Checklist:

1. `CLAUDE.md` — index information such as the module table and the frontend structure table (one-line summaries only).
2. `docs/` — go through each affected document.
3. `docs/remaining-tasks.md` — tick off completed items and add newly discovered ones.

⚠️ **`docs/` is version-controlled and public** — never put personal information, absolute paths, hostnames or secrets in it.

---

## Commits and pull requests

**Commit messages** follow Conventional Commits:

```
type(scope): short description

feat(threads): add cascade confirmation for branch deletion
fix(web): fix Socket.IO connection under sub-path deployment
docs: update reverse proxy configuration notes
```

Common `type` values: `feat` `fix` `docs` `test` `refactor` `build` `chore` `improve`. Use a module name for `scope` (`threads` `codex` `files` `web` `terminal`, …). English or Chinese are both fine; the existing history is mostly Chinese.

**PR process**:

1. Branch off `main`.
2. Run `pnpm lint`, `pnpm test` and `cd web && pnpm test` before submitting.
3. Fill in the PR template with what changed and how you verified it — **leave a checkbox empty if you didn't actually run that check**, don't tick it out of habit.
4. One PR solves one problem.

---

## License

This project is licensed under [AGPL-3.0 or later](LICENSE) (`AGPL-3.0-or-later`), copyright LimLLL. **Submitting a pull request means you agree to release your contribution under that license.**

Note the AGPL network clause: if you modify this project and offer it as a service over a network, you must provide users with the complete modified source.

---

## Security

**Please do not report security vulnerabilities in public issues** — see [SECURITY.md](SECURITY.md).