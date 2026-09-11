# 剩余实现任务

基于 `codexwebui-architecture.md` §15 最小落地顺序。

## 已完成

- [x] Step 1: 项目结构（NestJS + web/ React Vite）
- [x] Step 2: NestJS 基础设施（ConfigModule, ServeStatic, Swagger, ApiKeyGuard）
- [x] Step 3: Codex stdio JSON-RPC client（进程管理, 握手, 重连）
- [x] Step 4: REST API（model/list, thread/start, turn/start, turn/interrupt）
- [x] Step 5: WebSocket Gateway + Socket.IO 事件推送
- [x] Step 6: Item lifecycle（reasoning/agentMessage/mcpToolCall/commandExecution 流式渲染）
- [x] Step 7: Thread 列表/切换/resume（侧边栏, 历史恢复）
- [x] Step 8: FilesService 文件管理（后端 CRUD + delete + workspace root 安全 + chokidar 按需 watch + 前端文件树 breadcrumb + Monaco Editor + Diff 视图 + fileChange item + commandExecution 修复）
- [x] Step 9: Web Terminal（node-pty + xterm.js + 全局/会话级终端 + UI 重构：sidebar 分区 + session 底部面板 + tab 切换）

## 待实现

### Step 10: Approval 审批流 ✅

**后端**

- [x] `codex.serverRequest` 事件转发 (ThreadsGateway)
- [x] `codex.serverResponse` 客户端回传 (ThreadsGateway)
- [x] 由连接内 `ServerRequestOwner` 独占 server-request 答复 authority，持久化决定提交后才回写原 app-server stdin

**前端**

- [x] `types/approval.ts` — ApprovalRequest 类型
- [x] `stores/timeline-store.ts` — approvals 状态管理 (addApproval, resolveApproval)
- [x] `hooks/use-codex-socket.ts` — 监听 `codex.serverRequest` 解析审批事件
- [x] `components/chat/turn-items/approval-item.tsx` — 审批卡片 (Accept/Decline 按钮)
- [x] `components/chat/turn-block.tsx` — 审批卡片跟随对应 item 渲染

实现文档: `approval.md`

### Step 11: PostgreSQL + Drizzle ORM — 跳过

已决定跳过。Codex app-server 是 source of truth，个人单用户部署不需要 PG。
未来全文搜索可用 MeiliSearch 独立容器。

### Step 12: Docker Compose 部署 ✅

- [x] 多阶段 Dockerfile (frontend-builder → backend-builder → runtime)
- [x] docker-compose.yml (web service, 无 PG)
- [x] Volume 持久化 (workspaces, codex-home)
- [x] node-pty native 依赖处理 (python3/make/g++ + node-gyp rebuild)
- [x] Codex CLI 安装到镜像 (@openai/codex@latest)
- [x] 健康检查 (curl /api/status)
- [x] .dockerignore
- [x] .env.example

实现文档: `docker.md`

### Multi-Thread 并发运行 ✅

**后端**

- [x] `ThreadResumeRegistryService`：generation-scoped resume 去重，`ensureResumed` 语义
- [x] `thread/start`、`thread/fork` 自动 `markResumed`，auto-resume 集成
- [x] `CodexProcessManager.getGeneration()` 暴露 generation
- [x] `PendingApprovalsModule`：SQLite `pending_server_requests` 表持久化 approval
- [x] `PendingApprovalsService`：persist → emit、generation expire、multi-device CAS（`changes === 1`）
- [x] `PendingApprovalsController`：`GET /api/pending-approvals`、`POST /api/pending-approvals/:requestId/respond`
- [x] ServerRequestOwner 在 ingress 接管并交 PendingApprovalsService 持久化；ThreadsGateway 只分发成功 admission，两个响应入口均用 instance-bound CAS

**前端**

- [x] `timeline-store` 从单例重构为 `threadsById` + `selectedThreadId` + `subscribedThreadIds`
- [x] `ThreadRuntimeState` per-thread 状态隔离
- [x] `setActiveThread` 不再清除旧 thread 状态，只切换 `selectedThreadId`
- [x] `unsubscribeThread` action 用于 archive/readOnly 场景
- [x] `resubscribeAll` 在 socket reconnect 时恢复所有订阅
- [x] `notification-handlers.ts` 移除 `isForActiveThread`，改为 `hasThreadScope` + mutable `ctx.threadId` 路由
- [x] `use-codex-socket.ts` 多 room 订阅 + lifecycle 事件遍历所有 subscribed threads
- [x] 后台 approval snackbar + jump-to-thread（`codex-webui:jump-thread` custom event）
- [x] 刷新恢复：`authenticated-layout` mount 时 `threadsListThreads` 发现 active thread → subscribe + ensureResumed
- [x] `thread-view` resume 恢复 `threadStatus` + `activeTurnId` + `loading`
- [x] `useSelectedThreadState` + `useThreadState` selector hooks

实现文档: 无独立文档，实现细节见对应模块源码与 `websocket-events.md`

## 后续增强（不在 MVP 范围）

### 认证与安全 ✅

- [x] `ApiKeyGuard` 全局挂载，覆盖 `/api/**` 与 Socket.IO `/ws` 事件；静态资源之外默认拒绝未认证访问。（已在 Step 2 完成）
- [x] `POST /api/auth/login` / `POST /api/auth/logout`：校验 `WEBUI_API_KEY` 后签发短期 JWT（HMAC-SHA256 派生 secret），前端不再反复传输主密钥。
- [x] WebSocket handshake 携带 JWT/API key，并在连接阶段拒绝未认证 socket。统一 AuthService 消除 Guard/Gateway 重复逻辑。
- [x] Swagger 生产环境关闭：`NODE_ENV !== 'production'` 时才注册 SwaggerModule，移除 URL 白名单改用 `@Public()` 装饰器。
- [x] workspace root 白名单强化（已在 Step 8 完成）：动态 root 必须落在配置 root 内。
- [x] terminal `cwd` 做 `realpath` 与 workspace root 校验（已在 Step 9 完成），首次打开终端展示风险确认对话框（TerminalRiskGate）。
- [x] sandbox policy / approval policy 可切换：ChatInput SecurityPolicyBadge + Popover，支持 approval policy 和 sandbox mode 实时切换（`config/batchWrite` + `reloadUserConfig:true`），展示网络访问状态，危险选项红色高亮。
- [x] secret 脱敏策略：`/api/codex/status` config 字段白名单（sandboxMode/approvalPolicy/model/modelProvider），不返回 raw config/read。Pino redact 过滤 Authorization/token/apiKey/password。

### 结构化日志 ✅

- [x] Pino 结构化日志：nestjs-pino + pino-http + pino-roll 替换内置 Logger。
- [x] 文件轮转：size 10m, limit.count 5（~50MB），dev 模式同时输出 stdout。
- [x] Pino redact 脱敏：Authorization、cookie、token、apiKey、password。
- [x] `GET /api/logs`：分页结构化日志，level/source 过滤。
- [x] `GET /api/logs/export`：sanitized 诊断 bundle（日志 + 系统信息 + 运行状态）。系统信息含 `webuiVersion`（读自 package.json）与 `codexVersion`，供 issue 模板引用。
- [x] 前端 Diagnostics 面板：header Activity 图标入口（带 Tooltip），level/source 过滤，分页，复制/下载导出。
- [x] codex-jsonrpc.jsonl 保留为 local-only 调试日志，不通过 /api/logs 暴露。

### Thread 高级操作 ✅ (Batch 1 完成)

- [x] `POST /api/threads/:id/fork` → `thread/fork`。
- [x] `POST /api/threads/:id/archive` → `thread/archive`。
- [x] `POST /api/threads/:id/unarchive` → `thread/unarchive`。
- [x] `POST /api/threads/:id/compact` → `thread/compact/start`。
- [x] `GET /api/threads/branch-adoption/status`：启动期扫描 Codex rollout，认领可重建的外部 paginated fork，诊断 legacy/冲突拓扑。
- [x] `GET /api/threads/:id/delete-preview`、`POST /api/threads/:id/delete`：按 fork 拓扑预览/执行级联删除，自动中断 active turn，叶到根删除并逐项清理本地元数据。
- [x] 删除废弃 `POST /api/threads/:id/rollback` 后端路径；历史消息编辑改走消息级分支。
- [x] `POST /api/threads/:id/branches` → `thread/fork(beforeTurnId)` + 本地分支拓扑事务落库。
- [x] `GET /api/threads/branch-trees`、`GET /api/threads/:id/branch-tree`、`GET /api/threads/:id/branch-state`：提供版本树与 compact guard 状态（branch-state 读取持久化 local/adopted 拓扑，compact 写路径仍实时扫描 app-server）。
- [x] 前端消息级分支：user 条目携带 turnId、`< n/m >` 切换器、侧边栏折叠分支成员并上浮树级状态、深链高亮根行、compact 按钮按后代禁用。
- [x] 前端分支图与级联删除：`@xyflow/react` + `d3-hierarchy`（布局为纯函数、两个渲染面共用，均 lazy import 不入主包）、缩进列表为权威的删除确认框 + 静态子树预览、侧边栏与版本切换器两处删除入口（按根/非根区分语义）、头部与三点菜单两处分支图入口、删除入口按扫描器状态门控。
- [x] `PATCH /api/threads/:id/name` → `thread/name/set`（前后端双重空值校验）。
- [x] `GET /api/threads` 增强：`cwd` + `sortKey` 查询参数。
- [x] Sidebar 双视图重构：Workspace Overview（按 cwd 分组，可折叠，framer-motion 动画）+ Detail（cursor 分页）。
- [x] Thread Context Menu：Rename / Archive / Unarchive / Compact / Fork。
- [x] Archived thread 点击：thread/read 只读查看（app-server 有 bug 返回 500，已加 toast workaround）。
- [x] Skeleton loading：overview + detail 骨架屏。
- [x] ChatHeader：thread name 显示 + inline 编辑 + archived badge。
- [x] thread/name/updated notification 同步 header title。
- [x] `POST /api/threads/:threadId/turns/:turnId/steer` → `turn/steer`，支持进行中追问/追加输入。ChatInput Steer/Stop 按钮，activeTurnId 跟踪，approval 期间禁用 steer。
- [x] app-server 重启后的 active thread 自动 `thread/resume` 与 snapshot 恢复。后端执行义务 inventory + AutoResumeService lifecycle event + codex.lifecycle socket event；room 成员资格不再决定恢复目标。

### 事件处理与 Normalize ✅ (P0 完成)

> 决策：后端 normalizer 永久跳过，前端 dispatcher 模式处理所有通知。

- [x] 前端 notification dispatcher：`use-codex-socket.ts` → `notification-handlers.ts` method→handler 分发
- [x] unknown fallback：未知 notification 在 dev 模式 console.debug，不静默丢弃
- [x] `error` → willRetry 区分 warning/error toast，去重，系统条目
- [x] `thread/tokenUsage/updated` → per-turn footer + ChatInput 圆环展示
- [x] `serverRequest/resolved` → 按 requestId 校准审批状态，支持乱序到达
- [x] `configWarning`、`deprecationNotice` → warning toast
- [x] `turn/started`、`thread/started`、`thread/status/changed`、`thread/closed`、`thread/archived`、`thread/unarchived` → TanStack Query 失效 + 系统条目
- [x] `thread/compacted` → 上下文压缩系统事件
- [x] `model/rerouted` → 系统条目 + info toast
- [x] Tier 3 已知方法（hooks/MCP/realtime/account/skills 等）→ dev-only debug 日志
- [x] `turn/plan/updated`、`item/plan/delta` → PlanPanel 可折叠步骤面板 + 流式 delta text
- [x] `account/updated`、`account/login/completed`、`account/rateLimits/updated` → account-store + AccountSettings tab + AccountRateLimitBadge
- [x] `mcpServer/startupStatus/updated`、`item/mcpToolCall/progress` → mcp-store + McpStatusBadge + toolProgress
- [x] `skills/changed` → TanStack Query invalidation
- [x] `app/list/updated` → invalidate apps query
- [x] `mcpServer/oauthLogin/completed` → invalidate MCP status + success/error toast

### SQLite 轻量持久化 ✅

- [x] 引入 SQLite（drizzle-orm + better-sqlite3）持久化 token usage：`(threadId, turnId) → tokenUsage JSON`。切换 thread / 页面刷新后 hydrate 历史 turn 的 token footer。
- [x] DatabaseModule（非全局）+ DRIZZLE_DB provider + drizzle-kit 标准迁移（启动时自动执行）。
- [x] DB 路径：`WEBUI_DB_PATH` > `CODEX_HOME/codex-webui.sqlite` > `~/.codex/codex-webui.sqlite`。WAL + busy_timeout=5000。
- [x] TokenUsageService 后端拦截 `thread/tokenUsage/updated` 通知 → upsert。`GET /api/threads/:threadId/token-usage` 前端 hydrate。
- [x] TurnErrorsService 后端拦截 final `error` / failed `turn/completed` 通知 → upsert message/category/additional details/misalignment type+explanation；nullable 字段用保富合并，后到的稀疏 terminal event 不清空详情。`GET /api/threads/:threadId/turn-errors` 前端 hydrate 结构化失败卡，continuation steer 不入库/浏览器/日志。
- [x] ConversationBranchesService 持久化消息级分支 groups/versions/edges；token usage、turn diff、turn errors 读取时按 root→current provenance 继承，并由 edge 上的 `inheritedTurnIds` 限定边界（否则分支会读到父在分叉点之后产生的数据）。
- [ ] 可选扩展：持久化 thread 级累积 token usage 等实时数据，减少对通知丢失的依赖。

### Runtime Config in SQLite ✅ (MVP 完成)

- [x] 通用 `settings` 表（key-value + type + category + constraints），Drizzle migration + 启动 reconcile。
- [x] SettingsService：读写、类型校验、默认值、内存缓存、变更通知、DB > env > default 优先级链。
- [x] 终端配置（scrollback、max terminals、grace period）迁入数据库；运行时变更影响新终端。
- [x] Settings 页面 General/Terminal/Files/Security 配置 tab：metadata 驱动动态表单、Save/Reset、source badge。
- [x] DEFAULT_TERMINAL_CWD、WEBUI_UPLOAD_MAX_BYTES、WORKSPACE_ROOTS 迁入数据库。
- [x] FilesService 运行时响应 WORKSPACE_ROOTS 变更（动态 roots 保留）。
- [x] .env 仅保留启动必需项（PORT、WEBUI_API_KEY、OPENAI_API_KEY、CODEX_BIN、CODEX_HOME、LOG_LEVEL、WEBUI_DB_PATH）。

### Redis 缓存基础设施

- [ ] 引入 Redis（ioredis 或 @nestjs/cache-manager + cache-manager-redis-yet）作为统一缓存层。docker-compose 加 redis 服务。
- [ ] 迁移 codex status TTL 缓存从内存到 Redis。
- [ ] 后续可用于：MeiliSearch 搜索结果缓存、WebSocket session、rate limiting、pub/sub 等。

### REST API 与 SDK

- [x] `GET /api/codex/status`：聚合 app-server readiness、account/read、config/read、provider env、model/list 结果。全局 banner 展示 degraded/unavailable 状态。
- [x] `GET /api/openapi.json` 或确认当前 `/api/docs-json` 路径，并纳入认证与 SDK 生成流程。
- [x] Hey API `@hey-api/openapi-ts` 生成类型安全 REST client，替换 `web/src/api.ts` 手写 fetch。
- [x] TanStack Query 接管 threads/models/files/codex status 等服务端状态缓存、错误与重试。
- ~~Workspaces API~~ — 跳过。Workspace 仅作为"工作目录"概念，现有 `WORKSPACE_ROOTS` + sidebar cwd 分组 + DirectoryPickerDialog 已满足需求，无需独立 CRUD 实体。
- ~~Workspace-scoped Files API~~ — 随 Workspaces API 一同跳过。
- [x] `GET /api/mcp-servers`、`GET /api/account`。
- [x] `GET /api/skills`（skills/list 原样透传）。
- [x] `GET /api/apps`（app/list 透传，cursor 分页）。

### 文件管理增强 ✅ (基础操作 + 文件预览完成)

- [x] createDirectory / remove / rename / copy / move 基础文件操作（8 个 REST 端点）。
- [x] 文件上传（@fastify/multipart, preservePath, 文件夹层级保留）、下载（stream）。
- [x] FileTree 重构：Windows Explorer 风格扁平浏览、@dnd-kit/react 拖拽移动、右键上下文菜单、目录树选择器。
- [x] `GET /api/files/serve` 内联文件服务：正确 Content-Type（30+ MIME）+ `Content-Disposition: inline` + `Cache-Control`。`access_token` query param 认证（RFC 6750 §2.3）。
- [x] 前端 viewers 文件夹（`components/files/viewers/`）：FileContentViewer dispatcher + CodeViewer (Monaco) + ImageViewer（缩放/旋转/棋盘格背景）。`FileViewer` 重构为 thin wrapper。`lib/file-category.ts` 文件类型分类。
- [x] 综合文件预览原型：PDF、视频、音频、字体、压缩包、DOCX、XLSX、OnlyOffice、二进制 fallback；压缩包 entry 只读预览，不复用可编辑 CodeViewer。
- [x] @mention 点击打开文件：`UserMessageBubble` badge 可点击 → `codex-webui:open-file` 事件 → `ThreadView` 打开 session panel + 文件 tab。图片附件同理（badge 形式，不再缩略图）。
- [x] Session panel tab 对齐修复：终端 tab 和文件 tab 自然流式排列。
- [ ] 大文件分页/只读预览。
- [ ] 自动编码检测、只读模式、保存前备份与更清晰的 mtime 冲突恢复。
- [ ] 文件 watcher 与 app-server fs watch 的事件去重/合并策略。
- [ ] multipart upload e2e 测试（Fastify 插件在测试上下文注册有问题，已延后）。注：项目当前**没有任何 e2e 设施** —— 原先那个脚手架残留的 `test/app.e2e-spec.ts` 已随 Vitest 迁移一并删除（它 `beforeEach` 全量启动 AppModule，会 spawn 真实 app-server 并扫描真实 CODEX_HOME，单轮 15s+ 且结果取决于开发机上的历史会话量）。重建时的正确形态是：SQLite 这类自管依赖用真的（临时目录），app-server 这类外部进程用 `overrideProvider` 替身，`beforeAll` 复用一个 app 实例。

### Terminal 增强 ✅

- [x] 多 terminal tab/session 管理：context-based（`global` / `thread:<threadId>`），显示 cwd/shell/exitCode/attachedCount，tab create/close/rename/download。
- [x] `DEFAULT_TERMINAL_CWD` 环境变量 + cwd 回退链（fail-fast if invalid）。
- [x] 终端 buffer 限制：前后端 xterm scrollback 统一配置（`WEBUI_TERMINAL_SCROLLBACK`，默认 5000）。
- [x] Socket owner 校验：所有操作验证 terminal 存在 + context 匹配 + socket 已 attach，失败返回结构化错误。
- [x] 断线重连恢复：`@xterm/headless` + `SerializeAddon` 服务端 VT 镜像，detach + grace period（`WEBUI_TERMINAL_GRACE_MS`，默认 45s），reconnect 返回完整序列化 VT 状态。
- [x] 终端输出下载：后端从 headless buffer 导出 plain text，前端 blob 下载。
- [x] 终端共享：同 context 多浏览器 tab 共享终端，输出广播，多 attach close 二次确认。
- [x] Max terminal cap：全局上限 `WEBUI_TERMINAL_MAX_SESSIONS`（默认 10）。
- ~~Docker/实机部署下的终端隔离等级提示~~ — 用户自行负责，不做。

### Multi-Thread 后续增强

- [x] 后端 API 错误消息 i18n：`BusinessException` + `ErrorCode` 层级错误码 + 全局 `AllExceptionsFilter` 标准化 `{ statusCode, errorCode, message, params? }` 响应。前端 `getApiErrorMessage()` 统一翻译。~150 个 throw 站点迁移，~120 条 zh-CN 翻译。
- [x] `subscribedThreadIds` 长期增长清理策略：`general.maxIdleSubscriptions` + `lastActivityAt` LRU，超过上限时清理 safe idle thread，并同步 `thread.unsubscribe` + 删除 runtime。
- [x] `threadsListThreads({ limit: 50 })` 发现 active thread 可能不够：后端 `GET /api/threads/loaded` 调用 `thread/loaded/list`，前端 refresh recovery 用 limit:200 分页恢复。
- [x] Sidebar per-thread loading/approval badge 视觉增强：状态优先级 approval(黄色脉冲) > userInput(蓝色脉冲) > generating(旋转) > idle；审批数量 badge（>1 时显示，9+ 封顶）。
- [x] `item/tool/requestUserInput` ServerRequest 处理：类型定义、防御性解析器、store 集成、UserInputCard 组件（radio/checkbox/text/password + submit）。

### Bug Fixes

- [x] Issue #6 ThreadItem 可见性与 misalignment：OpenAPI/SDK 补齐 19 个 item union 与错误详情；live/history 共用纯 normalizer，九个此前丢失的 variants 均有专用 renderer，未来 variant 降级为只含类型/lifecycle 的可见 fallback；misalignment explanation 本地持久化并在刷新后恢复，无 continuation UI。
- [x] Codex 0.151.0 空 paginated thread 拒绝语义修正：仍在使用的 `thread/items/list` / `thread/turns/list` 按 method + code + pinned wording 分别分类；单 turn UI items 返回 `[]` 并 warning，严格 provenance item read 保留原始失败，不再用 full-detail turn pages 做 fallback。
- [x] 0.151.0 fork metadata-only + provenance 原子切片：普通 fork 与消息分支均传 `excludeTurns:true`，用 `itemsView:notLoaded` 完整发现/校验 child turn IDs，provenance edge 提交前才允许补偿删除、提交后绝不删 child。普通 fork 现在写 topology-only local edge，修复 token usage 靠 server replay 重复落 child 行、turn diff / turn error 从来不继承的既有缺陷。
- [x] `writeStdin` 审批身份与归属：共享 parser 保留 protocol `kind` / `approvalId`，approval store 改按 JSON-RPC requestId 索引，同 item 多回调不覆盖；按 callback turn 渲染 Terminal Input Approval，不修改更早 command 的 lifecycle。
- [x] Issue #7 退役 deprecated full-history read：三个旧消费者全部改为 metadata-only + bounded turn/item paging；REST 删除 `includeTurns` 参数并重生成 SDK，只读降级显示最近页并沿用 load-earlier；消息分支完整校验 source/child 顺序前缀；删除用最新一页定位 in-flight turn，miss 后 metadata 复核。专用 read refusal predicate 与测试已删除，REST steer 投影作为安全边界保留。
- [x] JSON-RPC 错误结构化：`CodexRpcError` 保留 code/data/method/requestId，线程错误 predicate 不再依赖扁平化 Error message。
- [x] `readAsResume` 契约不完整：返回的 `ThreadResumeResponse` 缺少 `model`、`approvalPolicy` 等解析后设置。添加 `responseCache` 缓存首次 resume/start 的完整响应，`readAsResume` 合并缓存设置 + 新鲜 thread 数据。
- [x] Thread 列表为空：`thread/list` 未传 `modelProviders`，app-server 默认只返回当前配置 provider 的线程。修复：传 `modelProviders: []`（空数组=所有 provider）。
- [x] 生产构建玻璃态失效：CSS minifier 将 `backdrop-filter` 剥离为仅 `-webkit-backdrop-filter`。修复：Vite `cssTarget: ['chrome100', 'safari16', 'firefox100']`。
- [x] 用户消息气泡溢出：长文本/代码超出蓝色气泡边界。修复：容器加 `overflow-hidden`，UserMessageBubble 改用 react-markdown 渲染（自带 word-break）。
- [x] Textarea 文本遮挡按钮：overlay 布局下长文本滚动时覆盖底部按钮。修复：重构为 stacked 布局（外层容器 border + textarea + buttons 垂直堆叠）。
- [x] 认领扫描器启动读取全部 rollout：对 1120 个文件全量 `readFile` + 逐行 JSON.parse（实测 1.6 GB / 4692 ms / 352 MB RSS），而删除功能被扫描器状态门控。改为两趟——全部文件只读到首个换行取头部，仅 fork 链上的文件全量解析（15 个 / 322 ms / 126 MB）。
- [x] `isThreadNotFoundError` 正则过宽：`/(thread|rollout|session).*(not found|missing)/` 几乎匹配任何提到 thread 的 -32600，误判会让仍存在的会话被当作已消失、清掉本地元数据继续上删。实测真实文案后收窄为 `no rollout found for thread id`；`thread/read` 的 `thread not loaded` 刻意不接受（它也描述"存在但未 resume"）。
- [x] `ThreadsModule` 缺 `DatabaseModule` 导致后端启动即崩：单测全 mock 依赖故无法发现。补 import，并新增 `src/app.module.spec.ts` 编译整个 DI 图作为回归防线。
- [x] 待审批请求在记录时即标记 `cancelled`：删除若中止，会留下 UI 从未展示、DB 已终结无法应答、而 app-server 仍在等待的请求（对话卡死）。改为保持 `pending` 仅抑制广播，真正中断/删除后才终结。
- [x] `clearAdoptedRows` 在中间状态调用组清理，会把不足两版本的组连同**本地**版本行一起删除。组清理挪到重新插入之后。
- [x] 启动重复扫描：`onModuleInit` 与 `appServerReady` 监听器均会触发，加按 generation 的在途去重。
- [x] 空 fork 被认领为消息版本：从未发过消息的探测 fork 出现在 `< n/m >` 切换器里，谎称一次不存在的编辑。收紧为"边界替换用户消息 **且** 子分支确有替代消息"，否则只记拓扑。
- [x] 分支图暗色模式失效：React Flow 将暗色变量作用域限定在 `.react-flow.dark`，项目挂在 `<html>` 的 `.dark` 够不着，控件与角标在暗色下呈亮块。改为从 theme store 镜像 `colorMode`。
- [x] 分支图节点点击无效：`elementsSelectable`/`nodesDraggable` 全关且无点击处理器时，React Flow 给节点包装层设 `pointer-events: none`，挂在节点自身的 `onClick` 永不触发。改用其 `onNodeClick`。
- [x] 删除某个版本后跳回空状态：删除 mutation 无条件 `navigate({to:'/'})`，但删版本组里的一个版本时整个对话仍在。改为落到切换器里的上一个幸存版本，仅当组内无幸存者时才回空状态；侧边栏的整树删除仍回空状态。
- [x] 删除后侧边栏行闪烁：一次删除会同时产生 `thread/status/changed`、`thread/deleted` 与 mutation 的 settle 回调，三者各自失效 thread list（实测两轮 `thread/list` 间隔 190 ms 且响应乱序返回）；侧边栏会把分支活跃时间抬到根行上参与排序，于是同一行被重排两次。抽出 `web/src/lib/query-invalidation.ts` 共享 debounce 计时器，一次操作只刷一次。
- [x] `thread/deleted` 通知从未被处理：分发表里有 `thread/archived`/`thread/closed` 却漏了它，导致其他设备或 TUI 删除会话时本端列表不刷新，必须重载页面。补 handler：清本地 runtime + 订阅，并同时失效 thread list 与 branch trees。
- [x] 首个远程删除就失败时误报 `partial`：`destructiveStarted` 在进入删除循环后无条件置真，实际一个都没删也会告诉用户"部分已删除"。改为按真实进度（已删/已清理/已取消审批）推导。
- [x] `GET /api/threads/branch-trees` 只从版本组枚举树根：纯拓扑 fork（普通 fork、以及边界未知的认领 fork）有边无组，因而对前端不可见，侧边栏折叠判断与分支图入口会和删除的实际范围不一致。改为组根与边根取并集。
- [x] 已删除 thread 的前端 runtime 未清除：`unsubscribeThread` 只退出 socket room，`threadsById` 里的 runtime 仍在，深链或浏览器后退会短暂显示已删对话的内容。新增 `forgetThreads`（注意当前选中态存在顶层字段里，走 `selectThread(null)` 会把它写回 map）。
- [x] 删除期间被抑制的审批请求无法恢复：删除若中止，app-server 仍在等待，但 UI 永远看不到该请求。gateway 暂存被抑制的请求，删除守卫释放时按 DB 里仍为 `pending` 的条目重放。
- [x] 分支图节点标签被后写的版本组覆盖：一个 thread 会同时是「它被 fork 进的那个组」的 branch 行、和「在它内部编辑后面某条消息所产生的组」的 original 行，两行 preview 不同。前端按 threadId collapse 成一个 Map，后写的赢，于是分支被标成了在它内部做的某次编辑，它真正的标签则从图上消失。`BranchTreeMemberDto` 增加 `commonPrefixTurnId` 标明「创建该成员的那个组」，前端据此选行；根节点无此键，回退到其子节点分叉所属的组，再回退到 app-server 的 thread preview。同时给边加上「被编辑的那条消息」标注（仅当与父节点标签不同时显示）。
- [x] 版本切换器对组的 original 提供了删除按钮：删它会连带删掉组内其余全部版本（它们都是它的后代），确认框于是列出两个用户没提过的会话，极其反直觉。判据从「根/非根」改为「该版本在**当前这个组**里是不是 original」——同一个 thread 在外层组是可删的 branch、在内层组是不可删的 original，按 thread 判断必然出错。按钮保留但禁用并给出原因。不变量本身在 `conversation-branches.service.spec.ts` 里断言，不只依赖 UI 规则。
- [x] 已被删除的 thread 仍可能重放待审批：远程 `thread/delete` 成功后先 push 到 `deletedThreadIds`，取消待审批却排在本地清理的末尾。若 `reapDeletedThread` 抛错（拓扑不一致），审批行仍为 `pending`，删除守卫释放时 gateway 就会为一个已经不存在的会话弹出卡片。取消挪到远程删除成功后立即执行。
- [x] 删除守卫的释放监听器可能顶掉删除结果：`end()` 在 `finally` 中调用，监听器抛错会替换掉真实返回值 —— 一次成功的删除会被报成失败。逐个监听器包 try/catch 并记录。
- [x] 分支图边标注会落到纯拓扑 fork 上：边标注按「公共前缀」查组，而纯拓扑 fork 有前缀却不属于任何版本组，于是会被贴上恰好共享该前缀的另一个组的消息。改为先校验该子节点确实是那个组的成员。
- [x] 分支图把所有 adopted 边标成「分叉点未知」：认领恰恰是精确重建了分叉点的那一类，标签在说反话。拆成 `external`（非本客户端创建）与 `boundaryUnknown`（分叉点确实无记录）两个概念；浏览图里后者恒为 false，真正无边界的 fork 只会以 `source: 'server'` 出现在删除预览里。
- [x] `parsedFiles` 语义含混：值取的是「头部读取成功的文件数」，字段名却让人读成「完整解析的文件数」，掩盖了两趟扫描的关键差异。补 JSDoc 明确语义，另加 `fullyParsedFiles` 报告真正全量解析的数量。
- [x] `app.module.spec.ts` 会迁移真实数据库：编译真 `AppModule` 会构造真 `DatabaseService`，未设 `WEBUI_DB_PATH` 时直接打开开发者本机的 `~/.codex/codex-webui.sqlite`。改为在临时目录建库并在 `afterAll` 清理。

- [x] 触屏上的隐形控件：`opacity-0` 配 `group-hover:opacity-100` 的写法有 8 处，而 Tailwind v4 的 `hover:` / `group-hover:` 变体本身就编译在 `@media (hover: hover)` 内，触屏上那个 `opacity-0` 永远不会被抬起——控件不可见却仍可点中。改用 `@utility hover-reveal`（必须是 `@utility`：`index.css` 里未分层的 class 会压过整个 `@layer utilities`）。
- [x] 移动端全高界面用视口单位：`100dvh` 不随 iOS 软键盘收缩（Safari 不实现 `interactive-widget`），部分内嵌浏览器的底部工具栏也不反映在任何视口测量里，输入框被压在下面。改为统一从 `--app-vh`（镜像 `visualViewport.height`）取高度，覆盖 `#root`、登录页、三个 integrations sheet 与移动端会话抽屉。同步跳过 `scale !== 1`，否则双指放大会把整个应用塌进放大区域。
- [x] `flushSync was called from inside a lifecycle method` **已定位，判定为上游行为，不做本地规避**。调用点不在本项目代码里：`@tanstack/react-virtual` 的 `onChange(sync)` 内部直接 `flushSync(rerender)`，而 `virtualizer.measureElement` 是作为 **ref callback** 传给每个 item 的，React 在 commit（layout）阶段调用它——测量导致可见区间变化时，同步刷新就发生在生命周期内。当时怀疑的「`useLayoutEffect` 内触发 store 更新」不是原因：`use-transcript-follow` 在 layout effect 里调的是 `scrollToOffset`，它只写 `scrollTop`，滚动事件是异步派发的。已确认 `3.14.11` 就是当前最新版，无可升级的修复。**不设 `useFlushSync: false`**：React 在发出该告警的场景下本就已经放弃同步刷新，关掉它只会额外影响真正的滚动事件路径——那里的同步提交正是防撕裂需要的。结论是告警噪音，几何风险仅限于 React 已经降级的那些提交。

### UI 与交互增强

- [x] 可折叠工具调用：连续 2+ 个 MCP 工具调用合并为可展开/收起的分组；单个工具调用也可折叠参数/结果。完成后自动收起，`aria-expanded` 无障碍支持。
- [x] TanStack Router 集成：code-based route tree，auth guard（beforeLoad + redirect search param），thread URL 化（`/t/$threadId`），SPA deep-link fallback（`fallthrough: true`）。
- [x] `/login`、`/settings` 页面与路由导航。`/workspaces` 待 Workspaces API 完成后实现。
- [x] Settings: General tab（theme toggle + language dual-button + logout）。theme 持久化 localStorage，shared store。
- [x] Model picker + reasoning effort：ChatInput `ModelSelector` popover，session-level overrides（Zustand `model-store`），`turn/start` 传 `model`/`effort`。后端 runtime validation。
- [x] `/api/codex/status` models 字段瘦身：只返回 `{ ok, listable, count, defaultModel }`，ModelSelector 用独立 `GET /api/models`。
- [x] Markdown 渲染：`react-markdown` + `remark-gfm` + Shiki 懒加载语法高亮，agent/user 消息均支持。
- [x] react-i18next 国际化：自然语言 key，en + zh-CN，语言切换。
- [x] TanStack Virtual 虚拟列表：`useVirtualizer` + `measureElement` 动态高度，TurnBlock 去 motion 避免 recycling 重复动画。自动跟随后由库的末端锚定接管（见下方 issue #18）。
- [x] Rich Chat Input：@ 文件引用（内联文本 + 路径导航 popover）、粘贴图片/文件上传、Skill 选择器、FileTree 右键附加、消息气泡 @mention badge + AuthImage 图片预览。ChatInput 拆分为 3 文件。后端 ChatModule（upload 暂存）+ SkillsModule + StartTurnDto v2 union 校验。
- [ ] app @mention 的 composer 输入能力。
- [x] 分支图节点显示轮数：后端新增 `POST /api/threads/turn-counts`，通过实验性 `thread/turns/list` + `itemsView: notLoaded` 分页计数，不 resume；单节点失败返回 unknown，不阻塞图或删除预览。
- [ ] 主包体积：入口 chunk 约 4.1 MB（gzip 1.25 MB），Monaco / xterm / shiki / pdf.js / xlsx 均在其中。React Flow 已拆出独立 chunk（179 kB），其余仍待按路由拆分。
- [ ] 当前打开的会话被他处删除时无法自动离开：通知分发层拿不到 router，只加了系统条目告知用户，runtime 刻意保留以免无解释地清空正在阅读的内容（现已同时标记 `deletedRemotely`，输入与建分支禁用，不再是可写的僵尸会话）。可行方向是沿用既有的 `codex-webui:*` CustomEvent 模式，由 layout 监听并导航。
- [ ] 认领扫描器对**多跳外部 fork** 可能过度继承：`resolveInheritedTurns` 在父本身也是 fork 时无条件带上父的完整继承前缀，只按 `endByteOffset` 过滤父自身文件内的轮次，未用 `history_base.endOrdinalExclusive` 截断继承自更上游祖先的轮次。若外部 fork 的边界落在父的继承前缀之内，继承轮列表与公共前缀分组会算错，进而产生错误的版本组。保守修法是无法证明该映射时**跳过**该多跳情形的消息版本认领，只记拓扑。属上一轮既有问题。
- [x] 前端测试基建：Vitest + jsdom + Testing Library（`web/vitest.config.ts` 合并 `vite.config.ts` 复用 alias 与 React 插件）。已覆盖 store 层（只含用户消息的轮次不重复前插、真正更早的轮次仍前插）、通知层（`markThreadDeletedRemotely` 保留 transcript 但清 loading/activeTurn/cursor 并置 `deletedRemotely`）、`forgetThreads` 四态（后台线程驱逐 / 当前选中线程不被写回缓存 / 已订阅线程退房 / 空列表 no-op）、确认框（同帧双击只提交一次、in-flight 与 `canDelete=false` 不提交、失败后仍可重试）。所有断言均经变异检验确认非空跑 —— 双击那条正是这样证伪了上一轮那版无效修复（详见 frontend-ui.md）。
- [x] 删除 mutation 四态（`use-thread-deletion.spec.tsx`）：`completed` 导航到 `resolveSurvivor` 选中的版本、无幸存者时回空态、把服务端返回的树写进幸存成员的缓存而不写被删成员；`conflict` 一个都没删所以不挪动用户；`partial` 有树只失效 removed，无树则连同 planned/remaining 一起兜底刷新。
- [x] 「重开不替换已覆盖页」（`hydrateOpenedThread` 的 `pageIsSubsumed` 分支）：已覆盖页不被最新页顶掉且不吞掉已翻出的更早历史、cursor 不被换成会重复拉取的新值；反向用例确认页中出现未见过的轮次时服务端视图整体取胜。
- [ ] `GET /api/threads/overview` 的代价是 O(库内会话总数)：实测 154 会话单次全量枚举约 900ms（冷）/400ms（热），带 `cwd`/`searchTerm` 过滤时仍需两次完整枚举。这是「后端统一投影」换取排序正确性的固有成本，不打算退回客户端 join。若真实使用中可感知，下一步是后端加一层短生命周期投影缓存（由 thread/branch/approval 变更失效），而不是继续调前端防抖。
- [x] 打开线程只加载最近一页 turns，更早历史需要往前翻。这是 metadata-first 的固有取舍（换来打开 47ms / 2.8 KB）。已改为按滚动位置预取（见下「加载更早」条），前插的滚动锚定问题由 `anchorTo: 'end'` + 稳定 `getItemKey` 解决。
- [x] diff 面板增强：`@git-diff-view/react` + `@git-diff-view/shiki` GitHub 风格 diff 视图（split/unified 切换、语法高亮、error boundary fallback）。
- [x] 审批卡片增强：`acceptForSession`、`cancel`、granular permission（exec/network policy amendment）。按钮由服务端 `availableDecisions` 动态控制，legacy fallback 仅 accept/decline。proposed amendments 由服务端提供，不允许自由构造。`FileChangeItem` 同步支持。runtime parser 校验协议数据。
- [x] issue #18-1 首屏白条：`item/started` 会在首个 delta 之前插入 `content: ''` 的 agent 消息，外壳只看「有没有 item」于是围着空 renderer 画出头像 + 玻璃气泡。新增 `lib/turn-item-display.ts` 穷尽判据，外壳空判定与渲染列表共用；plan/diff 改按渲染器真实条件判断而非字段存在性；挂着审批/输入卡的 item 不被滤掉；此前不可达的 `Thinking...` 占位复活。
- [x] `turnFailure` 条目可重复插入（既有 store 缺陷，本轮由 `getItemKey` 暴露并修复）：辅助错误水合会为**尚未加载**的旧 turn 追加一条 `turnFailure`，因无处安放而停在时间线末尾；之后加载到该 turn 所在页时会再产生一条同 turnId 的失败条目，于是一条正确就位、一条游离在下方。后果不止是重复渲染——`getItemKey` 的组内序号被重排（原 `turnFailure:<id>:0` 变成 `:1`），前插时缓存行高与末端锚点会落到错误的行上。修法是前插时由 `absorbStrandedFailures` 收编：结构化错误记录（携带 misalignment 细节，分页 turn 自身的 `error` 字段没有）在合并中取胜，页面未报错的游离条目则**移动**到其 turn 之后而非丢弃。刻意**没有**把「仅有失败条目的 turn」计入 `collectKnownTurnIds`——那会让分页跳过该 turn 的对话内容。归属判断取自**本页拉到的 turn id 列表**而非它们产出的条目：items 全部归零、自身 `error` 又为空的 turn（正是结构化记录存在的场景）只会产出一条 `user` 条目甚至什么都不产出，从条目反推会让这条失败永远留在最新回合之下。
- [x] 「加载更早」改为接近顶部自动加载：原先做成手动按钮是因为前插会顶走正在读的内容，而末端锚定 + 稳定 `getItemKey` 正是消除这一点的机制，理由已不成立。判据（`lib/history-prefetch.ts`）除「接近顶部」外还要求**向上移动**——所有主动滚动写入都只会让 offset 变大或不变，缺了方向判断会让「打开落位 / 回到最新」在短会话上顺手翻出没人要的历史。控件保留，用于内容不足一屏时的入口与加载中状态。
- [x] issue #18-2/3 跟随与「回到最新」：**根因是版本落后，不是需要自研**。手写的 `shouldAutoScroll` 原理上就拦不住库自己的两处 `scrollTop` 写入（`scrollToIndex` 遗留的 scrollState 最长追目标 5 秒；旧版尺寸补偿判据为「行起点在折叠线之上」，而一整个回合就是一行）。升级 `@tanstack/react-virtual` 3.13.24 → 3.14.11（virtual-core 3.14.0 → 3.17.9）后改用 `anchorTo: 'end'`，删除全部手写滚动；补稳定 `getItemKey`（前插必需，且函数本身须保持引用稳定）；「回到最新」浮动按钮的显隐由实时 DOM 几何驱动；发送/steer 经 `onSubmitted` 显式恢复跟随而非从 timeline 增长推断。
  - `followOnAppend` 最终**没有**开：它的实现就是调 `scrollToEnd()` → `scrollToIndex()`，等于库自己在每次追加时重新种下那个追 5 秒的 indexed target。追加时的定位改为本项目用一次 `scrollToOffset` 补，仅在条目数增长且此前就在末端时触发。
  - `paddingStart` 改为常量：按实测高度动态设置会让内容跳两次（控件首次测量、游标耗尽移除控件），而 `paddingStart` 的变化不在库会做位置还原的那类变化里。
  - 视口/分栏改变滚动容器自身高度时不发滚动事件，需 `ResizeObserver` 单独接住，否则跟随者被静默甩出阈值而按钮不出现。
- [ ] issue #18-4 桌面端会话预览面板：左侧列表内联内容片段/摘要 + 关键词或时间定位 + 点击直达对应消息位置，仅桌面端。用户明确要求单独排期，本轮不做。注意定位到具体消息与当前分页历史（默认只加载最近一页）存在交互，需先想清楚落位策略。

### Codex 高级能力

- [x] `account/read`、`account/login/start`、ChatGPT device code flow、`account/rateLimits/read`、`account/logout`。Settings Account tab + Header rate limit badge。
- [x] `mcpServerStatus/list`、MCP server startup 状态、MCP tool call progress 可视化、`config/mcpServer/reload`。ChatInput + Header badge + Popover。
- [x] `skills/list`：GET /api/skills 透传 + SkillSelector popover + skill input item。
- [x] `skills/config/write`：POST /api/skills/config + SkillSelector manage mode（inline Switch toggle）。`skills/changed` invalidation 修复为 queryHasId 模式。
- [x] `app/list` / `app/read`：GET /api/apps + GET /api/apps/detail；Integrations 页面 Apps tab（分页列表 + enable/disable via config/batchWrite + installUrl 外链 + app defaults/app detail sheet）。App config allowlist 支持 app-default、per-app、per-tool leaf keys，`value:null` 清除 leaf override 回到继承。
- [x] plugin marketplace：`plugin/list`、`plugin/read`、`plugin/install`、`plugin/uninstall`、`plugin/reconcile`。PluginsModule 5 端点 + Integrations 页面 Plugins tab（搜索/Featured/Installed/Marketplace 分组 + Sheet detail drawer + Sync installed + scoped invalidation）。
- [x] `mcpServer/oauth/login`：POST /api/mcp-servers/oauth/login + MCPs tab OAuth 登录流程（sync blank tab + copy-link fallback）。BigInt timeoutSecs 安全序列化。
- [x] Integrations 页面：`/integrations` 路由（URL search tab state）+ sidebar Puzzle 图标导航 + 3 tab（Plugins/Apps/MCPs）。
- [ ] `app/list` connector @mention composer 输入能力。
- [x] App tool-level config（per-tool enabled + approval_mode）：app detail sheet 通过 `app/read?includeTools=true` 枚举 tool id；tool summaries 只作为 display/enumeration 数据，policy truth 仍来自 config/read + app-server write validation。
- [ ] App/Plugin ID 字符集放宽：当前 config allowlist 正则只接受 `[A-Za-z0-9_-]+`，若 app-server 返回含 `.`/`:`/`/` 等字符的 ID，config 写入会 400。schema 里 `AppInfo.id` 与 `AppToolSummary.name` 都是不受约束的 `string`，需用真实 `app/list` / `app/read` 样本确认真实字母表后放宽。放宽时后端 allowlist 正则与前端 `isEditableConfigSegment`（app detail sheet 用它决定是否显示"无法通过 curated 路径编辑"提示）必须同步修改，否则前端守卫与后端边界会不一致。注意 `apps._default.*` 的负向先行断言依赖 id 字符类，放宽后需重新确认 `_default` 仍不会被 per-app pattern 匹配。
- [ ] Plugins `cwds` 查询参数类型修正：后端 `@ApiQuery` 缺 `type: String`，SDK 生成为 `Array<unknown>`。前端暂不传 cwds，启用 repo marketplace 过滤时需修。
- [x] Slash-command 后端能力：collaboration mode preset/list + settings update cache、thread goal read/set/clear、inline `review/start`、`feedback/upload`、fork opt-in `deferGoalContinuation`。
- [x] Slash-command 前端入口：composer `/` palette、plan indicator、goal progress row、review/feedback dialogs、`contextCompaction`/`enteredReviewMode`/`exitedReviewMode` item 渲染、fork 带 goal 勾选框。
- [ ] `/shell`（`thread/shellCommand`）：原语为 unsandboxed 全权限且绕过线程沙箱策略，等同于 Web 端 RCE 入口。需服务端开关（默认关）+ 逐次确认 + 独立安全评审后才能做。
- [ ] `/side` 副任务：ephemeral fork + `thread/inject_items` 注入边界 prompt，需要完整的临时会话生命周期与 UI。
- [ ] turn queue（`thread/queue/add`，每线程上限 100 + `thread/queue/changed`）：原生支持排队跟进 turn，但需要独立的队列 UX（可见队列/编辑/删除/重排/失败恢复）。
- [ ] `/prompts:<name>` 自定义 prompt：官方文档称 `~/.codex/prompts/*.md` 会出现在 slash 列表，但 0.149.1 app-server README 无对应方法，ACP 的 `CustomPrompt` 属 v1 遗留，需实测确认。
- [x] `config/read`、`config/batchWrite`、profile/settings UI：CodexConfigController（GET/PATCH structured + GET/PUT raw），Settings Codex tab（14 curated fields + profile switch + security read-only + Monaco raw editor），共享 json-safe 工具。
- [ ] `thread/backgroundTerminals/clean` 等剩余 experimentalApi 能力按开关暴露。
- [ ] `modelProvider/authRecoveryStarted` / `authRecoveryCompleted`（0.152.1 新增）：**前置依赖 Bedrock 支持，已决定不做**。上游只有 `amazon_bedrock` 实现 `auth_recovery_messages`，且发射被 `uses_aws_auth_recovery()`（`ConfiguredAwsProfile` / `AwsSdk`）门控，因此仅在 model provider 为 Amazon Bedrock 且走 AWS 托管凭证（profile / 环境凭证链）时触发；Codex 托管的 Bedrock API key 与 AWS access keys 不触发，ChatGPT / OpenAI API key 更不触发。该分支是单次凭证刷新而非多步重试，`message` 为写死的英文常量，且失败无对应通知（`Completed` 仅表示成功）。两个方法目前落在前端 dispatcher 的 unknown 分支；在支持 Bedrock 之前，唯一有意义的独立改动是归入 TIER3 消除噪音。
- [ ] `project/list` 的 `sortKey` / `sortDirection` 与 `Project.recencyAt`（0.152.1 新增）：按最近活跃排序项目列表的前提已具备，当前仍只用手动 position 序。
- [x] `request_user_input_async`（0.153.0 新增）：`agentMessage.questions` 已进入后端 OpenAPI、前端统一 normalizer 与消息展示；建议答案作为只读提示展示，自由文本仍通过普通新消息回复，不与会阻塞 turn 的 `item/tool/requestUserInput` 混用。
- [x] 新模型推理强度：0.153.2 的真实 `model/list` 已返回 `max` / `ultra`，后端 OpenAPI 与前端选择器已同步放宽并完成冒烟验证。
- [x] 速度档位（service tier）：`ModelDto` 改为镜像 `serviceTiers` + `defaultServiceTier`（弃用的 `additionalSpeedTiers` 不再镜像），响应侧 `serviceTier` 从臆造的 `['fast','flex']` enum 改为 nullable string，`turn/start` 支持三态 `serviceTier` 覆盖，前端新增与模型选择器同级的 `ServiceTierSelector`。
- [x] 选择器展示目录说明文案：模型 / 推理强度 / 速度档位三处 description 统一过 `catalogCopy()`，复用英文自然语言 key 机制，未收录的串原样回落英文。`model/list` 无 locale 参数，`initialize` 也无语言能力位，上游不提供本地化。
- [x] 设置页 `service_tier` 下拉改为从模型目录动态取 tier id（原先写死 `fast` / `flex`，真实目录是 `priority` / `ultrafast`，该控件此前只能写出无效值）；`model_reasoning_effort` 下拉补齐 0.153.2 新增的 `max` / `ultra`。
- [x] `plugin/reconcile` 及其 `changedPlugins` 刷新提示（0.153.0 新增）：作为用户触发的 Sync installed 接入；按 hints scoped invalidate Plugins / Apps / MCP / Skills，hooks 无 consumer 不新增刷新面。
- [x] `AppsConfig.links`（0.153.0 新增）：**will not implement**。这是 per-linked-account approval override，不是外部链接配置；协议没有枚举 app link IDs 的 primitive，link id 只在 runtime tool-call app context 出现，按项目规则不模拟 client-side 能力。

### 数据、检索与审计

- [ ] Step 11 已跳过；如未来需要搜索/审计，优先评估 MeiliSearch 做全文索引。
- [ ] JSONL reconcile/import 后台任务：仅用于备份、审计、投影重建、跨版本迁移，不进入主 UI 读写链路。
- [ ] raw event / normalized event / projection 的可选持久化方案与 TTL/压缩策略。
- [ ] 终端输出、reasoning、敏感事件的持久化开关与脱敏策略。

### 部署与运维

- [ ] 固定 Codex CLI 版本，并把 `generate-ts`/schema 版本与运行镜像中的 CLI 版本对齐。
- [ ] `src/codex/codex-schema` 的生成/提交策略明确化，避免 fresh clone 或 Docker build 缺失类型。
- [ ] Docker runtime 使用非 root 用户，volume 权限与 node-pty native rebuild 做跨架构验证。
- [ ] 健康检查在启用 API 鉴权后携带认证头，或拆分内部 unauthenticated readiness endpoint。
- [ ] Docker 启动前 smoke check：`codex --version`、schema 生成、`model/list` 可用性。
- [x] HTTPS / 反向代理 / 内网暴露建议文档：README.md + README.en.md 新增 Nginx/Caddy 配置示例、WebSocket 升级、OnlyOffice publicBaseUrl 说明。
- [x] `docker.md` 实现文档补齐并与实际 Dockerfile/docker-compose 保持同步。

## Model catalog

- [x] REST includeHidden 透传；完整 bundled baseline 及更新命令。
- [x] Catalog seed/read/validate/draft/apply/default/restore/blockers/restart 与生成 SDK。
- [x] 独立 raw config 修复、model/review_model warnings、原生校验、两槽发布与恢复代码原型。
- [x] 接收后状态尚不可见的窗口：本连接 stdio 请求保留至可归属终态，补充而不替代上游查询；真实 turn/review/compact/queue/goal 集成测试验证。压缩**绑定到它自己开启的 turn**——上游四条手动路径全部显式发 `TurnStarted`、inline 自动压缩从不发（已读 0.153.2 源码确认），因此绑定要求「ack 之后开始 + 压缩是该 turn 首个 item + 该 turn 未被认领」三条同时成立，turn 记录按 thread 隔离且 `turn/started` 幂等；仍无法关联的 shellCommand 与 goal 工作拒绝应用至真实 thread/process close；外部客户端窗口明确返回在 limitations 并记入文档。
- [x] 启动重试策略：瞬时故障保留 3 秒自愈；目录被拒、pending 恢复失败两类停在诊断上；旧 child 停止超时不立即重试（避免双进程），改为在该进程真正退出时补发一次。「意外退出」按 child 记账而非读 controlled 标志，避免受控重启停止超时后旧 child 退出触发普通重启、在 activation 仍 pending 时启动候选；`stop()` 超时不覆盖原始诊断。
- [x] 目录文件读取有界：`readCatalogFile` 先 `stat` 拒绝非普通文件（FIFO 会无限期挂起）与超限大小，再异步读，避免用户可控路径拖垮负责修复它的进程。
- [x] `restartRequired` 与 `pointerApplied` 统一以「运行中 child 实际加载的目录」为判据，不再按文件差异推断，两处不再互相矛盾。
- [x] Thread 测试夹具收敛到 `threads.testing.ts`：三个 spec 各自手写 `v2.Thread` 字面量，每次协议升版都要各修一遍（0.153.2 加了 historyMode/model/reasoningEffort）。
- [x] Catalog UI：列表、模板继承的全字段表单、raw JSON 与阻塞列表；字段集从模板派生以保住未知上游字段。
- [x] 修复入口可达性：raw TOML 编辑器抽成 `raw-config-editor.tsx`，在 loading/error/success 下占据同一树位置（分支 early-return 会卸载它并丢掉未保存的 TOML）；目录区块提供 repairError，「重启 Codex」同时覆盖启动失败与「已配置但未生效」；恢复按钮条件与后端前置条件一致（含 pending 记录）。
- [x] 编辑器可用性与并发：表单保留中途输入原文（否则 JSON/数字字段无法逐字符编辑），字段定义取自打开时的条目而非实时草稿，每次打开重置；条目按 slug 定位而非对象身份；脏草稿不被服务端内容顶替，并提供「放弃改动、载入已保存草稿」的出路，保存只替换实际发出的文本。
- [x] 配置保存如实反映 `restartRequired` / `reloaded`，两条保存路径都显示目录 warning（结构化路径的 warning 单独留存，否则被保存后的失效重取冲掉），raw 保存带 `expectedContent`。
- [x] 来源状态不夸大：`pointerApplied` 只在确知不一致时为 false，无 child 或无 user-level 指针不报「待重启」；无覆盖时只说「没有用户级覆盖」，不断言 bundled 生效。
- [x] 阻塞项逃生指引与后端行为一致（暂停 goal / 浏览器关会话都不解除预留），并渲染后端 `limitations`。
- [x] Model picker 接入 includeHidden，移除前端二次过滤；生效中的隐藏模型恒常列出。
- [ ] 真实多 agent 调度和 approval/user-input 暂停组合的集成覆盖。
- [x] 修复页错误状态与 raw/表单切换往返的组件级渲染测试：覆盖真实 Query/SDK 回调、保存期间继续输入、跨浏览器冲突、TOML 编辑器挂载生命周期；修复查询失败被显示为无覆盖、标签关联和新增条目的实时模板重塑。
- [x] auto-resume 并发测量完成，保留全串行：独立 home 的 32 会话四次对照未证明有实用且可重复的吞吐收益，提高并发明显增加单会话尾延迟；不引入 limiter。详见 [recovery-concurrency.md](recovery-concurrency.md)。

## Thread 策略与恢复

- [x] 前后端两半均已落地（[契约](thread-policy-recovery.md)）。后端：安全设置观测值、按会话排队的变更、严格的载荷白名单、显式的 item 分页完整性、带权限字段的审批传输测试。前端：把 item 权威、turn 生命周期、历史覆盖范围三件事拆开；打开会话时按 turn 分组对账；open 与重连共用一个恢复协调器，且同时修复 turn 生命周期而不只修 item；审批内联进它所属的执行 item；per-thread 策略以观测顺序确认。**真实模型轮次的执行已实测**，不再是待验证项：会话在 `on-request`/只读下请求了审批，改为 `never`/完全访问后同一任务不再询问（`pnpm probe live-policy`）。
- [x] 协议探针从一次性脚本升为纳入版本管理、受类型检查的代码（`codex_probe/`，见 [README](../codex_probe/README.md)）。方法与其参数由生成的 `ClientRequest` 在类型层相关联，拼错的调用在 spawn 前就失败；每次运行使用隔离的 CODEX_HOME；只用钉住的二进制。
- [x] **策略观测值有了生命周期**。此前只在「从未观测过」时读一次，唯一刷新来源是 `thread/settings/updated`；断线期间由 CLI 或另一个客户端改的策略收不到通知，重连后无路径补读，徽章长期显示旧值且 Send 据此放行。现在打开完成（含重启恢复）及重连会补读策略，会话销毁或空闲驱逐时清掉观测值与确认计时器（`forgetPolicy` 此前在生产代码里从未被调用），`observed:false` 不再算作「已读过」因而不再永久卡在 unknown，仅最新发出的读取失败才会把已有证据标记为 `stale` 并在徽章上说明是「最后已知」而非当前生效。
- [x] **open 响应不再用旧快照复活已结束的轮次**。响应是服务端处理请求那一刻的快照；若该轮次的 `turn/completed` 在请求在途期间已到达，旧实现会把指针重新点亮、composer 永远转圈。现在 open 路径与 `settleTurnLifecycleForThread` 采用同一条守卫：本地已终态的 turn 不被快照里的 running 状态复活。effort 的 seed 受请求发出前的观测基线保护；serviceTier 是生命周期响应的本地 seed，测量表明 tier 不发变更通知，不再以无关通知清除该值。
- [x] **plan 文本纳入 item 权威模型**。`planTextByItemId` 从 `Record<itemId, string>` 改为携带 `completed` 与 `observedSeq`，与 `TurnItemBase` 一致：终态之后到达的 delta 被拒绝（此前会追加出重复尾巴），持久快照按与 `selectPayload` 相同的规则让位于更新的终态观测。
- [x] **重连恢复补齐两处缺口**。断线期间新开的轮次此前只恢复生命周期、不取内容，composer 显示在跑而该轮次渲染为空；现在被接管的活跃轮次先建立 turn 行，再一并取回 item 和提示词；即使读取头期间已有实时事件建立了行，也仍会补取缺失内容，同页普通旧历史不额外读取。审批只经 socket 送达，断线会同时丢掉两端：期间发起的不出现，期间在别的设备上被应答的不消失；现在重连按服务端的 pending 集合对账，启动路径与重连路径共用同一个 `syncPendingApprovals`。缺席仅解决请求发出前已有且未改变的 pending 卡片，已有决定不被旧快照重新打开；重叠读取按会话范围淘汰旧响应。
- [x] **shell 轮次稳定性对照实测**（`pnpm probe turn-item-finality`）：0.153.2 上，同一 completed shell 轮次的完整 item 载荷在后续 shell 轮次和已加载线程的 `thread/resume` 后一致。比较完整载荷并要求成功读取和 resume，不再仅比较输出长度，也不外推为所有模型轮次永久不变。
- [x] **completed turn item 新鲜度**：三次真实子代理实测确认终态 turn 追加 activity；直接终止 pinned 原生进程后的 cold read/resume 保留追加项。查询失效、full turn 查询资格和应用资格一起更新；只立即刷新当前渲染历史，其他缓存按需刷新。详见 [completed-turn-items.md](completed-turn-items.md)。
- [x] **断线期间完整错过的轮次**：恢复显式读取降序 summary 页，最多 10 页，锚点取读取发出前的 turn 集合。按页内身份与顺序合并，包括两个已知 turn 中间的缺口；无交集时采用最近窗口与真实 cursor，不伪造连续性。新增 live 边界、跨页缺口和删除后迟到读取回归。不再断言永久 append-only。
- [x] **pending 同步的挂载生命周期**：从启动 effect 抽取后一度丢掉了原来的 `cancelled` 检查，登出或卸载后的迟到响应仍会写入 store。`syncPendingApprovals` 增加可选 `AbortSignal`，请求前与应用前各校验一次；启动路径传入 effect 自己的 abort controller。重叠读取的相互淘汰解决不了这件事——它表达的是「另一次读取更新」，不是「这个调用方已经不在了」。
- [ ] **过期策略的显示与发送行为待确认**：当前 last-known 说明仅在策略弹层里，闭合徽章和 Send 不因 stale 单独改变；是否强化提示或阻止发送属于产品取舍。
- [ ] 探针每次运行使用独立目录并显式指定子进程 cwd，避免并发运行互相清空；定义有界的传输失败与清理行为。
- [ ] **崩溃 turn 的 `interrupted` 不是持久终态（已实测，原因未测）**：修正终止缺陷后重跑 `restart-recovery`，两个 active-goal 案例在 4 秒窗口后把崩溃 turn 读回 `inProgress`，且没有携带该 id 的 `turn/started`，goal 的新 turn 是另一个 id。只测到状态字段回退，**未测它是否真的在执行**。当前后端不受影响——该回退不经任何通知投递，resume 之后也不再轮询该 turn，`observeTurn` 的终态守卫因此从不触发；但若它确实在执行，执行盘点就漏了一条义务。需新探针回答"回退后的 turn 是否在做事"，再决定是否需要附着后的二次确认读。
- [x] **全部既有探针已在修正后的 harness 上重跑复核**（12 个，含花钱的）。结论：终止缺陷只波及真正依赖"崩溃"语义的测量，即 `restart-recovery`（两条复现、一条被推翻，见上）；其余探针只用 `close()` 走 SIGTERM，而 SIGTERM 一直被 wrapper 正常转发，因此结论不受影响。harness 的大改也**未引入回归**：`settings-update`、`item-persistence`、`item-ordering`、`turn-item-finality`、`server-request-identity`、`observable-service-tier`、`live-policy`、`file-approval-context`、`metadata-filters`、`metadata-incremental` 十条全部复现原结论。两个例外都不是回归——`server-request-disposition` 的 fixture 未被触发（模型改用文件编辑工具而非 shell），探针如实报告「this run measured nothing」并以非零码退出；`auth-token-refresh` 的核心比较成立且差距更大（拒绝 34.8s vs 静默撞上 180s 上限仍未结束），但它先前附带的「静默最终会结束」这次**未复现**，静默的收敛时间不可依赖。

## 后端发现与恢复的重构

- [x] 共享的内存元数据读模型：完整发布、显式新鲜度、后端自有的外部变更发现；折叠先于分页的既有约束不变。
- [x] 面向已认证连接的全局失效信号（overview / pending），覆盖已提交的取消与过期。
- [x] 后端全局 attention：显式区分 human/machine 请求；完整文件变更集合在首次发布前关联，live 与 REST 均携带 reviewSubject；全局退休覆盖 CAS、取消和过期；删除范围内的 pending 读取返回 409 而非伪造缺席，无 DB 迁移。
- [x] 原生 command/writeStdin/file approval 与 user-input 的全局 attention：live/REST 共享幂等摄入与通知，generation 配对退休保留本地决定；完整主体严格校验，inline/standalone 均使用请求主体并在缺失时只给 Decline/Cancel；删除读取 409 保持原状态。
- [x] 以执行义务而非 socket 成员资格作为重启恢复依据：进行中/被阻塞的 turn、活跃 goal、父会话先于子会话重新附着；所有浏览器断开后依然恢复；不重放任何提交。
- [x] 钉住版本的元数据探针：字面量 name/preview 搜索、相对 cwd、排序、外部变更发现，以及「列出的父会话缺失」这一上游限制。
- [x] 增量元数据的审查修复：实时 patch 跨分页存活、归档迁移使被跨越的走查作废、pending-listing 的紧急性收窄到单个会话且无后续 turn 也会过期、走查期间抬起的陈旧标记跨发布存活。
- [x] 修正增量探针的秒级时间戳误差：拉开间隔后，即使是被拒绝的 turn 也会推进 `updatedAt`；排序保持显式陈旧直到周期发现。
- [x] 侧边栏行索引只由**正在渲染**的视图构成。被 gate 的查询仍保留缓存，索引全部三个视图会让陈旧的详情页盖掉新鲜的首页行——连 `openThreadId` 与成员集合一起盖掉，而这两者决定点击行为。逻辑抽到 `web/src/lib/sidebar-rows.ts` 并有回归测试。
- [x] 排序时效滞后确认为**有意取舍**（2026-09-10 裁决）。恢复即时排序需要在 turn 结束时对单个会话做针对性元数据读，且需先探针确认投递时上游 `updatedAt` 是否已推进。见 [conversation-recovery.md](conversation-recovery.md)。
- [x] 崩溃/重新附着的原生行为探针（`codex_probe/restart-recovery.ts`）：崩溃发生在 turn 进行中，实测重新附着能恢复什么、不能恢复什么。
- [x] 未关联的执行活动保持保守：只有相关的终态证据或关闭/删除才退休它；不得用无关的历史完成事件去剪枝。已有实现及 `thread-execution-inventory.service.spec.ts` 回归测试覆盖。
- [x] 前端刷新与按需订阅：overview 全局信号共用有界延迟失效，覆盖会话与分支查询；pending 共用可取消、含尾随读取的全局对账。页面加载由路由 opener 负责，重启只恢复正在看的转录，重连只读不 resume；三者共享历史/item/policy/auxiliary 修复。原 open applier 已有 policy 读取，现移除 wrapper 重复读取。选择与路由退出真正离开旧房间，订阅确认后补读连接前窗口；无启动期批量订阅。
- [x] 重新生成前端 SDK 以覆盖 overview 新增的 `freshness` 字段，以及 pending 的 `reviewSubject` / `generation` 与 `{generation, requests}` 响应。
- [ ] 归档范围契约：workspace 过滤后的 `memberThreadIds` 不包含其它工作区成员，后端却归档完整已知树；跨工作区成员的前端清理/离开当前会话仍需权威的归档范围或逐线程事件对齐，不能从未显示的旧缓存推断。
- [ ] 用真实模型的 turn、goal 与受控子会话验证崩溃/重新附着结果；重新附着本身不承诺执行续跑。
- [x] 二次交叉审查：归档完成使用请求发出时的成员集合，避免视图切换/刷新后遗漏隐藏分支；四组独立冷恢复探针区分 null 与实际分页、读取附着前 goal、验证模型请求确实已挂起；旧 turn 终态不删除新 goal 续跑 turn。
- [ ] **策略变更需另行产品裁决**：活跃 goal 冷恢复后可由原生调度器开启新 turn，与已批准的活跃 goal 恢复保持一致。当前不改恢复策略、不加开关；如果要禁止无人值守续跑，需先确认产品语义与原生能力，不能假定已有"仅附着不执行"模式。
- [x] **Server request totality 与外部 token refresh**：每个已导出 method 在 ingress 穷尽分流，未知运行时 method 明确错误答复；外部 ChatGPT token 无 refresh 凭据，立即拒绝并提示重新登录。实测该方法会按约 10 秒超时重试，不再描述为无限等待。登录/API key/token 的本地 wire audit 投影先行脱敏，不改实际 payload。
- [x] **审批响应身份契约**：随机 instanceId 贯穿数据库、live、pending 读取、两个响应 API 与退休。拒绝缺失身份，重复 admission 不覆写 proposal；CAS 先提交 submitted，再写原连接，原生通知确认 resolved。模糊传输失败不重开 pending、不重试。已覆盖终态先于 HTTP 的本地决定归因、instance tombstone 消费、Nest 主体捕获顺序、竞争 SQLite writer 与连接退出路径；失败恢复在 SQL 中限取当前数值 generation 和请求范围的最新 20 条（完整 backend 重启后 generation 复用的提示限制见 approval.md）。
- [x] **其余人机请求的浏览器交互**：权限完整显示及选择编码；MCP primitive form/URL 与 nullable turn；未知扩展语义只提供 Decline/Cancel。两种 legacy approval 明确拒绝。客户端失败说明与上游 turn outcome 分开保留。
- [x] **service tier 本地诚实显示**：测量证明不存在可用被动读，tier 变更也没有通知；不引入跨客户端同步或用于刷新显示的 resume。采用参考客户端的生命周期 seed 与模型支持过滤，unsupported 配置不冒充 Standard，并显示上游 warning。
