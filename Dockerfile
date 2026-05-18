# ── Stage 1: Frontend build ──────────────────────────────────────────
FROM node:22-bookworm-slim AS frontend-builder
RUN npm install -g pnpm@10.18.3
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml* web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# ── Stage 2: Backend build ───────────────────────────────────────────
FROM node:22-bookworm-slim AS backend-builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.18.3
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY src/ ./src/
COPY tsconfig*.json nest-cli.json ./
# Generate codex schema types (needs codex CLI)
ARG CODEX_CLI_VERSION=0.123.0
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION}
COPY --from=frontend-builder /app/public ./public/
RUN pnpm build

# ── Stage 3: Runtime ─────────────────────────────────────────────────
FROM debian:trixie-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/root
ENV MISE_YES=1
ENV NODE_ENV=production
ENV PATH="/root/.local/bin:/root/.local/share/mise/shims:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    bash \
    tar \
    gzip \
    ripgrep \
    fd-find \
    jq \
    less \
    file \
    openssh-client \
    procps \
    bubblewrap \
    build-essential \
    pkg-config \
    python3 \
    make \
    g++ \
    libssl-dev \
    zlib1g-dev \
    libbz2-dev \
    libreadline-dev \
    libsqlite3-dev \
    libffi-dev \
    liblzma-dev \
    tk-dev \
    uuid-dev \
    xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Install mise + runtimes
RUN curl -fsSL https://mise.run | sh

RUN grep -q 'mise activate bash' /root/.bashrc 2>/dev/null || \
    printf '\n# mise\nexport PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"\neval "$(mise activate bash)"\n' >> /root/.bashrc

RUN mise use -g node@22 uv@latest python@3.14

RUN node --version \
 && npm --version \
 && uv --version \
 && python --version \
 && mise --version

# Install global npm tools (codex + MCP utilities)
ARG CODEX_CLI_VERSION=0.123.0
RUN npm install -g \
    @openai/codex@${CODEX_CLI_VERSION} \
    mcp-safe-proxy \
    mcp-remote

# Enable corepack for pnpm (needed for native addon rebuild)
RUN npm install -g pnpm@10.18.3

# Create app directories
RUN mkdir -p /root/.codex /workspaces /app/logs

# ── App installation ─────────────────────────────────────────────────
WORKDIR /app

# Install production dependencies and rebuild native addons
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod
RUN npx --yes node-gyp rebuild --directory=node_modules/node-pty || true \
  && npx --yes node-gyp rebuild --directory=node_modules/better-sqlite3 || true

# Copy built assets and migrations
COPY --from=backend-builder /app/dist ./dist/
COPY --from=backend-builder /app/public ./public/
COPY drizzle/ ./drizzle/

# ── Seed root tarball ────────────────────────────────────────────────
# Captures mise, node, codex, mcp-tools, bashrc, configs
RUN tar -C /root -czf /opt/root-seed.tar.gz .

# ── Entrypoint ───────────────────────────────────────────────────────
RUN cat > /usr/local/bin/entrypoint.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT_SEED="/opt/root-seed.tar.gz"
ROOT_MARKER="/root/.codex-webui-initialized"

is_root_empty() {
  find /root -mindepth 1 -maxdepth 1 -print -quit | grep -q . && return 1
  return 0
}

if is_root_empty; then
  echo "[entrypoint] /root is empty, restoring seed data..."
  tar -C /root -xzf "${ROOT_SEED}"
  touch "${ROOT_MARKER}"
elif [ ! -e "${ROOT_MARKER}" ] && [ ! -d /root/.local/share/mise ]; then
  echo "[entrypoint] /root has data but mise seed is missing; leaving unchanged."
  echo "[entrypoint] Clear the host volume and restart if this is unintended."
else
  echo "[entrypoint] /root already initialized."
fi

# Ensure directories exist (in case volume is pre-populated but partial)
mkdir -p /root/.codex /workspaces /app/logs

exec "$@"
EOF

RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8172

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf -H "Authorization: Bearer ${WEBUI_API_KEY}" http://localhost:8172/api/status || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/dist/main.js"]
