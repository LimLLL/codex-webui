# 前端状态管理实现文档

## 概述

使用 Zustand 管理前端状态。组件通过 selector 订阅，避免不必要的重渲染。

## timeline-store

文件: `web/src/stores/timeline-store.ts`

### State

Multi-thread 架构：`threadsById` 存储所有 thread 的独立运行时状态，`selectedThreadId` 控制当前可见 thread。selected thread 的字段同步镜像到顶层方便消费。

| 字段 | 类型 | 说明 |
|------|------|------|
| `selectedThreadId` | `string \| null` | 当前显示的 thread |
| `threadsById` | `Record<string, ThreadRuntimeState>` | 所有 thread 的独立运行时状态 |
| `subscribedThreadIds` | `Set<string>` | 已订阅 socket room 的 thread ID 集合 |
| `maxIdleSubscriptions` | `number` | 空闲 live thread socket 订阅保留上限，来自 `general.maxIdleSubscriptions` |
| `threadId` | `string \| null` | 当前 thread ID（= selectedThreadId 镜像） |
| `threadCwd` | `string \| null` | 当前 thread 工作目录 |
| `threadTitle` | `string \| null` | 当前 thread 标题 |
| `threadMode` | `'live' \| 'readOnly'` | live = 可交互; readOnly = 归档快照 |
| `timeline` | `TimelineEntry[]` | 当前 thread 的消息时间线 |
| `loading` | `boolean` | 是否有 turn 进行中 |
| `expandedReasoning` | `Set<string>` | 展开的 reasoning item ID 集合 |
| `approvals` | `Record<string, ApprovalRequest>` | 按 JSON-RPC requestId 索引的审批请求；同一 command item 的 command/writeStdin 回调不会互相覆盖 |
| `userInputRequests` | `Record<string, UserInputRequest>` | 按 requestId 索引的用户输入请求（EXPERIMENTAL） |
| `tokenUsageByTurn` | `Record<string, ThreadTokenUsage>` | 按 turnId 索引的 token 用量 |
| `threadStatus` | `ThreadStatusType \| null` | thread 活跃状态（idle/active/systemError） |
| `activeTurnId` | `string \| null` | 当前进行中的 turn ID |
| `pendingResolvedRequestIds` | `Set<string>` | 已被 resolved 但尚未 hydrate 的请求 ID |
| `historyCursor` | `string \| null` | 下一页**更早**历史的游标；null 表示历史已完整 |
| `historyLoading` | `boolean` | 是否正在拉取更早的一页历史 |
| `readOnlyReason` | `string \| null` | 写所有权被其它进程持有时的拒绝原因；null 表示可写 |
| `deletedRemotely` | `boolean` | 该会话已被他处删除。transcript 刻意保留（见 `thread/deleted`），但必须同时变为不可写 —— 保留可读不等于保留可用 |
| `lastActivityAt` | `number` | 运行态最后一次选择/通知/hydrate/审批更新的时间戳，用于 LRU 清理 |

**三种不同的不可写**，补救方式各不相同，UI 文案必须分开：`threadMode === 'readOnly'`（归档快照，去取消归档或 fork）、`readOnlyReason !== null`（写锁被其它客户端占用，去那端关闭）、`deletedRemotely`（已被删除，无补救）。后两者都带完整 transcript，外观上看不出只读。

### TimelineEntry 类型

```ts
| { kind: 'user'; content: string; images?: string[]; turnId?: string }
| { kind: 'system'; content: string }
| { kind: 'turnFailure'; turnId; failure } // terminal error + optional persisted detail
| { kind: 'turn'; turnId; items; completed; diff? }  // diff = turn-level unified diff
```

`user.turnId` 是消息级分支的前提（见 [conversation-branches.md](conversation-branches.md)）。hydration 时直接取所属 turn 的 id；乐观追加的消息此时还没有 turn，由 `setActiveTurnIdForThread` 在 `turn/started` 时通过 `bindPendingUserMessage()` 回填到最新的未绑定 user 条目——与后端 `attachPendingVersionTurn` 对称。没有 turnId 的消息不可分支，而那正好是分支本身无效的窗口。

### TurnItem 类型

`TurnItem` 是 discriminated union，不再用一组跨类型 optional 字段表达。内部覆盖当前 17 个可渲染分支：既有 reasoning/message/MCP/command/file/review/compaction，加上 hook prompt、standalone function output、dynamic tool、collaboration、sub-agent activity、web search、image view、sleep、image generation，以及 `unknownActivity` 安全 fallback。

`lib/thread-item-normalizer.ts` 是 live `item/{started,completed}` 与 persisted history/top-up 的唯一纯归一化入口。结果显式区分 render、unknown、userMessage、plan、invalid；未来协议类型被转换成只含 `protocolType`、`itemId`、`completed` 的 `unknownActivity`，原 payload 不进入页面。renderer 对内部 union 穷尽 switch，无 catch-all，因此新增内部分支却没 UI 会在编译期失败。结构化 function output 的 encrypted branch 只保留“已加密”标记，不保留 ciphertext。

### Actions

| Action | 触发时机 | 说明 |
|--------|----------|------|
| `fetchThreads` | 应用启动 | 加载侧边栏列表 |
| `createThread` | 点击 + 按钮 | 创建 thread, 订阅 socket room, 加入列表顶部 |
| `switchThread` | 点击侧边栏 | 切换 thread, resume 加载历史 |
| `sendMessage` | Enter 发送 | 追加 user entry, 调 turn/start API |
| `toggleReasoning` | 点击 Thinking | 展开/折叠 reasoning |
| `setMaxIdleSubscriptions` | `authenticated-layout` 读取 general settings 后 | 更新空闲订阅保留上限并立即执行一次清理 |
| `cleanupIdleThreadSubscriptions` | `setActiveThread`、5 分钟 interval | 清理超过上限的安全空闲订阅，同步 socket unsubscribe + 删除 runtime |

### 内部 Mutation

| Method | 调用者 | 说明 |
|--------|--------|------|
| `updateCurrentTurn` | socket hook | 创建或更新最后一个 turn entry |
| `updateTurnItem` | socket hook | 在 turn 内创建或更新 item |
| `expandReasoning` | socket hook | 流式 reasoning 时自动展开 |
| `collapseReasoning` | socket hook | reasoning 完成时自动折叠 |
| `setLoading` | socket hook | turn/completed 时设 false |
| `upsertTurnFailure` | socket / persistence hydration | 按 turnId 插入或合并结构化失败；稀疏终止通知不会清掉更早的丰富字段 |

### 订阅清理

`general.maxIdleSubscriptions` 默认 30（范围 5-200），由 Settings General tab 配置。`authenticated-layout` 通过 `GET /api/settings?category=general` 读取后写入 timeline-store，并每 5 分钟触发一次清理。

清理只处理 safe idle runtime：非当前选中 thread、`loading=false`、无 `activeTurnId`、无 `pendingResolvedRequestIds` 缓冲、`threadStatus` 不是 `active`、无 pending approval、无 pending user-input。候选按 `lastActivityAt` 排序，超过 15 分钟未活动的 thread 在超过上限时优先被驱逐。

每个被驱逐的 thread 会先从 `subscribedThreadIds` 和 `threadsById` 删除，再 emit `thread.unsubscribe` 让后端 socket room 与 `ActiveThreadRegistryService` ref-count 同步。再次打开该 thread 时走现有 `setActiveThread` + `thread/resume` 恢复路径。

### 打开线程的唯一入口 (use-thread-open)

**只有路由负责打开线程**，侧边栏与分支图只负责导航。此前侧边栏点击会 resume 一次、路由挂载再 resume 一次，两个 onSuccess 各自拉 token 用量/diff/错误 —— 一次点击 8 个请求、全量 turn 载荷传两遍。而 resume 不是只读操作，它会争夺 paginated thread 的写所有权，所以重复不只是浪费。

`applyOpenResponse` 是**唯一**解释打开响应的地方，被三条路径共用：路由打开、刷新恢复（`authenticated-layout`）、app-server 重启后重连（`use-codex-socket`）。三处此前都直接读 `thread.turns`，而该字段在 metadata-first 之后恒为空数组。

关键行为：

- **缓存优先**：目标 thread 已 hydrate 时不进入加载态，直接渲染既有内容，请求只用于刷新。
- **倒序反转**：服务端按 `sortDirection: desc` 返回最近一页，时间线需要正序，在 hydration 处反转一次。
- **重开不丢分页**：若返回页的 turn 全部已在本地时间线中，则保留现有时间线与 `historyCursor`，不做替换 —— 否则离开再回来会把已加载的更早历史悄悄丢掉。若返回页含未知 turn，说明会话在别处推进过，以服务端为准整体替换。
- **迟到响应保护**：成功与失败回调都先检查运行时是否仍存在。store 的 setter 是 create-if-absent 的，删除进行中若有 in-flight 响应落地，不加保护会把已删会话的外壳重新建出来。
- **后台恢复不写指针**：刷新/重连恢复会遍历所有已加载线程，若允许它们写活跃分支指针，每棵树会指向恢复顺序中的最后一个成员，正是该指针要解决的问题。这两条路径显式传 `recordActive: false`。
- **fork 也只导航**：钉住的 0.152.1 fork 响应刻意请求 metadata-only。侧边栏不再从响应里的 `thread.turns` 或并行 auxiliary reads 自行 hydration；后端提交 provenance 后才返回，随后路由的 canonical opener 统一分页历史并读取继承后的 token usage / turn diff / turn error。
- **降级只读同样分页**：正常 resume 失败后，路由并行读取 metadata 与最近 20 个 summary turns，两者都成功且路由仍指向目标 thread 时才应用；更早历史沿用同一个 `historyCursor` 与显式“加载更早的消息”入口。已有 live runtime 会被显式切换为 `readOnly`，避免只读快照仍保留可写模式。

Approval 与 user-input request 会为自己的 `turnId` 保留空 turn entry，即使最近一页历史没有该 turn。`writeStdin` 回调的 item 可属于更早的 turn，因此卡片按回调 turn 渲染为 unattached request，而不是倒挂回原 command 或改变其 lifecycle。

### 历史恢复 (turnsToTimeline)

打开线程只返回最近一页 turns，用 `turnsToTimeline()` 转换为 TimelineEntry 数组；更早的历史由 `historyCursor` 按需拉取并 `prependHistoryForThread` 前插（按 turnId 去重，游标页含锚点行，重试会重叠）:

- `userMessage` → `{ kind: 'user', turnId: turn.id }`
- 每个 raw item 与 live 通知共用 `normalizeThreadItem()`；所有已知 variant 在刷新前后保持同一内部形状
- `userMessage` / `plan` 走 dedicated outcome，分别进入 user entry / plan panel
- 未知 variant → 可见 `unknownActivity`，只显示类型与 lifecycle
- failed turn → `turnFailure`；随后本地 `/turn-errors` hydration 合并保留的 category、additional details 与 misalignment explanation

## files-store

文件: `web/src/stores/files-store.ts`

详见 [files-service.md](files-service.md)。

核心字段: `rootDir`（当前浏览目录）、`selectedFile`、`fileMtime`、`panelOpen`。REST 数据由 TanStack Query 管理，store 仅管 UI 状态。

文件操作 mutations 集中在 `hooks/use-file-operations.ts`（详见 [files-service.md](files-service.md)）。

## connection-store

文件: `web/src/stores/connection-store.ts`

只有 `connected: boolean` + `setConnected`。由 `useCodexSocket` hook 在 socket connect/disconnect 时更新。ChatHeader 的连接状态 badge 消费。

## layout-store

文件: `web/src/stores/layout-store.ts`

Responsive shell 与 sidebar UI state。使用 Zustand `persist` 中间件 + `partialize` 选择性持久化。

| 字段 | 持久化 | 说明 |
|------|--------|------|
| `desktopSidebarCollapsed` | localStorage | Desktop 手动收起 sidebar 偏好 |
| `collapsedGroupKeys` | localStorage | Sidebar workspace group collapse keys（`string[]`，序列化友好） |
| `sidebarOpen` | runtime only | Mobile/tablet sidebar Sheet open state |
| `sidebarView` | runtime only | Sidebar navigation view（overview / workspaceDetail / archivedDetail） |

`sidebarMode` 不存储，由 `useBreakpoint()` + `desktopSidebarCollapsed` 在 `authenticated-layout.tsx` 派生。

配套 hook: `useBreakpoint` (`web/src/hooks/use-breakpoint.ts`) — `useSyncExternalStore` + `matchMedia`，返回 `'mobile' | 'tablet' | 'desktop'`。`useIsMobile()` 便捷函数。

Socket.IO / thread runtime 不依赖 layout store。

## theme-store

文件: `web/src/stores/theme-store.ts`

`dark: boolean`，Zustand `persist` + `partialize`。`onRehydrateStorage` 回调应用 `dark` class。启动时 `migrateLegacyStorage()` 将旧格式纯字符串 `"dark"`/`"light"` 迁移为 Zustand persist JSON。

## 数据流

```
用户操作 → store action → API call → 后端 → codex app-server
                                              ↓
前端 socket event ← ThreadsGateway ← notification
       ↓
useCodexSocket → store mutation → React re-render
```
