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
| `approvals` | `Record<string, ApprovalRequest>` | 按 itemId 索引的审批请求 |
| `userInputRequests` | `Record<string, UserInputRequest>` | 按 requestId 索引的用户输入请求（EXPERIMENTAL） |
| `tokenUsageByTurn` | `Record<string, ThreadTokenUsage>` | 按 turnId 索引的 token 用量 |
| `threadStatus` | `ThreadStatusType \| null` | thread 活跃状态（idle/active/systemError） |
| `activeTurnId` | `string \| null` | 当前进行中的 turn ID |
| `pendingResolvedRequestIds` | `Set<string>` | 已被 resolved 但尚未 hydrate 的请求 ID |
| `lastActivityAt` | `number` | 运行态最后一次选择/通知/hydrate/审批更新的时间戳，用于 LRU 清理 |

### TimelineEntry 类型

```ts
| { kind: 'user'; content: string; images?: string[]; turnId?: string }
| { kind: 'system'; content: string }
| { kind: 'turn'; turnId; items; completed; diff? }  // diff = turn-level unified diff
```

`user.turnId` 是消息级分支的前提（见 [conversation-branches.md](conversation-branches.md)）。hydration 时直接取所属 turn 的 id；乐观追加的消息此时还没有 turn，由 `setActiveTurnIdForThread` 在 `turn/started` 时通过 `bindPendingUserMessage()` 回填到最新的未绑定 user 条目——与后端 `attachPendingVersionTurn` 对称。没有 turnId 的消息不可分支，而那正好是分支本身无效的窗口。

### TurnItem 类型

```ts
{
  type: 'reasoning' | 'agentMessage' | 'mcpToolCall' | 'commandExecution' | 'fileChange';
  itemId: string;
  content: string;
  completed: boolean;
  toolName?: string;    // mcpToolCall only
  toolServer?: string;  // mcpToolCall only
  toolArgs?: string;    // mcpToolCall only
  filePath?: string;    // fileChange only
  command?: string;     // commandExecution only
  exitCode?: number;    // commandExecution only
}
```

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

### 订阅清理

`general.maxIdleSubscriptions` 默认 30（范围 5-200），由 Settings General tab 配置。`authenticated-layout` 通过 `GET /api/settings?category=general` 读取后写入 timeline-store，并每 5 分钟触发一次清理。

清理只处理 safe idle runtime：非当前选中 thread、`loading=false`、无 `activeTurnId`、无 `pendingResolvedRequestIds` 缓冲、`threadStatus` 不是 `active`、无 pending approval、无 pending user-input。候选按 `lastActivityAt` 排序，超过 15 分钟未活动的 thread 在超过上限时优先被驱逐。

每个被驱逐的 thread 会先从 `subscribedThreadIds` 和 `threadsById` 删除，再 emit `thread.unsubscribe` 让后端 socket room 与 `ActiveThreadRegistryService` ref-count 同步。再次打开该 thread 时走现有 `setActiveThread` + `thread/resume` 恢复路径。

### 历史恢复 (turnsToTimeline)

`switchThread` 调用 `api.resumeThread()` 后，用 `turnsToTimeline()` 将持久化的 turns 转换为 TimelineEntry 数组:

- `userMessage` → `{ kind: 'user', turnId: turn.id }`
- `reasoning` → TurnItem (content = summary.join)
- `agentMessage` → TurnItem (content = text)
- `mcpToolCall` → TurnItem (with toolServer/toolName/toolArgs)

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
