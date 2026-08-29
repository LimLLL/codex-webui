# Codex WebUI

[![GHCR](https://img.shields.io/badge/GHCR-codex--webui-blue?logo=github)](https://github.com/LimLLL/codex-webui/pkgs/container/codex-webui)
[![Docker](https://img.shields.io/badge/docker-multi--arch-brightgreen?logo=docker)](./Dockerfile)

给 [OpenAI Codex CLI](https://github.com/openai/codex) 做的 Web 前端。把命令行交互搬到浏览器里，支持多线程并发、文件管理、终端、插件市场等。

后端用 NestJS 通过 stdio JSON-RPC 和 `codex app-server` 通信，前端 React + Vite，中间用 Socket.IO 实时推送。

[English](./README.en.md)

![主界面](./images/main.png)

## 功能

**对话与线程**
- 多线程并发运行，互不干扰
- 线程按工作区分组，支持归档、fork、重命名
- Markdown 渲染 + Shiki 代码高亮
- `@` 引用文件、粘贴图片
- 追问（steer）和中断（stop）正在执行的 turn

**消息级分支**
- 编辑任意一条历史消息即产生新版本，像 ChatGPT 一样在版本间左右切换
- 分支图可视化整棵对话树，标注分叉点、运行状态与待审批
- 级联删除：删除一个分支会连带其全部下游，删除前用图和列表列清将要销毁的确切集合
- 启动时扫描 rollout 记录，认领在 WebUI 之外（如 CLI）创建的分支拓扑

**审批流程**
- 命令执行、文件变更的审批卡片，直接在页面上操作
- 支持安全策略切换（sandbox 级别）
- 多设备同时在线时的 CAS 防冲突

**文件管理与预览**

![文件管理](./images/sidebar-file.png)

- 树形文件浏览器，支持拖拽移动
- Monaco Editor 代码编辑 + Git diff 分栏对比
- 文件预览：PDF、图片、视频、音频、字体、二进制（hex dump）
- 压缩包浏览：ZIP / TAR(.gz/.bz2/.xz) / RAR / 7z，无需解压即可预览内容
- Office 文档编辑：DOCX / XLSX / PPTX（通过 OnlyOffice Document Server，可选集成）
- 上传 / 下载 / 重命名 / 复制 / 移动 / 新建目录

**终端**

![终端](./images/sidebar-terminal.png)

- 多 tab 共享终端（node-pty + xterm.js）
- 断线重连，输出不丢失
- headless VT 回放

**集成与插件**

![集成](./images/sidebar-intergration.png)

**其他**
- JWT + API Key 认证
- 插件/MCP 服务器管理
- 深色/浅色主题，中英文切换
- 响应式布局，手机平板也能用
- Docker 一键部署

## 技术栈

```
浏览器
  React 19 · Vite 8 · TanStack (Router + Query + Virtual)
  Zustand · Socket.IO Client · Monaco Editor · xterm.js
  Tailwind CSS 4 · shadcn/ui · Framer Motion · dnd-kit
  React Flow (@xyflow/react) + d3-hierarchy（分支图）
     ↕  REST + WebSocket
后端
  NestJS 11 · Fastify 5 · Socket.IO · node-pty
  SQLite (better-sqlite3 + Drizzle ORM) · Pino
     ↕  stdio JSON-RPC
  codex app-server（子进程）

测试
  Vitest（前后端统一）· SWC（后端装饰器元数据）
  jsdom + Testing Library（前端组件）
```

## 快速开始

### 前置条件

- Node.js >= 20
- pnpm >= 9
- [Codex CLI](https://github.com/openai/codex) 已安装并可用

### Docker 部署（推荐）

直接从 GHCR 拉取镜像，无需本地构建：

```bash
# 创建 .env
cat <<EOF > .env
WEBUI_API_KEY=your-secret-key
OPENAI_API_KEY=sk-xxx
EOF

# 启动（自动拉取多架构镜像）
docker compose up -d
```

或者手动运行：

```bash
docker run -d --name codex-webui \
  -p 8172:8172 \
  -e WEBUI_API_KEY=your-secret-key \
  -e OPENAI_API_KEY=sk-xxx \
  -v codex_root:/root \
  -v codex_workspaces:/workspaces \
  ghcr.io/limlll/codex-webui:latest
```

服务运行在 `http://localhost:8172`。

> `/root` 卷持久化 codex/claude/MCP 配置及运行时工具链。首次启动自动释放内置 seed。

### 本地开发

```bash
git clone https://github.com/LimLLL/codex-webui.git
cd codex-webui
pnpm install

cp .env.example .env
# 编辑 .env，至少设置 WEBUI_API_KEY

# 启动后端（默认端口 8172）
pnpm start:dev

# 另一个终端，启动前端（端口 5173，自动代理到后端）
cd web && pnpm dev
```

打开 `http://localhost:5173` 即可使用。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `WEBUI_API_KEY` | 是 | — | 登录密钥，同时用于派生 JWT 签名 |
| `PORT` | 否 | `8172` | 后端监听端口 |
| `OPENAI_API_KEY` | 否 | — | Codex 使用 OpenAI API 时的密钥 |
| `CODEX_BIN` | 否 | `codex` | codex CLI 可执行文件路径 |
| `CODEX_HOME` | 否 | `~/.codex` | Codex 主目录 |
| `LOG_LEVEL` | 否 | `info` | Pino 日志级别 |
| `WEBUI_DB_PATH` | 否 | `CODEX_HOME/codex-webui.sqlite` | SQLite 数据库路径 |

### Runtime Settings

`security.workspaceRoots`、`files.uploadMaxBytes`、`terminal.defaultCwd`、`terminal.maxSessions`、`terminal.graceMs`、`terminal.scrollback` 已迁入 SQLite runtime settings，可在 Settings 页面或 `/api/settings` 修改；同名历史环境变量仍作为 DB 未设置时的 fallback 生效。
Docker Compose 保留 `WORKSPACE_ROOTS=/workspaces`，用于首次启动时为挂载的 `/workspaces` 提供 bootstrap fallback。

## 项目结构

```
├── src/                  # NestJS 后端
│   ├── codex/            # 进程管理、JSON-RPC 客户端
│   ├── threads/          # 线程 CRUD、WebSocket 网关
│   ├── files/            # 文件操作、路径安全校验
│   ├── terminal/         # 多 tab 终端（node-pty）
│   ├── auth/             # JWT + API Key 认证
│   ├── database/         # SQLite + Drizzle ORM
│   └── ...               # 其他模块
├── web/                  # React 前端
│   └── src/
│       ├── routes/       # TanStack Router 页面
│       ├── components/   # UI 组件
│       ├── stores/       # Zustand 状态管理
│       ├── hooks/        # 自定义 hooks
│       └── generated/    # Hey API SDK（自动生成）
├── Dockerfile            # 多阶段构建 + seed root
└── docker-compose.yml
```

## 常用命令

```bash
pnpm start:dev          # 后端开发模式
pnpm build              # 编译后端
pnpm test               # 后端测试（Vitest）
pnpm test:cov           # 后端测试 + 覆盖率
pnpm lint               # ESLint 检查（含前端）
pnpm db:generate        # 生成数据库迁移
pnpm db:migrate         # 执行迁移
cd web && pnpm dev      # 前端开发模式
cd web && pnpm build    # 前端构建（输出到 public/）
cd web && pnpm test     # 前端测试（Vitest + jsdom）
```

## HTTPS / 反向代理

Codex WebUI 自身只监听 HTTP（默认 `0.0.0.0:8172`），生产环境建议用反向代理终止 HTTPS。

> **注意**：`WEBUI_API_KEY` 在纯 HTTP 下明文传输，公网部署务必启用 HTTPS。

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name codex.example.com;

    ssl_certificate     /etc/ssl/certs/codex.pem;
    ssl_certificate_key /etc/ssl/private/codex.key;

    client_max_body_size 200m;  # 匹配文件上传限制

    location / {
        proxy_pass http://127.0.0.1:8172;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }

    # Socket.IO WebSocket 升级
    location /socket.io/ {
        proxy_pass http://127.0.0.1:8172;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    server_name codex.example.com;
    return 301 https://$host$request_uri;
}
```

Docker Compose 中使用时，`proxy_pass` 改为 `http://codex-webui:8172`，并将 `ports` 改为 `expose`。

### 部署到子目录

同一个镜像可以同时用于域名根目录和代理子目录（例如 `https://cc.example.com/codex/`），无需为每个路径重新构建。子目录代理需要通过 `X-Forwarded-Prefix` 告诉 WebUI 浏览器侧的公开路径：

```bash
docker build \
  --build-arg CODEX_CLI_VERSION=0.151.0 \
  -t codex-webui:0.151.0 .
```

Nginx 必须保留浏览器侧的 `/codex/` 前缀，并在转发到后端时将它移除。`location` 和 `proxy_pass` 末尾的 `/` 均不可省略：

```nginx
location = /codex {
    return 301 /codex/;
}

location /codex/ {
    proxy_pass http://127.0.0.1:8172/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Prefix /codex;
    proxy_read_timeout 300s;
}
```

根目录反代无需设置 `X-Forwarded-Prefix`。WebUI 会按每个请求动态生成正确的静态资源、前端路由、REST API 和 Socket.IO 基础路径，因此同一镜像可同时服务两种代理方式。若使用 OnlyOffice，请将 `general.publicBaseUrl` 设置为包含子目录的完整地址，例如 `https://cc.example.com/codex`。

### Caddy

Caddy 自动签发 Let's Encrypt 证书，自动处理 WebSocket 升级：

```caddyfile
codex.example.com {
    reverse_proxy 127.0.0.1:8172
}
```

### OnlyOffice 注意事项

反向代理下 OnlyOffice 需要知道公开 URL 才能回调保存。代理正确传递 `X-Forwarded-Proto` / `X-Forwarded-Host` 即可自动检测；也可在 Settings → General 显式设置 `general.publicBaseUrl`。

## License

[AGPL-3.0](./LICENSE)
