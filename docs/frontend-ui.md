# 前端 UI 与交互实现文档

## 技术栈

React 19 + Vite 8 + Tailwind CSS v4 + Framer Motion + shadcn/ui (Radix Nova preset) + @xyflow/react（分支图，懒加载）/ d3-hierarchy（分支图布局，在入口 chunk 内）

Path alias: `@/` → `src/`

## Liquid Glass 设计系统

文件: `web/src/index.css`

- OKLCH 调色板，蓝色色相 (~250)
- 5 级玻璃海拔系统 (`glass-1` ~ `glass-5`)：`backdrop-filter: blur() saturate()` + 半透明边框 + inset 高光/底缘阴影
- **亮暗两套玻璃 token 方向相反**：暗色下白色微光即是玻璃；亮色下页面本身接近纯白（0.985），白色描边等于隐形、白色淡底等于没有。故亮色的 `--glass-border*` 用低透明度深色，表面白色不透明度也高得多（0.40 ~ 0.80）。改玻璃 token 时两套要分别验证，不能只看暗色
- Sidebar: `bg-card/80`（无 backdrop-filter，避免堆叠伪影）
- Header: `glass-bar`，Popover/登录卡片: `glass-5`，Dialog/AlertDialog: `glass-modal`
- `glass-1` ~ `glass-5` 描述的是**面板**：四边 border + 悬浮阴影。通栏横条没有"侧边"可以描边（侧边框要么压在视口边缘，要么和侧边栏分隔线叠成双线），也不是浮在页面上的，所以单独一个 `glass-bar`：只有底部一条 hairline + `shadow-sm`
- Composer footer 不带玻璃层：玻璃在输入框本体（`glass-3`）上，footer 只负责留白。两层叠加会把输入框框在一块可见的"纸板"里
- 玻璃类定义在 `@layer` 之外，优先级高于 Tailwind utilities。因此 `.glass-*` 的 `box-shadow` 会盖掉 `ring-*`（v4 的 ring 也是 box-shadow）——玻璃表面上的焦点态要用 `outline-*`
- `glass-modal` 与 `glass-5` 只差表面色：亮色主题下模态压在 `bg-black/50` 遮罩上，35% 白玻璃会合成为灰（50% 黑底 + 35% 白 ≈ `#ACACAC`），故亮色下表面提到 92% 白。暗色主题遮罩与玻璃同向变深，沿用 `glass-5` 表面色。**只有带遮罩的面板该用它**——Popover 无遮罩，用 `glass-5` 才正确
- **禁止**在玻璃表面堆叠多个 `backdrop-filter` 或使用 `::before`/`::after` 伪元素（导致渲染闪烁）

## ScrollArea 修复

`[&_[data-slot=scroll-area-viewport]>div]:!block` 覆盖 Radix 的 `display: table` 防止水平溢出。

## 路由 (TanStack Router)

Code-based route tree: `routes/router.tsx`。Auth guard via pathless layout route `beforeLoad`。

| Route | Component | 说明 |
|-------|-----------|------|
| `/login` | LoginRoute | 登录页，`?redirect=` 保留原路径 |
| `/` | ChatView | 空状态（无选中会话） |
| `/t/$threadId` | ThreadView | 会话视图 |
| `/files` | FilesRoute | 全局文件浏览器 |
| `/terminal` | TerminalRoute | 全局终端 |
| `/diagnostics` | DiagnosticsRoute | 诊断日志 |
| `/settings` | SettingsPage | 设置（General/Account/Codex/Terminal/Files/Security） |
| `/integrations` | IntegrationsPage | 集成管理（Plugins/Apps/MCPs），`?tab=` URL search state，含 plugin/app detail sheet |

`AuthenticatedLayout` 包裹所有认证路由：responsive sidebar + header + `<Outlet />`。

## Integrations 页面

- Plugins tab: `Refresh` 只刷新 installable catalog（`plugin/list?forceRefetch=true`）；`Sync installed` 是用户触发的 `plugin/reconcile`，按返回的 `changedPlugins` hints scoped invalidate Plugins / Apps / MCP / Skills 查询。`hasHooks` 暂无前端 inventory consumer，不新增刷新面。`failedRemotePluginIds` 与 `failedMaterializationRemotePluginIds` 分开展示为 warning。
- Apps tab: 列表行保持紧凑，只显示 metadata、install link、enable switch 和 Manage 入口。Defaults sheet 编辑 `apps._default.*` leaf keys；app detail sheet 用 `app/read?includeTools=true` 获取 display-only tool summaries，再编辑 per-app 与 per-tool leaf keys。
- Nullable app config fields 不把 inherited 作为 enum option。控件只列真实值，继承状态由 badge 表示；user-origin 字段显示 `Return to inheritance`，通过 `value:null` 清除当前 leaf override。
- `approvals_reviewer` 是专门的安全控制，提交或清除前都要求二次确认，并说明 approval routing 风险。

### 响应式布局

基础设施: `useBreakpoint` hook (`useSyncExternalStore` + `matchMedia`) → `'mobile' | 'tablet' | 'desktop'`。`layout-store` (Zustand persist) 管理 sidebar open/collapse 状态。

| 断点 | 范围 | Sidebar 行为 | Session Panel | FilesPanel |
|------|------|-------------|---------------|------------|
| Desktop | ≥ 1024px (lg) | inline `w-64`，可手动折叠 | ResizablePanelGroup 垂直分割 | inline `w-56` tree + viewer |
| Tablet | 640–1023px | Sheet overlay（左侧滑出） | Sheet overlay（底部 70dvh） | tree 在 Sheet，viewer 全宽 |
| Mobile | < 640px | Sheet overlay（左侧滑出） | Sheet overlay（底部 70dvh） | tree 在 Sheet，viewer 全宽 |

- 路由变化与进入 desktop 断点时自动关闭 Sheet
- ChatHeader: < lg 显示 hamburger 按钮打开 sidebar Sheet；desktop 折叠时显示 PanelLeftOpen 展开按钮
- ChatHeader: < lg 隐藏 Diagnostics/Language/Theme 按钮，放入 `...` overflow Popover（Settings 保留在 sidebar 导航中）
- sidebar 底部: desktop 显示 PanelLeftClose 折叠按钮（`hidden lg:block`）
- SessionPanel 内 file tree `w-52`: < lg 通过 `hidden lg:flex` 隐藏

## 布局

```
Desktop (≥ lg):
┌──────────────────────────────────────────────────┐
│ Sidebar (w-64)             │ Main Area (flex-1)   │
│ ┌────────────────────────┐ │                      │
│ │ Files/Terminal/         │ │  ChatHeader           │
│ │ Integrations/Settings  │ │  [CodexStatusBanner]  │
│ ├────────────────────────┤ │  <Outlet />           │
│ │ Archive (top)          │ │  ┌────────────────┐   │
│ │ Workspace groups       │ │  │ Session Panel   │   │
│ │   (collapsible, ≤5)    │ │  └────────────────┘   │
│ │ Context menu per thread│ │  ChatInput             │
│ ├────────────────────────┤ │   [Model][Policy][Term] │
│ │ [Collapse sidebar]     │ │                      │
│ └────────────────────────┘ │                      │
└──────────────────────────────────────────────────┘

Mobile/Tablet (< lg):
┌──────────────────────────────┐
│ [☰] ChatHeader [badges] [⋮] │
│ [CodexStatusBanner]          │
│ <Outlet /> (full width)      │
│ ChatInput                    │
└──────────────────────────────┘
  + Sidebar = Sheet (left)
  + Session Panel = Sheet (bottom)
  + File tree = Sheet (left, in /files route)
```

## 虚拟化时间线

`ChatTimeline` 使用 `@tanstack/react-virtual`：
- `useVirtualizer` + `measureElement` 动态高度
- `overscan: 5`，TurnBlock 使用 plain `div`（不用 Framer Motion 避免 recycling 重动画）

### 跟随与「回到最新」：末端锚定负责保持，追加由本项目补一次定位

| 选项 | 作用 |
|---|---|
| `anchorTo: 'end'` | 以末端为保持不变的边。前插历史时保住阅读位置；流式回合在**折叠线以下**长高时不移动视口；本就在末端时，行长高会同步补偿 `scrollTop`——**跟随流式输出靠的就是这一条** |
| `scrollEndThreshold` | 「算作在末端」的容差（`AT_END_THRESHOLD_PX`），与「回到最新」按钮的显隐共用同一个阈值，避免按钮在仍在跟随时出现 |
| `getItemKey` | 稳定行标识，见下 |
| `paddingStart` | 「加载更早」控件的预留空间，**常量**，见下 |

这一段曾经是手写的：一个 `shouldAutoScroll` 布尔量 + 每次 timeline 变化都 `scrollToIndex(last)`（追加时 `smooth`，其余 `auto`）。它**在原理上就不可能正确**——虚拟列表自己也会写 `scrollTop`，组件里的布尔量只能拦住*我们自己*的滚动：

- `scrollToIndex` 留下的 `scrollState` 会在 rAF 里持续重算目标、最长 5 秒（`MAX_RECONCILE_MS`）。流式期间最后一行每帧变高 ⇒ 目标每帧变化 ⇒ 每帧强制回底。
- 行高变化时的补偿。旧版判据是「行起点在折叠线之上」，而一整个回合就是一行，读到中段时下方新增的输出照样触发。

升级到 `virtual-core` 3.17.9 后，**第二条**由上游修掉：重新测量的判据改成「整行都在折叠线之上**且**不在向上滚动」（对应上游 issue #1218）；注意首次测量走的是另一条分支，仍按「行起点在折叠线之上」补偿——估算到实测的差值必须修正，与滚动方向无关。

**第一条上游没有修，而且不是只有我们自己会踩**：`scrollToEnd()` 在 3.17.9 里仍然委托给 `scrollToIndex(count-1, {align:'end'})`，而 `followOnAppend` 的实现正是调 `scrollToEnd()`（`index.js:507`）。也就是说只要开着 `followOnAppend`，**库自己**会在每次追加条目时种下那个追 5 秒的 indexed target——把自己的调用点全改成 `scrollToOffset` 并不能证明「没有东西在追」。

所以 `followOnAppend` **不开**，追加时的定位由 `use-transcript-follow.ts` 用一次 `scrollToOffset` 完成：

- 只在**条目数增长**时写。流式 delta 只是把某一行改长，`anchorTo: 'end'` 的尺寸补偿已经把末端摁住了，不需要额外的写入。
- 判据读的是 `atEndRef` 而不是 `atEnd` state。依赖 state 会让「读者从上方滚回阈值内」这件事本身触发 effect，把剩下那几十像素一把抽走——那是同一个拽人 bug 的小尺度版本，还会跟缓慢上滑打架。
- 必须补这一次的原因：新行以 `estimateSize`（80px）进场，此时距末端正好等于阈值，尺寸补偿只会把这个差值**维持住**而不会消除；不补则下一次追加距离变成 160px、超出阈值，跟随就此彻底断掉。

所有主动滚动都走 `scrollToOffset`——它的 `scrollState.index` 为 `null`，`reconcileScroll` 比对固定的 `lastTargetOffset`，不重算目标，因此既不会追着长高的会话跑，也不会跟已经滚开的读者抢。**不要改回 `scrollToEnd()`，也不要打开 `followOnAppend`。**

已验证的版本组合是 `@tanstack/react-virtual` **3.14.11** / `virtual-core` **3.17.9**；降级会静默退化，同系列其它补丁版未逐一验证。

「回到最新」浮动按钮定位在滚动容器**之外**（`bottom: bottomInset + 12`），所以它的出现不会改变 scroll height。显隐状态由 `use-transcript-follow.ts` 从**实时 DOM 几何**算出，而不是 `virtualizer.isAtEnd()`：React 的 `onScroll` prop 早于虚拟列表注册在同一元素上的监听器执行，此时库缓存的 offset 还是上一次的，用它会让按钮停在错误状态直到下一次滚动。

两个「末端距离」必须同坐标系才能共用一个阈值：库用 `getTotalSize()`，DOM 用 `scrollHeight`。因此滚动容器内**不允许存在虚拟列表没测量的元素**——「加载更早」控件被放进 `paddingStart` 预留的空间里正是为此，否则两者会差出一个控件高度，按钮会在库仍在跟随时就冒出来。

**`paddingStart` 用常量 `HISTORY_HEADER_PX`，且不论控件是否显示都一直预留。** `paddingStart` 会平移每一行的 `start`，但它的变化**不在**库会做位置还原的那类变化里（还原只认条目数与首尾 key 的变化）。所以按实测高度动态设置会让内容在读者眼皮底下跳两次：控件首次测量时跳一次，游标耗尽移除控件时再跳一次。代价是顶部恒定留出一条空白，换来的是这类位移被机制性消除。控件高度因此必须锁死在这个常量内（`whitespace-nowrap` + 固定高度容器）。

按钮**只有一种状态**。issue #18-3 要的是「用户主动上滑后显示查看新消息入口」——这颗按钮本身就是那个入口，只要脱离末端就在。曾经在它上面叠过第二态（判断这期间有没有新输出，有就换文案 + 加圆点），已移除：

- 想判准就必须知道一次 timeline 替换的**来源**。store 的标志位给不出来：`prependHistoryForThread` 在同一次更新里既换掉 timeline 又把 `historyLoading` 清成 false；「有正在运行的 turn」也不行，子 agent 的活动允许在 `turn/completed` 之后才落地。
- 退而求其次的结构性判断（新旧 timeline 末端对齐倒着比引用）能认出前插，但认不出「用户点开一个旧回合、items 被就地补齐」——那和「输出落进那个回合」完全同形，会误报成有新内容。
- 要做到零误报得在 store 里加一个只由实时通知递增的计数器（约十处 mutator）。issue 没有要求区分这两态，为一个装饰性状态引入这条数据通路不划算。

发送/steer **不靠推断**：composer 通过 `onSubmitted` 显式上报「真的派发出去了」的发送（被守卫吞掉的提交、被 slash 命令消费的提交都不报），路由计数后经 `scrollToLatestSignal` 传下来恢复跟随。

打开会话的落位是按导航记下的一次性请求：加载态渲染的是**另一个**没有 scroller 的容器，虚拟列表在没有 scroll element 时会跳过末端相关判断，事后挂上也不会补算，所以要等内容与 scroller 都就位后兑现一次。落位与追加跟随同在一个 `useLayoutEffect` 里，顺序因此是确定的——写在各自的 effect 里，会话切换与它请求的落位之间就会有执行顺序依赖。

**两处不发滚动事件的几何变化必须单独接住**，否则跟随者会被静默甩出阈值、而「回到最新」按钮还不出现：

- composer 长高改变了滚动范围但没有移动 `scrollTop`（`bottomInset` 变化时处理）。
- 视口、分栏或在流式布局中的 composer 会改变**滚动容器自身的高度**，`bottomInset` 完全不变（`ResizeObserver` 只看容器 border-box 高度，内容长高不管——那是虚拟列表的事，在这里响应等于每个 delta 都重新粘底）。

两者都是同一处理：本来在末端就重新粘底，否则只刷新一下报告出来的距离。

### 更早历史：接近顶部自动加载

打开线程只取最近一页 turns，更早的历史需要往前翻。正常打开与 resume 失败后的归档/不可恢复只读降级都遵守这一规则；降级路径不会在服务端聚合全部页面。

这里**曾经**是纯手动按钮，理由是前插会把正在读的内容顶走。末端锚定 + 稳定 `getItemKey` 正是消除这一点的机制（库在数据变化前记住可见条目、变化后按同一 key 找回并修正偏移），所以该理由已不成立，改为滚动到距顶 `PREFETCH_OLDER_PX` 时自动拉取下一页。

判据在 `lib/history-prefetch.ts`，除了「接近顶部」还要求**向上移动**。本客户端所有主动写入——打开落位、回到最新、追加跟随、前插后的锚点还原——都只会让 offset 变大或不变；缺了方向判断，一个能滚但很短的会话会在每一次这类写入上都拉一页，「回到最新」也会顺手把没人要的历史翻出来。

控件保留，承担两件事：会话内容不足一屏、滚不动因而永远触发不了自动加载时的入口；以及加载中状态的显示。`useLoadOlderHistory` 同步读 store 并在 `await` 之前就占住 `historyLoading`，所以一次滚动爆发产生的多次调用会塌缩成一个请求。

`historyCursor` 为 null 时控件不渲染（历史已完整），但预留空间仍在——见上文 `paddingStart` 为何是常量。

行标识必须稳定，否则前插会让缓存行高与末端锚点落到错误的条目上：`getItemKey` 用 `kind + turnId + 组内序号`。序号是必要的——用户消息在 `turn/started` 之前没有 turnId，多条系统消息可以共享一个 turnId。前插不会打乱序号，因为前插进来的都是已持久化的 turn，永远不会落进「尚无 turnId 的实时条目」那一组。

`getItemKey` 这个函数本身也必须稳定：它是虚拟列表测量选项的一部分，每次渲染换一个新函数会重建全部测量——流式期间就是每个 delta 一次。key 数组因此先算成一个 join 后的签名再拆回来，序列没变时数组保持同一引用。**不能**改成读 ref 的可变函数：库靠比较 `prevOptions.getItemKey` 与新的 `getItemKey` 来判断首尾条目是否变了，共用一个可变函数会让这个判断永远返回「没变」。

### 空回合不撑气泡：显示判据

`item/started` 会在任何 delta 到达之前就插入一个 `content: ''` 的 agent 消息。外壳若只看「有没有 item」，就会围着一个什么都不渲染的 renderer 画出头像 + 玻璃气泡——这就是用户报的那条白条。

`lib/turn-item-display.ts` 给出纯函数判据，**外壳的空判定与实际渲染的列表共用同一套**，两者不会再各说各话：

- 只有 `reasoning`（镜像其 `!item.content` 的 null 返回）和 `agentMessage`（正文非空白 **或** 有 questions）是有条件的
- 其余项从创建那刻起就可见：运行中的命令有命令行与运行指示、在途工具调用有名字与参数、输出卡片会明说「输出为空」
- 判据对**内部** item union 穷尽：往这个 union 加成员是**编译错误**，而不是日后某个空白气泡。协议侧的未知类型不走这条穷尽——normalizer 先把它们折成 `unknownActivity`，渲染成明确的「不支持的活动」标记
- 正在跑但暂无可见内容的回合显示已有的 `Thinking...` 占位（该分支此前因为被更早的 `return null` 挡住而实际不可达）；已完成且无可见内容的回合不渲染任何表面
- 挂着审批卡/用户输入卡的 item **不会**被滤掉——卡片渲染在 item 体旁边，滤掉会把可交互的审批一并带走
- 回合级的 plan 与 diff 同样按渲染器的真实条件判断（`PlanPanel` 要求 explanation/steps/文本三者之一，diff 要求非空串），而不是判断字段是否存在

### 删除进行中的反馈

删除是一次可能较慢的级联（要中断活跃轮、逐个 `thread/delete`），所以「已确认」到「已完成」之间必须有反馈，且**在服务端确认之前什么都不该动**。三层：

1. **确认框留在原地**。`AlertDialogAction` 是 Radix Action，**默认点击即关闭**；原实现的 `onClick` 没有 `preventDefault`，于是按钮里写好的 spinner 永远不会显示，`onOpenChange` 的 `!pending` 守卫也无事可守。改为 `preventDefault`，由 mutation settle 关闭。
2. **切换器进入 pending**：垃圾桶原地换成 spinner，左右切换一并禁用 —— 否则能切进正在销毁的那个版本。待删集合直接取自 mutation 的 `variables`，不另行跟踪，保证与实际发出的请求不会不一致。计数**不做乐观扣减**：版本在服务端说没之前就是还在，点一下就减一等于断言一个还可能失败的结果。
3. **导航发生在成功之后**，且判据是服务端**实际删除**的集合而非计划删除的集合 —— conflict 一个都没删、partial 只删了一部分，两种情况下提前把用户挪走都是在谎报结果。

> 早期版本在 `onMutate` 里就导航，理由是「留在正被销毁的会话里会产生后端会拒绝的请求」。该理由的前提是确认框点完即关；改成留在原地后用户根本无法操作，前提消失，而提前导航的代价是删除失败时用户已经被挪到了别处。

**防重复提交靠 ref，不靠 `disabled`，也不靠重读 `canConfirm`。** 三者里只有 ref 是同步生效的：`disabled` 要等 React 绘制；而在 handler 里重新读一遍 `canConfirm` 看似是补救，实际读到的是同一个由 props 算出的闭包值 —— 同帧内的第二次点击之前父组件根本没重渲染，`pending` 还没翻成 `true`，于是两次都判定为可提交。曾按后者修过一版，`delete-conversation-dialog.spec.tsx` 的同帧双击用例把它证伪了。现在是 `submittingRef` 闩锁，`pending` 落回 `false` 时释放。释放不是可选的：三个调用点都把这个对话框常驻挂载、只切 `open`，闩锁因此跨开关周期存活，不释放的话本次会话内**后续每一次**删除的按钮都是死的。（顺带澄清一处易误解：`onFinished` 在 `onSuccess` 与 `onError` 里都会调用，三个调用点都用它关框，所以失败时对话框同样是关掉的，不存在「留在原地重试」。）

### 只读横幅

`readOnlyReason !== null` 时在时间线上方渲染横幅，同时禁用输入框与编辑消息（建分支）按钮。这与归档只读是两回事：归档的补救是取消归档或 fork，写锁被占的补救是去另一端关闭，所以输入区提示文案按两种情形分开，否则会和横幅自相矛盾。

## 可折叠工具调用

连续 2+ 个 `mcpToolCall` 项自动归组为可折叠容器，减少聊天区视觉噪音。

- **分组逻辑** (`turn-block.tsx` `groupConsecutiveToolCalls`)：遍历 `TurnItem[]`，将连续的 `mcpToolCall` 归为 `toolGroup`，其余为 `single`。分组在每次渲染时计算（O(n)，n 通常很小）。
- **ToolCallGroup** (`turn-items/tool-call-group.tsx`)：折叠容器，header 显示 "🔧 N 个工具调用" + 完成/加载状态。执行中默认展开，全部完成后自动折叠（`useEffect` 监听 `allCompleted` 转换）。`aria-expanded` 支持无障碍。
- **ToolCallItem** (`turn-items/tool-call-item.tsx`)：单个工具调用也可折叠。有 body（args/progress/result）时渲染为 `<button>` + `aria-expanded`；无 body 时渲染为 `<div>`（不可交互）。同样在完成后自动折叠。
- 单个 `mcpToolCall` 不被包裹在 group 中，直接渲染为 `ToolCallItem`。
- `commandExecution` 和 `fileChange` 不参与分组（有审批卡片、用户更关注执行细节）。

## Protocol item 与失败渲染

- `TurnBlock` 对内部 `TurnItem` union 做穷尽 switch，无 default fallback；未来 raw variant 的 fallback 已在 normalizer 中变成 `unknownActivity`，所以 UI 只显示协议类型与 started/completed，不序列化未知 payload。
- hook prompt、function output、dynamic tool、collaboration tool 各自使用内容卡；sub-agent、image view、sleep 是轻量 lifecycle marker；web search 显示 query/action/result count 与少量已理解 preview；image generation 只预览 http(s) 或 image data URL，并显示 prompt/status/saved path/failure。
- function output 的 encrypted content 只显示“不可预览”，ciphertext 不进入内部 timeline model。image path 仅作文本显示，不生成本地文件链接。
- `TurnFailureCard` 属于 turn 级别而不是 item。message-only 旧记录显示普通失败卡；仅当 type/explanation 至少一个存在时才出现 misalignment 区块。它没有确认、continue 或 steer 控件。

## Diff 视图

`@git-diff-view/react` + `@git-diff-view/shiki` 提供 GitHub 风格 diff 渲染：

- **GitDiffPanel** (`turn-items/git-diff-panel.tsx`)：封装 DiffView，集中处理 Shiki 懒加载（模块级单例）、theme（从 `useThemeStore` 读取）、Unified/Split 切换、parse 失败 raw fallback（DiffRenderBoundary error boundary）。
- **file-change-item**：completed 时展开区域用 GitDiffPanel（`showToolbar=false`，因卡片 header 已有文件名）；流式阶段保留 `<pre>` 原始渲染。
- **user-input-card** (`turn-items/user-input-card.tsx`)：渲染 `item/tool/requestUserInput`（EXPERIMENTAL）。支持 radio（单选）/ checkbox（isOther+多选）/ text / password。提交通过 `pendingApprovalsRespond` REST。蓝色边框(pending) / 灰色(resolved)。
- **diff-viewer** (turn-level)：按 `diff --git` 分段拆分聚合 diff，每个文件渲染一个 GitDiffPanel（竖排列表，非 tab）。
- **diff-utils.ts**：`ensureDiffHeaders` 为 Codex 裸 hunk（无 `---`/`+++` 头）补充文件头；`stripGitPathPrefix` 去除 `a/`/`b/` 前缀。

## Rich Chat Input

ChatInput 拆分为三个文件：`chat-input.tsx`（编排）、`use-chat-attachments.ts`（附件）、`use-chat-mention.ts`（@ 检测）。

### @ 文件引用
- ` @`（空格+@ 或行首@）触发 `MentionPopover`，在 thread cwd 下搜索文件
- 路径导航：`/` 进入子目录，可点击 breadcrumb 返回上级，📎 按钮 mention 目录
- 选中后 `@relative/path` 内联在 textarea 原位（空格转义为 `\ `）
- 发送时 `buildInput` 将 `@relative` 替换为 `@absolute`，按 displayName 长度降序防误匹配
- 后端 `validateInlineTextMentions` 解析 text 中绝对路径并校验 workspace 安全
- `useChatMention` hook 负责 query + filtering（TanStack Query + useMemo），keyboard handler 直接读 `mentionFiltered` 数组
- `MentionPopover` 是纯展示组件，接收 `filtered`/`isLoading`/`browseRelative` props，无内部状态依赖

### 粘贴与上传
- 粘贴图片：上传 `POST /api/chat/upload` → `localImage` input item + chip 缩略图
- 粘贴文件：上传 → 光标处插入 `@filename`（同 @ mention 流程）
- FileTree 右键 "Attach to chat"：通过 `codex-webui:attach-file` custom event 通知 ChatInput
- 上传用直接 fetch（SDK body serializer 强制 JSON，multipart 不兼容）

### Skill 选择器
- ChatInput 底栏 `SkillSelector` 按钮 → Popover 搜索选择
- 选中后 `skill` input item + chip
- Settings2 图标切换 manage mode：展示全部 skills + inline Switch enable/disable（`skills/config/write`）

### 用户消息气泡
- `UserMessageBubble`：使用 `react-markdown` + `remark-gfm` + 自定义 `remark-mentions` 插件渲染 markdown + 可点击 @mention
- `remark-mentions`（`lib/remark-mentions.ts`）：remark AST 插件，将 `@path` 文本转为 `mention:` scheme 的 link 节点。跳过 code/inlineCode/link 节点避免误匹配
- `userUrlTransform`：放行 `mention:` scheme（react-markdown 默认 sanitizer 会过滤非标准协议），其他 URL 仍走 `defaultUrlTransform`
- 气泡是中性色（`bg-muted` + `border-border/60`），不用强调色：用户自己写的消息是最不需要被吸引注意的内容，而一块高饱和色是整套中性色板里唯一的高彩度面，左右对齐已经足够表明发送方
- `userComponents`：样式覆盖一律用 `foreground` / `border` 表达（`bg-foreground/10` 等），不写死白色或黑色——气泡底色随主题反转，写死白色只在它还是蓝色实色块时成立
- mention link → 渲染为可点击 inline badge（FileText 图标 + 半透明背景 + hover 高亮）
- 点击 @mention badge → dispatch `codex-webui:open-file` 自定义事件 → `ThreadView` 打开 session panel + 对应文件 tab
- 图片附件也渲染为可点击 badge（ImageIcon 图标 + 文件名），点击同样打开 session panel 预览
- 路径解析：`normalizeMessageMentions` 将绝对路径转回相对路径显示；mention 插件中相对路径用 `threadCwd` 重建绝对路径
- 气泡容器加 `overflow-hidden` 防止长内容溢出圆角边界

### ChatInput 布局

从 overlay 模型（按钮 `absolute` 叠加在 textarea 底部）改为 stacked 模型：
- 单一玻璃面板（`glass-3` + `rounded-2xl`）内依次是附件 chips、textarea、按钮行——三者共用一个表面，不再靠 `border-t-0`/`border-b-0` 拼接两个盒子
- 焦点态用 `focus-within:outline-2`，不能用 ring（见玻璃层级说明）

#### 浮层定位

`thread-view` 用 `relative` 包裹时间线 + composer，composer 为 `absolute inset-x-0 bottom-0`。它**必须**浮在时间线上方，否则：玻璃背后是纯背景色，透不出任何内容；且时间线在 composer 上沿被硬切，滚动中的头像/气泡会被一条实色边裁断。

时间线需要为浮层预留末端空间，由 `ChatTimeline` 的 `bottomInset` 传入 virtualizer 的 `paddingEnd` + `scrollPaddingEnd`（前者让最后一条能滚过 composer，后者让自动滚动停在 composer 之上；只给其一都不对）。空态容器用 `paddingBottom` 等效处理。

composer 高度随 textarea、附件 chips、goal 行、只读横幅变化，无法静态推算，由 `ChatInput` 内 `ResizeObserver` 测 `offsetHeight`（含 padding 带，那也是遮挡区）上报给路由。

例外：桌面端 session 面板打开时 composer 回到流式布局（`shrink-0`，`bottomInset=0`）——此时浮层会压在终端/文件面板底部而不是对话上。
- Textarea 无边框透明，`max-h-40 overflow-y-auto` 长文本滚动
- 按钮行在 textarea 下方，永远不会被文本遮挡
- `min-h-20` 默认较高输入区

## Markdown 渲染

`react-markdown` + `remark-gfm` + Shiki 语法高亮（懒加载，缓存）。agent 消息使用 `MarkdownRenderer` 组件，用户消息使用 `UserMessageBubble` 内的独立 Markdown 实例（含 remark-mentions 插件）。

**代码块不跟随主题。** 容器底色写死 `#0d1117`，Shiki 以 `defaultColor: 'dark'` 输出内联色，且项目没有任何激活 `--shiki-light` 的 CSS —— 所以浅色主题下高亮内容仍是深色配色。据此，块内元素（语言标签、复制按钮、无高亮时的 `<pre>`、分隔线）必须用固定浅色而非 `text-muted-foreground` 等语义 token，否则浅色主题下它们会变成深灰贴在深色底上，几乎不可见。

### 生产构建注意

Vite `cssTarget: ['chrome100', 'safari16', 'firefox100']`：防止 CSS minifier 将 `backdrop-filter` 剥离为仅 `-webkit-backdrop-filter`（后者在部分浏览器无法正确解析 `blur() saturate()` 组合值，导致玻璃态效果丢失）。

## 模型选择器

ChatInput 内两个同级 popover，共用 `use-active-model` 解析「下一轮实际使用的模型」，避免两处各自推导后给出该模型并未声明的选项：

- 左侧 `ModelSelector`：选模型 + 推理强度。
- 右侧（token 用量环左边）`ServiceTierSelector`：选速度档位。模型未声明任何 tier 时整个控件不渲染 —— 常驻一个不可选的控件会让人以为速度可调。

三者的 session-level overrides 都存 `model-store`，随 `turn/start` 发出。

选项行统一用 `option-row.tsx`，带 `default` 角标和第二行说明。**说明文案来自 app-server 目录，且只有英文** —— `model/list` 没有 locale 参数，`initialize` 也没有语言能力位。文案统一过 `lib/catalog-copy.ts` 的 `catalogCopy()`：本项目 i18n 以英文自然语言串为 key，因此已收录的串会被翻译，未收录的原样落回英文，无需另建一套按 id 索引的字典。由于 key 就是英文原文，上游改文案时只会 miss 并回落到新英文，不会把旧译文错配到新内容。

`catalogCopy()` 不能简化成裸 `t(value)`：**i18next 即使 key 缺失也会解析 `$t(...)` 嵌套**（实测 `"Has $t(Model) nesting"` 会被改写成 `"Has Model nesting"`），把任意上游散文喂给 `t()` 会静默篡改文案。因此它先 `i18n.exists()` 再取值。`catalog-copy.spec.ts` 锁住这个行为。

推理强度与速度档位都是**逐模型 advertise** 的（`supportedReasoningEfforts` / `serviceTiers`），必须按目录顺序原样渲染，不要自行推导或排序；切换模型时两个 override 一并重置，否则可能选中新模型根本没有的档位。`DEFAULT_EFFORTS` 仅在识别不出当前模型时兜底，且刻意不带说明文案。

## 分支图

`@xyflow/react` + `d3-hierarchy`，详见 [conversation-branches.md](conversation-branches.md#branch-graph)。UI 层需要知道的两点：

- 两个渲染面（可平移缩放的浏览图 / 确认框内的静态缩略图）共用同一套布局与节点组件，但**不是同一个组件加 mode 开关** —— 视口行为差异太大。
- 浏览图的节点带删除按钮（hover 显现），点节点本身仍是打开。删除按钮 `stopPropagation`，否则一次点击会同时触发打开与删除。**每个节点都可删**：图上的节点是拓扑对象（删它 = 删该子树，根节点 = 删整棵），切换器那条「组内 original 不可删」是**版本组作用域**的规则，不适用于此。图只是入口，级联始终由服务端重新规划并走既有确认框，绝不从图上画出的拓扑推导。
- 只有 React Flow 是 `lazy` 引入（独立 chunk 约 179 kB），其样式表不进入入口 chunk；`d3-hierarchy` 在入口 chunk 内，因为删除确认框的权威缩进列表复用同一套布局，必须同步渲染。

## 主题

`theme-store` (Zustand persist) → `localStorage` 持久化，`onRehydrateStorage` 回调应用。支持旧格式 `"dark"`/`"light"` 纯字符串自动迁移。Header toggle + Settings 页 + mobile overflow popover 共享。

**第三方组件不一定跟随 `<html>.dark`。** React Flow 把暗色变量作用域限定在它自己的根元素（`.react-flow.dark`），祖先上的 `.dark` 够不着，必须显式把主题传进去（`colorMode`）。引入任何自带主题的库时都应先确认这一点，否则暗色下会出现亮色控件。

## 全局 Snackbar

`showSnackbar(msg, severity?)` 任意位置可调。API 错误自动弹出（跳过 401/AbortError/silent）。

## 复制到剪贴板

一律走 `lib/clipboard.ts` 的 `copyTextToClipboard()`，不要直接调 `navigator.clipboard`。

**Clipboard API 只在安全上下文可用**（HTTPS 或 localhost）。本项目常见的部署形态是 Docker + 局域网 HTTP 直连，此时 `navigator.clipboard` 为 `undefined`，直接调用必然失败。helper 在此回退到隐藏 `<textarea>` + `document.execCommand('copy')`，并在复制未成功时抛错（调用方各自弹 snackbar，不静默）。回退时会先记下当前焦点元素与选区的 anchor/focus 端点，复制后原样交还——不还的话焦点会掉到 `<body>`，而"复制失败请再点一次"恰恰要求键盘用户还能回到那个按钮；用 anchor/focus 而非单个 range 是为了不把反向选区翻成正向。

**降级路径依赖点击授权，因此有调用时机约束。** 浏览器只在发起点击的 user activation 仍然有效时才执行 `execCommand('copy')`（Chrome 有约 5 秒的时效窗口，Safari 要求同一调用栈）。helper 把「API 不可用」这条回退路径整个放在自身第一个 `await` 之前，以留在调用方的调用栈内；但**调用方若先 `await` 一个网络请求再复制，这份授权可能已经耗尽**。

注意两点不要误读：安全上下文只保证 API **可用**，不等于**无条件许可**——Safari 与 Firefox 对 Clipboard API 写入同样要求 activation；以及 `writeText()` 被拒后的那次回退**必然**发生在 await 之后，只能算尽力而为。

因此约定：调用前把待复制内容准备好。做不到时参考两处既有形态：

- **`DiagnosticsPanel`**：导出包要读轮转日志并 spawn `codex --version`，耗时不可控。复制失败时**保留已取到的包**，第二次点击直接在点击自身的调用栈里复制。保留态在按钮文案上显式可见（「复制已就绪的导出」），Refresh 会连同屏上日志一起丢弃它——否则用户会拿到与当前视图不符的旧快照。

  两个并发点击的结果可能乱序落地：后发的复制成功并清空，先发的随后失败又把更旧的包写回。因此整个 handler 期间复制按钮不可再按，**Refresh 同样锁定**——Refresh 清不掉一个尚未被写回的包，只会被随后失败的那次复制复活。

  这里用 `aria-disabled` 而非原生 `disabled`：**原生 disabled 的按钮无法持有焦点**，一旦在点击后被禁用，焦点就掉到 `<body>`，helper 事后"交还焦点"只会把焦点交还给 body——恰好在提示用户"请再点一次"的时刻让键盘用户够不着那个按钮。按下的拦截改由 handler 自己守卫。

- **`McpsTab`**：弹窗被拦截时**不复制**，直接把授权 URL 留在界面上给出「打开授权页」链接——用户亲自点击的导航根本不需要剪贴板，旁边的「复制链接」按钮才走 helper，且由用户点击直接触发。原先在此自动复制，一旦失败 URL 就丢了，再点 Login 只会重复同一次失败。

  该 URL 必须在**服务端报告已登录**时释放：行组件按 server name 复用、生命周期长于任何一次登录尝试，不释放的话下一次登出会让这条陈旧链接重新出现，指向一个没人发起过的授权流程。复制或打开链接都不构成登录完成的证据，不能据此清除。

## i18n

react-i18next，自然语言 key（英语默认），zh-CN 翻译。语言切换：header + Settings 页。

## Sidebar

- Router-driven：`useNavigate()` 导航，`useRouterState()` 判断 active
- 双视图：Overview（archived 置顶 + workspace 分组，可折叠动画）↔ Detail（单 workspace 分页）
- Thread context menu：Rename / Archive / Unarchive / Compact / Fork
- DirectoryPickerDialog：选择工作区目录创建会话
- **Per-thread 状态图标**（优先级 high→low）：
  - `waitingOnApproval`：黄色 ShieldAlert + `animate-pulse`
  - `waitingOnUserInput`：蓝色 MessageCircleQuestion + `animate-pulse`
  - generating（active 无 blocking flags）：Loader2 + `animate-spin`
  - idle：灰色 MessageSquare
- **Approval count badge**：hydrated pending approvals > 1 时显示数字（9+ 封顶），半透明黄色圆角背景
