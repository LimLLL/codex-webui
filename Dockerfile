# ── Stage 1: Frontend build ──────────────────────────────────────────
FROM node:22-bookworm-slim AS frontend-builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# ── Stage 2: Backend build ───────────────────────────────────────────
FROM node:22-bookworm-slim AS backend-builder
# node-pty requires native compilation tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate
# Install pinned Codex CLI for schema generation during build
ARG CODEX_CLI_VERSION=0.123.0
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY src/ ./src/
COPY tsconfig*.json nest-cli.json ./
COPY --from=frontend-builder /app/public ./public/
RUN pnpm build

# ── Stage 3: Runtime ─────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
# Runtime dependencies: git, bash (terminal), node-pty native rebuild deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates git bash curl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install pinned Codex CLI version (must match builder for schema compat)
ARG CODEX_CLI_VERSION=0.123.0
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION}

WORKDIR /app
ENV NODE_ENV=production

# Copy package manifests and install production dependencies
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod
# Rebuild node-pty for this runtime environment
RUN npx --yes node-gyp rebuild --directory=node_modules/node-pty || true

# Copy built assets
COPY --from=backend-builder /app/dist ./dist/
COPY --from=backend-builder /app/public ./public/

# Create volume mount points and set ownership for non-root user
RUN mkdir -p /workspaces /codex-home /app/logs \
  && chown -R node:node /workspaces /codex-home /app/logs /app
USER node

EXPOSE 8172
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf -H "Authorization: Bearer ${WEBUI_API_KEY}" http://localhost:8172/api/status || exit 1

CMD ["node", "dist/main.js"]
