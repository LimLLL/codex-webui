# Docker 部署文档

## 镜像架构

多阶段 Dockerfile（6 stage）：

| Stage | 基础镜像 | 产物 |
|-------|---------|------|
| frontend-builder | `node:22-bookworm-slim` | `pnpm build` → `../public/` |
| backend-builder | `node:22-bookworm-slim` | `pnpm build` → `dist/` |
| runtime-base | `debian:trixie-slim` | 系统依赖层，被后三个 stage 共享 |
| toolchain-builder | runtime-base | mise + Node/Python/uv + codex + MCP 工具 → 打包为 `/opt/root-seed.tar.gz` |
| app-deps-builder | toolchain-builder | `pnpm install --prod` + 原生插件 rebuild |
| runtime | runtime-base | 最终镜像 |

Runtime 使用 `debian:trixie-slim`（非 Node 基础镜像），通过 mise 安装 Node.js 22 + Python 3 + uv，确保 codex 沙箱依赖完整。

**为什么 toolchain 要单独一个 stage**：`/root` 下的工具链既要打包成 seed（供首次启动恢复到挂载卷），又不需要出现在最终镜像的文件系统里。若在最终镜像内 `tar` 自己的 `/root`，同一份内容会在镜像层里存两遍。改为在 `toolchain-builder` 里打包、最终镜像只 `COPY` 那个 tar 包，即可省掉一份副本。

`app-deps-builder` 继承自 `toolchain-builder` 而非 `runtime-base`，因为 rebuild 原生插件需要 mise 提供的 Node.js 与编译工具链。

## docker-compose.yml

```yaml
services:
  codex-webui:
    image: ghcr.io/limlll/codex-webui:latest
    ports:
      - "${PORT:-8172}:8172"
    environment:
      NODE_ENV: production
      PORT: 8172
      WEBUI_API_KEY: ${WEBUI_API_KEY}
      WORKSPACE_ROOTS: /workspaces
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
    volumes:
      - root_home:/root
      - workspaces:/workspaces
    cap_add:
      - SYS_ADMIN
    security_opt:
      - apparmor:unconfined
      - seccomp:unconfined
    restart: unless-stopped
```

`WORKSPACE_ROOTS=/workspaces` 保留在 docker-compose 中作为 Docker 首次启动 bootstrap fallback：数据库中的 `security.workspaceRoots` 为空时，挂载的 `/workspaces` 仍可作为允许工作区。启动后可在 Settings 中改写 SQLite runtime setting。

### 容器权限

Codex 使用 bubblewrap (bwrap) 创建沙箱，需要 Linux user namespace 和 mount 能力：

| 配置项 | 作用 |
|--------|------|
| `cap_add: SYS_ADMIN` | 允许 namespace/mount 系统调用 |
| `security_opt: apparmor:unconfined` | 禁用 AppArmor 限制 |
| `security_opt: seccomp:unconfined` | 禁用 seccomp 系统调用过滤 |

如果缩小权限仍不工作，可退回 `privileged: true`。

## Volumes

| Volume | 挂载点 | 内容 |
|--------|--------|------|
| `root_home` | `/root` | mise runtimes、codex home (~/.codex)、npm global packages |
| `workspaces` | `/workspaces` | 用户工作区目录 |

### Root Seed 机制

`/root` 是挂载卷，镜像里的工具链无法直接出现在卷中，因此以 tar 包形式随镜像分发：`toolchain-builder` 阶段打包 mise/node/codex/mcp-tools（并剔除 `.cache`、`.npm` 这类安装副产物），最终镜像只携带 `/opt/root-seed.tar.gz`。

首次启动时 `/root` 为空，entrypoint 解包恢复。标记文件 `/root/.codex-webui-initialized` 防止重复恢复；卷里已有数据但缺 mise 目录时，entrypoint 不动它并提示手动清空，避免覆盖用户数据。

镜像内嵌的 `CODEX_CLI_VERSION` 与 `/root/.codex-webui-version` 不一致时，entrypoint 会就地升级 codex——这使得**复用旧卷升级镜像**是支持的路径，而不必清空 `/root`。

## Codex arg0 工具链 Workaround

### 问题

Codex 在启动时创建 `$CODEX_HOME/tmp/arg0/codex-arg0XXXXXX/` 目录，包含 multi-call binary 符号链接（`apply_patch`、`applypatch`、`codex-execve-wrapper`、`codex-linux-sandbox`），通过 argv[0] 决定行为。

在 macOS 上，codex 将此目录注入到子进程 PATH。但在 Linux app-server 模式下，此注入缺失，导致子进程找不到 `apply_patch` 等工具。

### Workaround

entrypoint 在 seed 恢复与版本升级**之后**重建符号链接到 `/usr/local/bin/`：

```bash
codex_bin="$(find /root/.local/share/mise -type f -name codex \
  \( -path '*/vendor/*/bin/codex' -o -path '*/vendor/*/codex/codex' \) | head -1)"
for tool in apply_patch applypatch codex-execve-wrapper codex-linux-sandbox; do
  ln -sf "${codex_bin}" "/usr/local/bin/${tool}"
done
```

所有工具都是 codex 的 multi-call binary（argv[0] dispatch），符号链接名决定行为。

**为什么在运行时而非构建时建链接**：`/root` 是挂载卷，构建期建立的链接目标在卷恢复后可能不存在；且 entrypoint 升级 codex 后 vendor 路径会变。放在 entrypoint 末尾可覆盖首次恢复与后续升级两种情况。两个 `-path` 模式并存是因为 codex 的 vendor 布局在版本间变动过。

**验证方式**：链接失败时 entrypoint 只打印一行 warning 并继续，容器能正常启动，症状要到 agent 改文件时才暴露。因此镜像更新后值得显式确认：

```bash
docker compose exec codex-webui ls -l /usr/local/bin/apply_patch
```

## 健康检查

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf -H "Authorization: Bearer ${WEBUI_API_KEY}" http://localhost:8172/api/status || exit 1
```

## 构建参数

| ARG | 默认值 | 说明 |
|-----|--------|------|
| `CODEX_CLI_VERSION` | `0.149.1` | **运行时**镜像内全局安装的 codex npm 包版本 |

构建阶段生成协议类型用的是 `@openai/codex` devDependency（由 `pnpm-lock.yaml` 锁定），**不受本 ARG 控制**。改 `CODEX_CLI_VERSION` 时须同步更新 `package.json` 里的 devDependency，否则会出现「类型按 A 版本生成、运行时跑 B 版本」的错配。版本的唯一真相源是 `package.json`，Dockerfile / docker-compose / CI fallback 均跟随它。

本地构建：
```bash
docker compose build --build-arg CODEX_CLI_VERSION=0.149.1
```

CI 由 `codex-*` 格式的 tag 触发，tag 名会被解析成本 ARG：`codex-0.149.1` → `0.149.1`。同一 codex 版本重发镜像用 `codex-0.149.1-2` 这类后缀。tag 名不合该格式会导致解析失败、构建报错。

## 反向代理与子目录部署

同一个镜像可同时服务域名根目录与代理子目录，无需按路径重新构建：前端构建产物使用相对路径，后端按每个 HTML 响应改写 `<base href>`。子目录代理需通过 `X-Forwarded-Prefix` 告知浏览器侧的公开路径。

具体的 nginx / Caddy 配置见 README「部署到子目录」。此处只记录与镜像相关的两点：

- 该请求头目前**无条件采纳**。输入经过校验（必须以 `/` 开头、拒绝 `"'<>?#\`、规范化多余斜杠），无法逃逸出 HTML 属性；且 HTTP 头无法经链接或表单注入，故不构成可利用漏洞。但「前缀可信」这一前提在**没有反向代理**的部署下并不成立，未来宜加信任开关并默认关闭
- 使用 OnlyOffice 时，`general.publicBaseUrl` 需设为含子目录的完整地址

## 已知限制

- 运行为 root 用户（codex 沙箱需要 root 权限创建 namespace）
- 原生插件（node-pty、better-sqlite3）在 `app-deps-builder` 阶段 rebuild，失败时以 `|| true` 放行、回落到预编译产物，因此构建成功不等于插件可用；跨架构镜像需实际启动验证终端与数据库
- `field-sizing: content` CSS 属性在某些嵌入式浏览器中行为不一致
