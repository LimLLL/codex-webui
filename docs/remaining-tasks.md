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
- [x] `respondToServerRequest` 回写 app-server stdin (CodexJsonRpcClient)

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
- [x] `ThreadsGateway`：serverRequest 先持久化再 emit、serverResponse 通过 CAS 服务响应

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
- [x] `GET /api/logs/export`：sanitized 诊断 bundle（日志 + 系统信息 + 运行状态）。
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
- [x] app-server 重启后的 active thread 自动 `thread/resume` 与 snapshot 恢复。ActiveThreadRegistry ref-count + AutoResumeService lifecycle event + codex.lifecycle socket event + 前端 reconnect 重新订阅。

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
- [x] TurnErrorsService 后端拦截 final `error` / failed `turn/completed` 通知 → upsert。`GET /api/threads/:threadId/turn-errors` 前端 hydrate，按 turnId 插入对应 turn 后方。
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
- [ ] multipart upload e2e 测试（Fastify 插件在测试上下文注册有问题，已延后）。

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

- [x] 新建线程导航 500 错误：`thread/read(includeTurns: true)` 对未 materialized 线程报错。`ThreadResumeRegistryService.readAsResume` 和 `ThreadsService.readThread` 添加 fallback（检测 "not materialized" 错误 → 重试 `includeTurns: false`），共享 predicate `isNotMaterializedError`（`thread-errors.ts`）。
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

### UI 与交互增强

- [x] 可折叠工具调用：连续 2+ 个 MCP 工具调用合并为可展开/收起的分组；单个工具调用也可折叠参数/结果。完成后自动收起，`aria-expanded` 无障碍支持。
- [x] TanStack Router 集成：code-based route tree，auth guard（beforeLoad + redirect search param），thread URL 化（`/t/$threadId`），SPA deep-link fallback（`fallthrough: true`）。
- [x] `/login`、`/settings` 页面与路由导航。`/workspaces` 待 Workspaces API 完成后实现。
- [x] Settings: General tab（theme toggle + language dual-button + logout）。theme 持久化 localStorage，shared store。
- [x] Model picker + reasoning effort：ChatInput `ModelSelector` popover，session-level overrides（Zustand `model-store`），`turn/start` 传 `model`/`effort`。后端 runtime validation。
- [x] `/api/codex/status` models 字段瘦身：只返回 `{ ok, listable, count, defaultModel }`，ModelSelector 用独立 `GET /api/models`。
- [x] Markdown 渲染：`react-markdown` + `remark-gfm` + Shiki 懒加载语法高亮，agent/user 消息均支持。
- [x] react-i18next 国际化：自然语言 key，en + zh-CN，语言切换。
- [x] TanStack Virtual 虚拟列表：`useVirtualizer` + `measureElement` 动态高度，smart auto-scroll（流式跟随 + 上翻不打断），TurnBlock 去 motion 避免 recycling 重复动画。
- [x] Rich Chat Input：@ 文件引用（内联文本 + 路径导航 popover）、粘贴图片/文件上传、Skill 选择器、FileTree 右键附加、消息气泡 @mention badge + AuthImage 图片预览。ChatInput 拆分为 3 文件。后端 ChatModule（upload 暂存）+ SkillsModule + StartTurnDto v2 union 校验。
- [ ] app @mention 的 composer 输入能力。
- [ ] 分支图节点显示轮数：`thread/list` 的 `turns` 恒为空数组，唯一来源是逐节点 `thread/read includeTurns`（实测单个 39 轮会话 3 MB / 174 ms），十节点的图代价不可接受。可行方向是 hover 时按需拉取，或后端加轻量计数接口。本地 per-turn 表不可用于计数——会漏掉本客户端之外产生的轮次。
- [ ] 主包体积：入口 chunk 约 4.1 MB（gzip 1.25 MB），Monaco / xterm / shiki / pdf.js / xlsx 均在其中。React Flow 已拆出独立 chunk（179 kB），其余仍待按路由拆分。
- [ ] 当前打开的会话被他处删除时无法自动离开：通知分发层拿不到 router，只加了系统条目告知用户，runtime 刻意保留以免无解释地清空正在阅读的内容。可行方向是沿用既有的 `codex-webui:*` CustomEvent 模式，由 layout 监听并导航。
- [x] diff 面板增强：`@git-diff-view/react` + `@git-diff-view/shiki` GitHub 风格 diff 视图（split/unified 切换、语法高亮、error boundary fallback）。
- [x] 审批卡片增强：`acceptForSession`、`cancel`、granular permission（exec/network policy amendment）。按钮由服务端 `availableDecisions` 动态控制，legacy fallback 仅 accept/decline。proposed amendments 由服务端提供，不允许自由构造。`FileChangeItem` 同步支持。runtime parser 校验协议数据。

### Codex 高级能力

- [x] `account/read`、`account/login/start`、ChatGPT device code flow、`account/rateLimits/read`、`account/logout`。Settings Account tab + Header rate limit badge。
- [x] `mcpServerStatus/list`、MCP server startup 状态、MCP tool call progress 可视化、`config/mcpServer/reload`。ChatInput + Header badge + Popover。
- [x] `skills/list`：GET /api/skills 透传 + SkillSelector popover + skill input item。
- [x] `skills/config/write`：POST /api/skills/config + SkillSelector manage mode（inline Switch toggle）。`skills/changed` invalidation 修复为 queryHasId 模式。
- [x] `app/list`：GET /api/apps + Integrations 页面 Apps tab（分页列表 + enable/disable via config/batchWrite + installUrl 外链）。App config allowlist 扩展支持 `apps.<id>.<field>` 正则。
- [x] plugin marketplace：`plugin/list`、`plugin/read`、`plugin/install`、`plugin/uninstall`。PluginsModule 4 端点 + Integrations 页面 Plugins tab（搜索/Featured/Installed/Marketplace 分组 + Sheet detail drawer + cascade invalidation）。
- [x] `mcpServer/oauth/login`：POST /api/mcp-servers/oauth/login + MCPs tab OAuth 登录流程（sync blank tab + copy-link fallback）。BigInt timeoutSecs 安全序列化。
- [x] Integrations 页面：`/integrations` 路由（URL search tab state）+ sidebar Puzzle 图标导航 + 3 tab（Plugins/Apps/MCPs）。
- [ ] `app/list` connector @mention composer 输入能力。
- [ ] App tool-level config（per-tool enabled + approval_mode）。
- [ ] App/Plugin ID 字符集放宽：当前 config allowlist 正则只接受 `[A-Za-z0-9_-]+`，若 app-server 返回含 `.`/`:`/`/` 等字符的 ID，config 写入会 400。需用真实 app/list 样本确认后放宽。
- [ ] Plugins `cwds` 查询参数类型修正：后端 `@ApiQuery` 缺 `type: String`，SDK 生成为 `Array<unknown>`。前端暂不传 cwds，启用 repo marketplace 过滤时需修。
- [ ] `review/start` 代码审查模式。
- [x] `config/read`、`config/batchWrite`、profile/settings UI：CodexConfigController（GET/PATCH structured + GET/PUT raw），Settings Codex tab（14 curated fields + profile switch + security read-only + Monaco raw editor），共享 json-safe 工具。
- [ ] `thread/backgroundTerminals/clean`、collaboration mode 等 experimentalApi 能力按开关暴露。

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
