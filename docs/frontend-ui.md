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
| `/integrations` | IntegrationsPage | 集成管理（Plugins/Apps/MCPs），`?tab=` URL search state |

`AuthenticatedLayout` 包裹所有认证路由：responsive sidebar + header + `<Outlet />`。

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
- Smart auto-scroll：流式输出跟随底部，上翻不打断
- `overscan: 5`，TurnBlock 使用 plain `div`（不用 Framer Motion 避免 recycling 重动画）

### 更早历史：显式按钮，不做无限滚动

打开线程只取最近一页 turns，更早的历史需要往前翻。列表顶部给一个「加载更早的消息」按钮，而不是滚动到顶自动加载 —— 更早的内容是**向上插入**的，而虚拟列表用的是估算行高，自动前插会让用户正在读的内容位移。做成按钮至少保证这个位移是用户主动触发的。

`historyCursor` 为 null 时按钮不渲染（历史已完整）。

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

### 生产构建注意

Vite `cssTarget: ['chrome100', 'safari16', 'firefox100']`：防止 CSS minifier 将 `backdrop-filter` 剥离为仅 `-webkit-backdrop-filter`（后者在部分浏览器无法正确解析 `blur() saturate()` 组合值，导致玻璃态效果丢失）。

## 模型选择器

ChatInput 内 `ModelSelector` popover → 选模型 + 推理强度。Session-level overrides 存 `model-store`，传给 `turn/start`。

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
