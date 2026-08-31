# WebSocket 事件流实现文档

## 概述

后端 ThreadsGateway (Socket.IO, namespace `/ws`) 接收 Codex app-server 的通知，按 threadId 路由到订阅了该 thread 的前端客户端。通常保持透明；唯一内容投影是 `error` / failed `turn/completed` 的 misalignment detail：保留分类与解释、删除 continuation `steer`，再交给前端 dispatcher。

## 事件流向

```
codex app-server (stdout JSONL)
  → CodexJsonRpcClient.handleMessage()
  → emit('notification', ...)
  → CodexProcessManager.eventForwarders
  → ThreadsGateway.handleCodexNotification()
  → Socket.IO room `thread:{threadId}`
  → 前端 useCodexSocket hook
  → notification-handlers.ts dispatcher
  → Zustand timeline-store / snackbar-store / TanStack Query
  → React 组件重渲染
```

## Socket.IO 事件

### Client → Server

| 事件 | Payload | 作用 |
|------|---------|------|
| `thread.subscribe` | `{ threadId }` | 加入 Socket.IO room |
| `thread.unsubscribe` | `{ threadId }` | 离开 room |
| `codex.serverResponse` | `{ id, result }` | 回复审批等 server request |
| `fs.subscribe` | `{ path }` | 订阅目录变更，首次创建 chokidar watcher |
| `fs.unsubscribe` | `{ path }` | 取消订阅，无订阅者时关闭 watcher |
| `terminal.open` | `{ cwd, cols, rows }` | 打开 PTY session，回调返回 `{ terminalId }` |
| `terminal.input` | `{ terminalId, data }` | 用户键盘输入 |
| `terminal.resize` | `{ terminalId, cols, rows }` | 终端窗口大小变化 |
| `terminal.close` | `{ terminalId }` | 关闭终端 session |

### Server → Client

| 事件 | Payload | 作用 |
|------|---------|------|
| `codex.notification` | Codex notification（turn error 已去 steer） | 所有通知统一事件名 |
| `codex.serverRequest` | `{ id, method, params }` | 需要前端回复的请求 |
| `fs.changed` | `{ event, path }` | 文件变更通知 (add/change/unlink/addDir/unlinkDir) |
| `terminal.output` | `{ terminalId, data }` | PTY 输出 |
| `terminal.exit` | `{ terminalId, exitCode }` | PTY 进程退出 |

`thread/settings/updated`、`thread/goal/updated`、`thread/goal/cleared` 以及 inline review 产生的 `turn/*` / `item/*` notification 走同一个 `codex.notification` 通道，按 `params.threadId` 投递到对应 room。除上述错误投影外，后端不改写事件。

## Notification Dispatcher 架构

前端使用 `notification-handlers.ts` 的 method→handler dispatch map 处理所有 ~50 个 ServerNotification 方法，分三个 Tier：

### Tier 0 — Item/Turn 生命周期（原有）

| Method | 处理逻辑 |
|--------|----------|
| `item/reasoning/summaryTextDelta` | 追加 reasoning 内容, 自动展开 |
| `item/agentMessage/delta` | 追加 agent 回答文本（打字机效果）|
| `item/commandExecution/outputDelta` | 追加命令输出 |
| `item/fileChange/outputDelta` | 追加文件变更 patch 内容 |
| `item/started` / `item/completed` | 共用纯 `normalizeThreadItem`；覆盖全部 19 个 protocol item（user/plan 为 dedicated outcome），未知类型产生安全可见 fallback |
| `turn/diff/updated` | 更新 turn 级别聚合 diff |
| `turn/completed` | 标记 turn 完成；failed 时 upsert 结构化 TurnFailure；停止 loading，失效 thread list |

### Tier 1 — 高价值通知

| Method | 处理逻辑 |
|--------|----------|
| `error` | willRetry=true → warning toast（去重）；false → error toast + 结构化 TurnFailure upsert + 停止 loading。后续稀疏 terminal event 不会抹掉详情 |
| `thread/tokenUsage/updated` | 存储 per-turn 用量，更新 latest（驱动 ChatInput 圆环 + turn footer）|
| `serverRequest/resolved` | 按 requestId 校准 approval 状态为 resolved，支持乱序到达 |
| `configWarning` | warning toast（summary + details）|
| `deprecationNotice` | warning toast |

### Tier 2 — Thread/Turn 生命周期

| Method | 处理逻辑 |
|--------|----------|
| `thread/started` | debounced 失效 thread list |
| `thread/status/changed` | 更新 active thread status, systemError → 系统条目 |
| `thread/name/updated` | debounced 失效 thread list |
| `thread/closed` | active thread → 系统条目; debounced 失效 thread list |
| `thread/archived` | active thread → 系统条目; debounced 失效 thread list |
| `thread/unarchived` | debounced 失效 thread list |
| `thread/deleted` | 清除该 thread 的全部本地 runtime 与订阅；debounced 失效 thread list + branch trees。当前打开的会话例外：只加系统条目，不清 runtime（见下）。**判据必须用 `ctx.getSelectedThreadId()`，不能用 `ctx.threadId`** —— 分发器在调用 handler 前会把 `ctx.threadId` 设成该通知自身的 threadId，用它比较恒为真，会导致 runtime 永不清理，且给从未打开过的会话追加系统条目还会凭空建出幽灵 runtime |
| `turn/started` | 初始化空 turn block, 设置 loading |
| `thread/compacted` | active thread → info 系统条目 |
| `model/rerouted` | active thread → warning 系统条目 + info toast |

### Tier 2.5 — Integrations 通知

| Method | 处理逻辑 |
|--------|----------|
| `app/list/updated` | invalidate apps TanStack Query（Integrations Apps tab 刷新） |
| `mcpServer/oauthLogin/completed` | invalidate MCP status query + success/error toast（`params.success === true` 严格判断） |
| `skills/changed` | invalidate skills query（queryHasId `_id` pattern 匹配） |

### Tier 3 — 已知低优先级（debug-only）

hooks, realtime, fuzzy search, Windows sandbox 等 ~28 个方法 → dev 模式 `console.debug(method)`
注：`app/list/updated` 和 `mcpServer/oauthLogin/completed` 已提升至 Tier 2.5

### Unknown — 未识别方法

dev 模式 `console.debug`，不静默丢弃。

## Token Usage UI

- **Per-turn footer** (`turn-token-footer.tsx`): 每个完成的 turn 底部展示该 turn 的 input/output/cached/reasoning/total
- **Context window donut** (`token-usage-ring.tsx`): ChatInput 发送按钮左侧的圆环进度图，展示 `total.totalTokens / modelContextWindow`，hover 展开完整 breakdown

## 已处理的 Server Request Methods

| Method | 处理逻辑 |
|--------|----------|
| `item/commandExecution/requestApproval` | 按 `kind: command \| writeStdin` 解析为 ApprovalRequest；保留 approvalId，以 JSON-RPC requestId 独立存储并按请求 turn 渲染 |
| `item/fileChange/requestApproval` | 解析为 ApprovalRequest，渲染审批卡片 |
| `item/tool/requestUserInput` | 解析为 UserInputRequest（EXPERIMENTAL），渲染 UserInputCard（radio/checkbox/text/password）|

用户点击 Accept/Decline → `codex.serverResponse` → 后端回传 app-server。

**删除期间的抑制与重放**：thread 处于删除守卫内时，gateway 仍照常写入 SQLite（保持 `pending`），但**不广播**该 thread 的 server request，并把它暂存在内存里。守卫释放时逐条重放：只重放 DB 里仍为 `pending` 的（真正被删掉的 thread 其待审批已在本地清理阶段置为 `cancelled`）。中止的删除因此不会留下"app-server 还在等、UI 却永远看不到"的请求。详见 [approval.md](approval.md)。

用户提交 UserInputCard → `pendingApprovalsRespond` REST → 后端回传 app-server。
`serverRequest/resolved` 通知 → 按 requestId 匹配审批/用户输入卡片 → 标记为 resolved。

## Thread 切换流程（多 Thread 并发）

```
用户点击侧边栏 thread
  → setActiveThread(targetId)
  → 保留旧 live thread runtime 和 socket room 订阅，直到 idle cleanup 判定可安全释放
  → socket.emit('thread.subscribe', { threadId: targetId })
  → POST /api/threads/:threadId/resume (后端 ensureResumed 去重)
  → hydrateTimelineForThread(targetId)
  → 恢复 threadStatus + activeTurnId + loading
  → 新的通知通过 socket 实时追加到对应 thread runtime
```

## 注意事项

- 非 thread-scoped 的通知（如 error, configWarning, deprecationNotice）广播给所有连接
- server request 发给 thread room 内的客户端；审批响应通过 REST CAS 接口，first-writer-wins
- `useCodexSocket` 通过 `useTimelineStore.getState()` 获取最新 per-thread actions，避免 stale closure
- notification-handlers 通过 mutable `ctx.threadId` 按 `params.threadId` 路由到对应 thread runtime
- 生命周期事件的 thread list 失效使用 300ms debounce 防止风暴
- 重试 error toast 按 `threadId:turnId:message` 在 5s 窗口内去重
- `serverRequest/resolved` 可能先于 approval 到达，使用 per-thread pendingResolvedRequestIds 缓冲；approval 和 user-input 均按 requestId 定位
- `subscribedThreadIds` 通过 `general.maxIdleSubscriptions` 做空闲 LRU 清理；active / loading / pending approval / pending user-input / buffered resolved-request thread 不会被清理
