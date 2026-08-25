# Codex WebUI — Frontend

React 19 + Vite 8 client for the Codex WebUI backend. Talks to it over `REST /api/*` and
Socket.IO (`/socket.io`, namespace `/ws`); `pnpm dev` proxies both to `localhost:8172`.

Build output goes to `../public/`, which the NestJS `ServeStaticModule` serves — so the
production image ships a single origin with no separate frontend host.

## Commands

```bash
pnpm dev            # Dev server on :5173, proxying /api + /socket.io to the backend
pnpm build          # tsc -b + vite build → ../public/
pnpm test           # Vitest (jsdom + Testing Library)
pnpm test:watch     # Vitest in watch mode
pnpm lint           # ESLint
pnpm generate:api   # Regenerate the Hey API SDK from the backend OpenAPI spec
                    # (requires the backend to be running)
```

Add a shadcn/ui component with `npx shadcn@latest add <component>`.

## Layout

| Path | Contents |
|------|----------|
| `src/routes/` | TanStack Router pages |
| `src/components/` | UI components (`ui/` is shadcn/Radix) |
| `src/stores/` | Zustand stores — `timeline-store` holds per-thread state |
| `src/hooks/` | Socket, thread-opening, breakpoint and file hooks |
| `src/generated/api/` | Hey API SDK — generated, do not edit |
| `src/test/setup.ts` | Vitest setup (Testing Library cleanup) |

## Tests

Colocated `*.spec.ts` / `*.spec.tsx`, run by Vitest with `globals: true` against jsdom.
`vitest.config.ts` merges `vite.config.ts` so tests resolve the `@` alias and use the same
React plugin as the build rather than a second, drifting copy.

## Docs

Architecture and per-subsystem docs live in [`../docs/`](../docs/); start with
[`frontend-ui.md`](../docs/frontend-ui.md) and [`frontend-state.md`](../docs/frontend-state.md).
