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
- **重开不丢分页**：若返回页的 turn 全部已在本地时间线中，则保留更早的行与 `historyCursor`，但仍合并已知 turn 的新内容及完成状态 —— 否则离开再回来会把已加载的更早历史悄悄丢掉。
- **打开不覆盖实时状态**（`lib/timeline-reconcile.ts`）：订阅与 open 请求并发，刷新时通知可能先于响应写入时间线；旧实现整体替换会把它们抹掉，正是「刷新后运行中轮次一片空白」的第二个成因。现在按 **turn 分组**对账：一个 turn 会贡献多行（user 行、turn 行、failure 行），先按 turn 分组、组内按 kind 对账、每组整体落位一次；组内按 user → turn → failure 排列（这是页面结构顺序，不是重叠 item 的时间顺序）。锚定粒度与取值粒度必须一致——早先按 turnId 锚定却按 `kind:turnId` 取值，页面独有的行会被当成「该 turn 已表示」而整行丢失（刷新时用户自己的消息会消失），且尾随组会在锚点 turn 的**每一行**后重复发出（整个 turn 被复制并错位）。两侧共有的 turn 合并（item 按下述权威规则、`completed` 只前进、更细的 `itemsView` 胜出），仅一侧有的按最近共有锚点插入。**仅当两侧存在共有 turn 时才合并**；毫无重叠说明是两个断开的历史窗口，仍以服务端整体替换并采用其游标，避免把缺口悄悄缝合掉。
- **活跃 turn 指针不由页面独断**：返回页没有 inProgress turn 不等于没有——它可能在请求期间才开始。只有当该页确实覆盖了本地已知的活跃 turn 并报告其已结束时才清空指针。
- **迟到响应保护**：成功与失败回调都先检查运行时是否仍存在。store 的 setter 是 create-if-absent 的，删除进行中若有 in-flight 响应落地，不加保护会把已删会话的外壳重新建出来。
- **后台恢复不写指针**：刷新/重连恢复会遍历所有已加载线程，若允许它们写活跃分支指针，每棵树会指向恢复顺序中的最后一个成员，正是该指针要解决的问题。这两条路径显式传 `recordActive: false`。
- **fork 也只导航**：钉住的 0.153.2 fork 响应刻意请求 metadata-only。侧边栏不再从响应里的 `thread.turns` 或并行 auxiliary reads 自行 hydration；后端提交 provenance 后才返回，随后路由的 canonical opener 统一分页历史并读取继承后的 token usage / turn diff / turn error。
- **降级只读同样分页**：正常 resume 失败后，路由并行读取 metadata 与最近 20 个 summary turns，两者都成功且路由仍指向目标 thread 时才应用；更早历史沿用同一个 `historyCursor` 与显式“加载更早的消息”入口。已有 live runtime 会被显式切换为 `readOnly`，避免只读快照仍保留可写模式。

Approval 与 user-input request 会为自己的 `turnId` 保留空 turn entry，即使最近一页历史没有该 turn。`writeStdin` 回调的 item 可属于更早的 turn，因此卡片按回调 turn 渲染为 unattached request，而不是倒挂回原 command 或改变其 lifecycle。

### Item 权威与恢复合并 (`lib/turn-item-merge.ts`)

三件事被显式拆开：**item 生命周期**（片段 / 终态）、**turn 生命周期**、**历史覆盖范围**。拆开的依据是对钉住 app-server 的实测：

- 持久化发生在 **item 完成**时而非 turn 完成时，所以运行中的轮次确实能取到它已完成的 item——这正是运行中轮次可恢复的前提。
- 终态载荷携带的是**完整累积结果**（`aggregatedOutput` 等）而非增量尾巴，因此修复片段是**整体替换**，把快照拼接到已收到的 delta 上会重复内容。
- **持久顺序是完成顺序，实时顺序是开始顺序**。两个 item 在时间上重叠时两个列表给出不同排列，且无字段可对齐（item 无时间戳与序号，只有 turn 有）。因此实时顺序对它已见过的 item 具有权威性，持久邻接只用于放置实时从未见过的 item。重叠 item 的真实先后不可恢复，不伪造时间戳、不对不透明 id 排序来掩盖。

`completed` 的含义收紧为「已观测到权威终态载荷」，`observedSeq` 记录实时写入时的观测计数（模块级单调计数器，不进 runtime，否则会被 store 的 selected-thread 投影丢掉）。恢复请求发出前捕获 baseline，据此判定冲突时哪一侧更新。

配套的实时通知修正（不改这些，恢复一开就会被破坏）：迟到的 delta 不再重开终态 item、迟到的 `item/started` 不再用空壳覆盖终态 item、重复的 `turn/started` 不再清空 item 数组；plan 文本采用独立的按 item 存储——plan 的终态载荷此前被 `item/completed` 直接丢弃，且持久快照按整个 turn 判断「已有 plan 就跳过」，两者合起来使被断线截断的 plan 永远无法修复。现在 plan 文本**按 item id** 存储与替换，初始 hydration 与后续修复使用同一表示，结构化步骤更新保留它；即使没有收到开始事件也接受终态 plan。plan 尚未保存 item 终态/观测序号，因此迟到 delta 和过期快照的权威判定仍待补齐。

### 运行中轮次与重连恢复 (`lib/thread-recovery.ts`)

open 与重连共用 item 修复入口；重连另读 turn 头。请求前捕获观测基线与 recovery epoch，应用前重新校验（会话可能已删除/驱逐/被更新的恢复取代）。**in-flight 去重的 key 必须含 epoch**：否则被 supersede 的旧 promise 仍占着位置，替补恢复会复用它并在 epoch 校验处被丢弃，结果是一次修复都不会发生。

重连恢复的**另一半是 turn 生命周期**，不是只有 item。item 与 lifecycle 由不同通知承载：断线期间完成的 turn 把它的 `turn/completed` 发进了空处，只补 item 会让转录正确而 composer 永远转圈。因此重连会以 `itemsView: notLoaded` 重读最近的 turn 头（不带 item，与 item 合并互不干扰）并据此收敛 `completed` / `activeTurnId` / `loading`：只前进、只对**头里确实出现**的 turn 下结论（读取有界，更早的 turn 只是超出范围），并接管断线期间新开的运行中 turn 指针；已经终态的本地 turn 不被迟到的 running 头重新激活。新发现 turn 的内容与遗漏审批尚未接入这条恢复路径。两者并行发出，让生命周期不必等最慢的转录分页。分页只认 `complete` 字段——`nextCursor` 为空也可能意味着分页不可用或响应损坏，把它当作「就这些了」会让被截断的转录看起来权威。失败的读取不恢复任何东西，也不声称完整。

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

## model-store

文件: `web/src/stores/model-store.ts`

Session 级的模型 / 推理强度 / 速度档位 override，随每次 `turn/start` 发出。

| 字段 | 语义 |
|------|------|
| `modelOverride` | `string \| null`，null = 用服务端默认 |
| `effortOverride` | `ReasoningEffort \| null`，null = 用模型默认。**仅用户操作可写** —— 把观测值回写这里会把该强度强加到下一个发送的 thread 上 |
| `observedEffortByThread` | 按 thread 记录 app-server 报告的强度，**仅供展示**。Plan mode 会在服务端改写 thread 强度，badge 要能显示但不能把它变成 override |
| `observedServiceTierByThread` | 同上，按 thread 记录 app-server 报告的速度档位，仅供展示 |
| `serviceTierOverride` | `string \| null \| undefined` —— **三态** |

`serviceTierOverride` 与上面两个不同，必须是三态：`undefined` = 用户没碰过选择器，字段缺省，thread 保持原档位；`null` = 用户显式选了标准速度，必须发出去才能清掉已有档位；字符串 = 模型 advertise 的 tier id。折叠掉 `null` 会让「切回标准」无法表达；反过来永远发送则会把没开过选择器的用户的配置档位强行清空。

推理强度与速度档位都是逐模型 advertise 的，切换模型时两者一并重置（`setServiceTierOverride(undefined)`），否则可能残留新模型没有的档位。

两张观测表由两条路径写入：`thread/settings/updated` 通知，以及 `applyOpenResponse` 中的开线程水合。**光靠通知不够** —— 它只在设置发生变化时才发，所以重新打开或刷新后的线程会退回目录默认值：速度选择器会对一个实际跑在付费档的线程显示「标准」，而 composer 因为 override 是 `undefined` 又不发 `serviceTier`，该档位继续生效。用户会以为自己在标准速度和标准计费上。`forgetObservedThreadEffort` 同时清两张表，且早退条件必须同时检查两者 —— 只看 effort 会漏掉只有 tier 记录的线程。

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

完整及部分 top-up 的共享 Query 缓存都不携带请求发出时的观测基线，因此采用保守的未知基线：保留已有终态载荷，仍用持久终态修复片段；不能在响应应用时补打时间序号。
