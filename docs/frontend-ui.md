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
- Composer footer 不带玻璃层，只负责留白。两层叠加会把输入框框在一块可见的"纸板"里
- **输入框本体不是玻璃，是实心面**（见「ChatInput 布局」）。玻璃只用在**不需要遮挡正文**的表面上：侧边栏、顶栏、Popover、Dialog 等。侧边栏是主列的兄弟节点，Dialog/Popover portal 到 body；顶栏和转录内的活动面即使位于主列，也不把采样主列正文作为遮挡保证。主列内需要遮挡正文的表面一律用实心
- **`isolation: isolate` 会形成 backdrop root**：其内部任何 `backdrop-filter` 都采样不到同组内容，滤镜等于失效。外壳主列（`authenticated-layout.tsx`）带 `isolate`，用来保证主列内任何 z-index 都压不过侧边栏（实测：去掉后主列内的正值 z-index 会盖住侧边栏）。代价是主列内的玻璃面拿不到 backdrop。实测 `position` + `z-index` 形成的普通层叠上下文**同样**会触发，换一种写法救不回来。故主列内需要遮挡的表面一律用实心
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

| 断点 | 范围 | Sidebar 行为 | 会话工作区 | FilesPanel |
|------|------|-------------|------------|------------|
| Desktop | ≥ 1024px | 原有 inline sidebar | 固定 Conversation + 单行溢出 tabs；右侧可调宽树栏 | 原有 tree + viewer |
| Tablet / Mobile | < 1024px | 原有左侧 Sheet | Conversation 常驻操作 + view chooser；Explorer 从右侧 Sheet 打开 | tree Sheet + 全宽 viewer |

断点只切换导航控件和文件树呈现，同一个内容树保持身份。会话 tab 不可关闭；待审批与运行标记不抢占当前文件/终端的焦点。详见 [workspace-tabs.md](workspace-tabs.md)。

### 视口高度：`--app-vh` 而非视口单位

`lib/mobile-viewport.ts` 在启动时把 `visualViewport.height` 镜像到 `--app-vh`，**所有全高界面都从这个变量取高度**，不再用 `100dvh` / `100vh` / `h-screen`：`#root`、登录页、三个 integrations sheet 的 ScrollArea、移动端会话抽屉。`100dvh` 是首次同步前和无 visual viewport 时的 fallback。

视口单位不够用的两种情形：

- **iOS 软键盘**。Safari 不实现 `interactive-widget`，键盘弹出既不缩小布局视口也不改变 `dvh`，输入框被压在键盘下面。只有 `visualViewport.height` 反映真实可见区域。（`index.html` 的 `interactive-widget=resizes-content` 只对实现了它的浏览器生效，主要是 Chrome。）
- **覆盖式浏览器栏**。部分内嵌浏览器在页面上方绘制底部工具栏且不减少任何视口测量值，尺寸无从测得，只能按 UA 盲留 —— `html.qq-browser` 保留 `--qq-bottom-gap`（56px），限制在 `<1024px`，桌面版共用 UA 但没有该工具栏。

同步有两个约束，缺一个都会出问题：

- **缩放时不同步**。双指放大会在不缩小布局的前提下缩小 visual viewport，并把它滚离文档原点。此时按它设置外壳高度会让整个应用塌进放大区域；而 visual viewport 在缩放态下还会持续发 `scroll`，于是每次平移都塌一次。`scale !== 1` 时保持上一次读数即可，`offsetTop` 同理不需要单独处理 —— 它只在缩放或键盘过渡期非 0。
- **值没变就不写**。`scroll` 的触发频率远高于高度变化，写入相同值仍然会脏化样式。

### 悬停显形控件：`hover-reveal`

Tailwind v4 的 `hover:` / `group-hover:` 变体**本身就编译在 `@media (hover: hover)` 里**，所以旁边一个裸 `opacity-0` 在触屏上永远不会被抬起来 —— 控件不可见却仍可点中，成了隐形热区。`index.css` 的 `@utility hover-reveal` 表达完整意图：默认可见，仅在 `(hover: hover) and (pointer: fine)` 下隐藏。

配 `group-hover*:opacity-100` 与 `focus-visible:opacity-100` 使用，两者特异性 0,2,0 均高于 `hover-reveal` 的 0,1,0，不依赖源码顺序。用在 8 处：代码块复制、附件移除、@ 引用附加、文件页签关闭、终端页签关闭、会话行菜单、消息版本操作行、分支节点删除。

> 不要改回在 `index.css` 里裸写全局 class：未分层规则在级联里压过整个 `@layer utilities`，之后任何 `opacity-*` 工具类作用在同一元素上都会被静默吃掉。`@utility` 才会落进 utilities 层。

## 布局

会话中心列为紧凑标题、固定高度的不换行 tabs、全尺寸活动内容。Conversation、每个文件、每个终端互为平级。右侧全高 Explorer 可折叠，拖动时只预览分隔线，释放后一次提交宽度。左侧全局导航保持原样。

`thread-view.tsx` 只按 conversation identity 重建工作区。Conversation frame 的树位置不随 tab、断点或 explorer 改变；inactive 表面使用 `visibility` 和 `inert`，仍保留布局盒。终端实例由 authenticated layout 的 `TerminalHost` 保留，文件文本由独立 document owner 保留。完整生命周期见 [workspace-tabs.md](workspace-tabs.md)。

## 虚拟化时间线

`ChatTimeline` 负责时间线呈现，`VirtualTranscript` 与 `TranscriptScrollOwner` 共同负责几何：

- 固定行 key、`overscan: 5`、逐行 `measureElement`，直接 DOM 更新由 adapter 独占行位置和 extent 高度。
- `anchorTo: 'end'` 的 key anchor 只在条目数或首尾 key 改变时保留视口顶部所在 item 的偏移；viewport resize 不触发它。独立的行重测补偿在向后滚动时跳过，不能承担同一行内的语义锚定。
- **`followOnAppend` 保持关闭**。它调用 indexed scroll target，最多追逐五秒。应用只发固定 offset；无新 keep-anchor 定时循环。
- `TranscriptSnapshot` 在 React mutation 前捕获语义点。hook 后的 layout effect 等 adapter 效果运行，再同步测量、修正 residual；ResizeObserver 路径从测量回调排一个 microtask，在同步批次后执行相同修正。
- bookmark 是 row/item/block/text-offset 及其相对视口坐标，不引用可能被高亮替换的 DOM node。触摸/滚动/显式导航取消旧修正；找不到目标时保守退回有效边界或当前 offset。
- follow intent 与 DOM 末端距离分开。隐藏时保留意图，不逐次跟随追加，也不触发历史预取；重新激活时检查宽度、测量目标范围，落位后再展示。
- gate、加载历史按钮、回到最新按钮都在 scroller 外。scroller 内只有虚拟 extent 和实测行，顶部 padding 恒定；底部 padding 与 scroll-padding 同源于 composer wrapper 的真实测量。
- 内容列与 composer 都铺满会话面的可用宽度，只保留响应式水平内边距；Explorer 或窗口宽度改变仍可能引起换行，需要上述几何恢复。

冷开只接受完整 first page（20 turns），先 reconcile live events、测量目标范围、恢复 bookmark/末端再撤 gate；暖内容刷新失败保留内容并显示错误。浏览器测试配置见 [workspace-tabs.md](workspace-tabs.md)。

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
- 回合级的 plan 与 diff 同样按渲染器的真实条件判断（`PlanPanel` 要求 plan 文本或 steps，diff 要求非空串），而不是判断字段是否存在。plan 文本**合并为一处呈现**：流式 delta 与从历史读回的文本是同一段散文，此前分成 explanation 段落与「临时 delta」`<pre>` 两块，会让同一个 plan 在刷新前后长得不一样——而持久化的 plan 恰恰一点也不「临时」

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
- **file-change-item / file-change-set**：两种审批呈现共用完整 change-set renderer，逐文件显示路径、操作种类与 rename 目标。审批内联时优先展示 request-owned review subject，完整主体用 GitDiffPanel；未持有完整主体的普通 item 流式阶段保留 raw diff。
- **user-input-card** (`turn-items/user-input-card.tsx`)：渲染 `item/tool/requestUserInput`（EXPERIMENTAL）。支持 radio（单选）/ checkbox（isOther+多选）/ text / password。提交通过 `pendingApprovalsRespond` REST，写入期间禁止重复提交，完成回调校验原 thread/instance；submitted 与原生 resolved 分开。蓝色边框(pending) / 灰色(resolved)。

## 审批呈现

命令审批**内联在 command item 内部**，与 fileChange 的既有做法一致；此前它是兄弟卡片，会把同一条命令重画第二遍，策略修正案区块再重画第三遍。

规则不是「审批区绝不显示命令」，而是**只去掉同一动作的重复表示**：

| 情况 | 呈现 |
|------|------|
| 与宿主同一动作 | 命令只由 command item 画一次；审批区只加 reason / cwd / 请求的额外权限 / 状态 / 操作 |
| 子命令或 stdin 写入 | 授权对象与宿主显示的不是同一个东西，审批区显示它自己的那份文本 |
| 申请了额外沙箱权限 | 显式展示文件系统条目与网络请求 —— 这是 command item 结构上不可能显示的内容 |
| 纯网络审批 | 协议 + 主机即完整授权对象，协议允许此类请求不带 `command`/`cwd` |
| 一个宿主多个请求 | 按 requestId 分段，各自独立作用域与操作 |
| 无同轮宿主 | 保留自包含卡片（`approval-item.tsx`）；跨轮 stdin 回调即属此类 |
| 已决议 | 收成紧凑状态条。**`resolved` 保持中性**——服务端在 turn 开始/结束/中断的生命周期清理中也会 resolve，不等于用户接受过 |

文件审批在无同轮宿主时自绘完整 review subject；任何条目不可完整解析或集合为空时视为 unavailable。inline 与 standalone 均只保留 Decline/Cancel，不能用本地 item 替代缺失的请求主体。全局创建与读取共享通知决策，按 instance 退休并清掉可见或排队提示。

关键约束：

- 比较用**原始命令**，不用 `stripShellWrapper` 剥壳后的显示形式——后者是为可读性重写过的，拿它判等会把两条不同的命令认成同一条。
- 待审批时授权文本**强制可见**，不受输出折叠状态影响；不能让人给看不见的命令授权。
- 策略修正案授权的是**未来**匹配的命令，作用域比当前这一次更宽，因此收在独立的展开区内，但接受按钮之前必须先看到确切提案。
- 权限缺失 = **未指定**，不等于不受限；`networkEnabled` 为三态，`null` 不渲染成「禁止联网」。
- 文件系统条目保留访问类型与路径语义（`path` / `glob` / `special`，以及 `deny`），不压平成模糊路径列表。**`special` 在钉住 schema 里是对象联合而非字符串**（`root` / `minimal` / `project_roots`+subpath / `tmpdir` / `slash_tmp` / `unknown`+path），按字符串判断等于把它整类丢掉——而只含一条 special 的权限浮层会因此整体变 null，从卡片上消失。作用域标签本身就是安全信息（`root` 与 `tmpdir` 授权的东西完全不同），因此展示的是它的 scope 而不是「special」这个词。
- 决议后**不丢上下文**：状态条只替换掉操作按钮，命令、reason、cwd 与权限浮层继续渲染——事后要能看清当时到底授权了什么。
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
- 点击 @mention badge → dispatch `codex-webui:open-file` 自定义事件 → `ThreadView` 打开对应文件 tab
- 图片附件也渲染为可点击 badge（ImageIcon 图标 + 文件名），点击同样在文件 tab 中预览
- 路径解析：`normalizeMessageMentions` 将绝对路径转回相对路径显示；mention 插件中相对路径用 `threadCwd` 重建绝对路径
- 气泡容器加 `overflow-hidden` 防止长内容溢出圆角边界

### ChatInput 布局

从 overlay 模型（按钮 `absolute` 叠加在 textarea 底部）改为 stacked 模型：
- 单一面板（`bg-card` + 边框 + `rounded-2xl`）内依次是附件 chips、textarea、按钮行——三者共用一个表面，不再靠 `border-t-0`/`border-b-0` 拼接两个盒子
- 焦点态用 `focus-within:outline-2`，沿用玻璃时期的写法（见玻璃层级说明）

**面板是实心的，不是玻璃。** 它浮在转录之上，半透明表面必须真的挡住底下滚过的内容，而 `backdrop-filter` 在这里做不到：外壳主列是 backdrop root，滤镜压根采样不到东西；即便采样正常，淡到能读作"玻璃"的底色也挡不住文字（暗色玻璃表面仅 8% 白）。

#### 浮层定位与底部淡出

Composer 无条件浮动在 Conversation 内，`ConversationFrame` 用 ResizeObserver 测量包括覆盖 padding/safe area 的外包装。该值同时供 `paddingEnd` 与 `scrollPaddingEnd` 使用，textarea 增长、附件、语言和宽度变化都走同一路径；tab 隐藏不把测量替换为零。

**Composer 与正文都不设 max-width**，各自铺满会话面，只保留 `px-3 sm:px-4 lg:px-6` 让两者对齐。可用宽度由外壳与可拖宽的 Explorer 决定。

面板实心解决不了全部问题：它相对滚动容器是内缩的，正文仍会从它**两侧和上缘**露出来。故滚动容器用 `mask-image` 淡掉自己的底缘（`virtual-transcript.tsx`，斜坡 `COMPOSER_FADE_PX`）。用 mask 而不是叠一层渐变遮罩，是因为 mask 与背景色无关，一条声明同时适用两套主题、任意底色；渐变遮罩必须知道自己淡入的确切背景。斜坡起点正是 `paddingEnd` 已经预留的 composer 带，所以停在底部时不会淡掉任何内容。

## Markdown 渲染

`react-markdown` + `remark-gfm` + Shiki 语法高亮（懒加载，缓存）。agent 消息使用 `MarkdownRenderer` 组件，用户消息使用 `UserMessageBubble` 内的独立 Markdown 实例（含 remark-mentions 插件）。

**代码块不跟随主题。** 容器底色写死 `#0d1117`，Shiki 以 `defaultColor: 'dark'` 输出内联色，且项目没有任何激活 `--shiki-light` 的 CSS —— 所以浅色主题下高亮内容仍是深色配色。据此，块内元素（语言标签、复制按钮、无高亮时的 `<pre>`、分隔线）必须用固定浅色而非 `text-muted-foreground` 等语义 token，否则浅色主题下它们会变成深灰贴在深色底上，几乎不可见。

### 生产构建注意

Vite `cssTarget: ['chrome100', 'safari16', 'firefox100']`：防止 CSS minifier 将 `backdrop-filter` 剥离为仅 `-webkit-backdrop-filter`（后者在部分浏览器无法正确解析 `blur() saturate()` 组合值，导致玻璃态效果丢失）。

## 模型选择器

ChatInput 内两个同级 popover，共用 `use-active-model` 解析「下一轮实际使用的模型」，避免两处各自推导后给出该模型并未声明的选项：

- 左侧 `ModelSelector`：选模型 + 推理强度。
- 右侧（token 用量环左边）`ServiceTierSelector`：按模型支持过滤本地 start/resume/fork seed 与显式选择。不支持的配置不冒充 Standard；没有有效显示值时按钮只标 Speed。没有配置时仅采用受支持的目录默认值。模型未声明任何 tier 时控件不渲染。上游 `warning`（含 unsupported tier 原文）显示为系统警告，不据此编造替代档位或刷新会话。

三者的 session-level overrides 都存 `model-store`，随 `turn/start` 发出。

选项行统一用 `option-row.tsx`，带 `default` 角标和第二行说明。**说明文案来自 app-server 目录，且只有英文** —— `model/list` 没有 locale 参数，`initialize` 也没有语言能力位。文案统一过 `lib/catalog-copy.ts` 的 `catalogCopy()`：本项目 i18n 以英文自然语言串为 key，因此已收录的串会被翻译，未收录的原样落回英文，无需另建一套按 id 索引的字典。由于 key 就是英文原文，上游改文案时只会 miss 并回落到新英文，不会把旧译文错配到新内容。

`catalogCopy()` 不能简化成裸 `t(value)`：**i18next 即使 key 缺失也会解析 `$t(...)` 嵌套**（实测 `"Has $t(Model) nesting"` 会被改写成 `"Has Model nesting"`），把任意上游散文喂给 `t()` 会静默篡改文案。因此它先 `i18n.exists()` 再取值。`catalog-copy.spec.ts` 锁住这个行为。

推理强度与速度档位都是**逐模型 advertise** 的（`supportedReasoningEfforts` / `serviceTiers`），必须按目录顺序原样渲染，不要自行推导或排序；切换模型时两个 override 一并重置，否则可能选中新模型根本没有的档位。`DEFAULT_EFFORTS` 仅在识别不出当前模型时兜底，且刻意不带说明文案。

### 隐藏模型

`use-active-model` 以 `includeHidden: true` 请求 `model/list`，再把结果拆成默认列表与折叠在开关后的隐藏列表，**不是过滤掉**。目录会把不少真实可选的模型标成隐藏（钉住版本 11 个里有 6 个），先前无条件 `filter(!hidden)` 造成两个后果：配置里指定的隐藏模型在 UI 上无名可显，且一旦切走就再也切不回来。

因此**当前生效模型若本身是隐藏的，始终出现在列表里**，与开关状态无关——用户必须能看到自己在跑什么。隐藏条目带 `hidden` 角标。

## 模型目录编辑器

设置 → Codex 下方的独立区块，详见 [model-catalog.md](model-catalog.md#前端)。UI 层需要知道的几点：

- **修复入口不能依赖被修复的东西**。写坏 catalog 会让 app-server 无法启动，`config/read` 随之失败。因此目录区块故意不复用 `CodexSettings` 的 config 查询、作为其兄弟节点渲染（`CodexSettings` 失败时只渲染错误提示，不抛出）；裸 TOML 编辑器抽成独立的 `raw-config-editor.tsx`——它原先只挂在成功分支的末尾，等于把修复工具锁在了它要修复的故障后面。
- **组件位置本身就是状态的一部分**。上一条只做到"错误分支里也渲染"是不够的：按 loading / error / success 分别 early-return，会让编辑器在每次查询状态切换时卸载重挂，**丢掉用户正在写的 TOML**——而这恰好发生在读取失败、最需要它的时候。正确做法是单一 return，让**结构化区块**成为条件渲染的那一半，编辑器在所有状态下保持同一个树位置。凡是持有本地未保存状态的组件都适用这条。
- **能解除某个状态的动作，必须和该状态一起出现**。通过裸配置改掉 catalog 指针后 child 完全健康，却仍需重启才生效；把「重启 Codex」只挂在启动失败块里，就会出现「提示你去点一个不存在的按钮」。
- 表单字段**从打开时的条目与模板派生**而非硬编码，也不取自实时草稿。上游 `ModelInfo` 约四十个字段且随 CLI 升级增加，写死清单会静默漏掉新字段，往返时丢弃未知字段等于悄悄改坏模型；而按实时草稿推导会让「清空一个字符串」把该字段的编辑器在编辑途中变成 JSON。
- **受控表单必须保留中途输入的原文**。半个数字、写到一半的对象都还不能解析，此时回退渲染上一份已解析的值会撤销这次按键——JSON 和数字字段因此完全无法逐字符编辑。
- 列表项按 **slug** 而非对象身份定位：文档每次渲染都重新 `JSON.parse`，对话框持有的条目和列表里的永远不是同一个对象。
- 「保存草稿」与「应用并重启」是两个按钮。目录只在 app-server 启动时读取一次，应用必然伴随重启，因此草稿写入的文件永远不是运行中进程加载的那个。
- 「已配置」与「正在运行」是两件事（`configuredPointer` vs `pointerApplied`），「本后端托管」又是第三件（`managed`，决定是否提供「使用默认目录」）。把三者混为一谈会让 UI 对外部手写的指针给出后端必然拒绝的动作。

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
- **折叠开关归外壳所有，不在侧边栏里**：`ChatHeader` 头部左槽，桌面断点下两态常驻，只翻图标与无障碍名（`aria-expanded` 跟随，`aria-controls` 指向 `SIDEBAR_REGION_ID`）。`ChatHeader` 被共享布局与会话路由分别渲染同一个组件，所以每个桌面路由都有这个开关。
  之前折叠是侧边栏**底部**的整行按钮、展开是头部的小图标：侧边栏折叠到零宽时那行按钮随之消失，同一个命令只好换个地方换个形态出现。两态复用同一个按钮元素（而非条件渲染两棵树）也让焦点在切换后留在原处
- Thread context menu：Rename / Archive / Unarchive / Compact / Fork
- DirectoryPickerDialog：选择工作区目录创建会话
- **Per-thread 状态图标**（优先级 high→low）：
  - `waitingOnApproval`：黄色 ShieldAlert + `animate-pulse`
  - `waitingOnUserInput`：蓝色 MessageCircleQuestion + `animate-pulse`
  - generating（active 无 blocking flags）：Loader2 + `animate-spin`
  - idle：灰色 MessageSquare
- **Approval count badge**：hydrated pending approvals > 1 时显示数字（9+ 封顶），半透明黄色圆角背景

策略读取失败时，SecurityPolicyBadge 弹层显示「最后已知」说明（含中文翻译）。闭合徽章与发送按钮不因 stale 单独改变；确认中的用户策略选择仍按原有规则等待。

## 权限与 MCP 交互

`turn-items/interaction-card.tsx` 消费后端已完整验证的 presentation。权限逐项显示 read/write、special scope、glob、固定 deny 约束，默认不勾选授予，session scope 必须显式选择。MCP 支持 primitive form 与 URL，未知扩展语义不显示部分表单或 Accept。URL 仅用户点击后打开，Continue 是另一项明确操作。

所有卡片通过 `use-request-response.ts` 提交 instance-bound 决定，本浏览器成功提交的选择与 Decision submitted 分别显示；原生退休不推断用户选择或执行成功。WebSocket 先退休、HTTP 后返回时仍保留选择，并且不把终态退回 submitted。已有选择遇到后续传输失败时与 Delivery unconfirmed 一起显示。缺少 instance 的旧客户端必须刷新。`codex.serverRequestFailed` 显示客户端失败原因，既不伪装为用户 Decline，也不代替 turn/completed。

模型目录组件测试直接操作关联标签的表单控件，覆盖错误修复与 raw 往返。查询失败时不再显示没有配置覆盖；新增条目的字段集不跟随远端模板更新。完整历史的按需刷新策略见 [completed-turn-items.md](completed-turn-items.md)。

### Terminal replacement presentation

会话打开后可发现现存终端，恢复的 tab 不抢占 Conversation 或文件焦点。隐藏终端丢失时显示 lost，选中后才尝试替换。替换保留 tab 位置和标题，持续显示新 shell 与启动目录，上一 shell 的本地输出单独只读展示。24 小时内三次自动尝试后显示手动启动操作；断线期间输入不重放。会话 cwd 尚未就绪时禁用 New terminal，而不是借用全局默认目录。完整契约见 [terminal.md](terminal.md)。
