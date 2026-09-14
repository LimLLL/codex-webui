# Web Terminal 实现文档

## 概述

基于 node-pty + xterm.js 的 Web Terminal，通过 Socket.IO 双向传输。终端现在按 context 管理：

- `global`：全局终端路由 `/terminal`
- `thread:<threadId>`：会话平级 terminal tabs

同一 context 下支持多个终端 tab。多个已认证浏览器 socket 可以 attach 到同一个终端，共享输出、输入和 resize。关闭面板或页面跳转只 detach；显式关闭终端 tab 才会 kill PTY。

## 后端模块 (src/terminal/)

### TerminalService

文件: `src/terminal/terminal.service.ts`

| 方法 | 说明 |
|------|------|
| `getConfig()` | 返回 runtime settings/env/default 合并后的终端配置 |
| `list(contextKey)` | 列出 context 下的终端 metadata |
| `open(socketId, params)` | 创建 PTY + headless mirror，并 attach 当前 socket |
| `reconnect(socketId, contextKey, terminalId)` | attach 到已有终端并返回 serialized VT state |
| `detach(socketId, terminalId?)` | detach socket；最后一个 socket detach 后启动 grace timer |
| `write(socketId, contextKey, terminalId, data)` | 已 attach socket 写入输入 |
| `resize(socketId, contextKey, terminalId, cols, rows)` | 已 attach socket resize，last resize wins |
| `rename(socketId, contextKey, terminalId, title)` | 重命名共享 terminal tab |
| `download(socketId, contextKey, terminalId)` | 从 headless active buffer 导出 plain text |
| `close(socketId, contextKey, terminalId)` | 显式 kill PTY 并通知所有 attached sockets |

每个 terminal session 记录：`id`、`contextKey`、`cwd`、`shell`、`status`、`exitCode`、`signal`、`title`、`attachedSocketIds`、`cols`、`rows`、`createdAt`。

### headless xterm mirror

后端为每个 PTY 创建 `@xterm/headless` Terminal，并加载 `@xterm/addon-serialize`：

- PTY `onData` 先写入 headless mirror，再广播 `terminal.output`
- `terminal.reconnect` 返回 `SerializeAddon.serialize()` 的 VT state
- `terminal.download` 读取 headless `buffer.active` 并导出文本
- headless scrollback 与前端 xterm scrollback 使用同一 runtime setting 配置

### TerminalGateway

文件: `src/terminal/terminal.gateway.ts`

| 事件 | 方向 | 说明 |
|------|------|------|
| `terminal.config` | Client → Server | 获取终端配置 |
| `terminal.list` | Client → Server | 按 context 列出终端 |
| `terminal.open` | Client → Server | 创建并 attach 终端 |
| `terminal.reconnect` | Client → Server | attach 已有终端并返回 serialized state |
| `terminal.detach` | Client → Server | detach 当前 socket，不 kill |
| `terminal.input` | Client → Server | 写入输入 |
| `terminal.resize` | Client → Server | resize，cols clamp 20-300，rows clamp 5-120 |
| `terminal.rename` | Client → Server | 重命名 |
| `terminal.download` | Client → Server | 获取 plain text buffer |
| `terminal.close` | Client → Server | 显式关闭并 kill |
| `terminal.output` | Server → Client | PTY 输出 |
| `terminal.metadata` | Server → Client | metadata 更新 |
| `terminal.exit` | Server → Client | 进程退出或显式关闭通知 |
| `terminal.error` | Server → Client | 明确错误消息 |

所有 mutating 操作都会验证 terminal 存在、context 匹配、socket 已 attach，失败时返回 ack error 并发送 `terminal.error`。

## cwd 解析

`terminal.defaultCwd` 使用 settings 读取链：DB override → `DEFAULT_TERMINAL_CWD` env fallback → empty default。

1. 如果 `terminal.defaultCwd` 有有效值：必须存在、是目录、且通过 `FilesService.resolveSafePath`，否则新建终端 fail-fast。
2. 空值时，`thread:<threadId>` 使用线程 cwd。
3. 空值时，`global` 使用 homeDir。

## Runtime Settings 与环境变量

终端配置由 `settings` 表管理，读取优先级为 DB override → env fallback → hardcoded default。运行时修改只影响新建终端和之后创建的 detach grace timer，不重建已有 PTY/headless/xterm 实例。

| Setting key | Env fallback | Default | Constraints | Purpose |
|-------------|--------------|---------|-------------|---------|
| `terminal.maxSessions` | `WEBUI_TERMINAL_MAX_SESSIONS` | 10 | 1-50 integer | 后端最多保留的 PTY/headless session |
| `terminal.graceMs` | `WEBUI_TERMINAL_GRACE_MS` | 45000 | 10000-300000 integer | 最后一个 socket detach 后保留 PTY 的时间 |
| `terminal.scrollback` | `WEBUI_TERMINAL_SCROLLBACK` | 5000 | 100-50000 integer | 新建前后端 xterm scrollback 行数 |
| `terminal.defaultCwd` | `DEFAULT_TERMINAL_CWD` | empty | existing directory under workspace roots | 所有终端默认 cwd；无效时新建终端 fail-fast |

## 前端

### Terminal store

文件: `web/src/stores/terminal-store.ts`

- `contexts`: `global` / `thread:<threadId>` → terminal tab 顺序和 active terminal
- `terminals`: terminalId → metadata
- metadata 与 tab descriptors 只存内存；reload 重置本地 views，不自动新建 session
- socket ack actions: list/open/reconnect/detach/close/rename/download/resize

### TerminalPane

文件: `web/src/components/terminal/terminal-pane.tsx`

- 绑定一个 terminalId，不在 mount 时创建 PTY
- mount/reconnect 时调用 `terminal.reconnect` 并写入 serialized VT state
- unmount 时 `terminal.detach`
- 由 authenticated layout 的 TerminalHost 保持实例；切换 tab/会话/独立 route 不 detach。inactive 或目标区域无可用尺寸时不 fit 或上报尺寸，不沿用前一个目标的矩形；重连回调也受相同守卫约束
- xterm scrollback 使用后端 config

### TerminalTabs

文件: `web/src/components/terminal/terminal-tabs.tsx`

- 显示多个 terminal tabs（title/status）
- 支持 create/close
- `attachedCount > 1` 时关闭 tab 会弹确认框，因为 close 会 kill 所有共享客户端的 PTY

### TerminalStatusBar

文件: `web/src/components/terminal/terminal-status-bar.tsx`

- 终端下方独立状态栏，显示 shell · cwd、attached count、rename/download 按钮
- 在 TerminalWorkspace（独立路由）和会话 terminal tab中均渲染于终端 pane 下方

### 使用场景

| 场景 | 入口 | context |
|------|------|---------|
| 全局终端 | Sidebar "Terminal" 按钮 | `global` |
| 会话终端 | 工作区 New terminal 操作 → 平级 tab | `thread:<threadId>` |

## 生命周期

| 操作 | 行为 |
|------|------|
| 切换 terminal tab | pane 仍 mounted，不 detach |
| 切换到 file tab | terminal panes hidden 但仍 attached |
| 切换会话/独立 route | 实例继续 attached，隐藏时不报告尺寸 |
| 页面刷新/断线 | socket disconnect 自动 detach |
| 最后一个 socket detach | 启动 grace timer |
| grace 内重新 attach | 取消 timer，返回 serialized VT state |
| grace 过期 | kill PTY，dispose headless |
| 显式关闭 terminal tab | 确认共享关闭后 kill PTY；成功才移除本地 view，失败保留 |
| 自然退出/其他客户端关闭 | 保留本地输出和 view，不自动关闭 tab |
| 删除本地 tab 集合/清理 owner | detach 本浏览器，不调用 destructive close |
| 后端重启 | 所有 PTY/headless 丢失，前端标记 expired 并提示新建 |

## 依赖

- `node-pty` — native addon，需要编译。Node.js 版本变化后需 `npx node-gyp rebuild`
- `@xterm/headless` — 后端 VT state mirror
- `@xterm/addon-serialize` — 前后端 serialized VT state 支持
- `@xterm/xterm` + `@xterm/addon-fit` — 前端终端模拟器
