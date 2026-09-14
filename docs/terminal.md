# Web Terminal

基于 node-pty、xterm.js 和 Socket.IO 的共享服务器终端。context 为 `global` 或 `thread:<threadId>`；多个已认证浏览器共享一个终端的输入、输出和尺寸。

## 状态所有权

| 对象 | 所有者与生命周期 |
| --- | --- |
| 逻辑终端 `id` | SQLite `terminal_identities`；保存 context、实际启动 cwd、shell 可执行文件、title、当前 sessionId/generation、关闭状态和自动恢复次数 |
| 物理 PTY `sessionId` | `TerminalSession`；每次替换使用新 UUID，PTY 和 headless buffer 在关闭、grace 回收或服务器正常退出时释放 |
| 本地 tab | `workspace-store`；tab 身份、位置和选中状态不随 PTY 替换改变 |
| 本浏览器 attachment | `terminal-view-store` / `TerminalHost`；按逻辑 id 保留一个实例，页面和 tab 切换只改变呈现目标 |
| 客户端状态与请求 | `terminal-store`；区分传输故障、确证丢失、逻辑关闭、恢复限额和一般失败 |

`TerminalService` 仲裁 attach / recover / close；`TerminalRegistryService` 管理持久化资格和限额；`terminal-launch.ts` 集中目录选择与校验；`TerminalSession` 仅拥有物理进程、buffer 和序列边界。

## 目录规则

先选定一个目录，再通过 `FilesService.resolveSafePath` 的 realpath / workspace roots 校验并确认是目录。校验失败不会尝试另一个目录。

| 操作 | 选择 |
| --- | --- |
| 新建会话终端 | 必须提供会话 cwd；全局默认值不能覆盖，也不能补足缺失的会话 cwd |
| 新建全局终端，有显式 cwd | 使用并校验显式 cwd |
| 新建全局终端，无显式 cwd | 使用配置的默认 cwd；未配置时使用 home |
| 替换已有终端 | 使用持久化记录中的实际启动 cwd，不受之后的默认值或会话 cwd 变化影响 |
| 重新附着存活 PTY | 保留该进程，不重新选择目录 |

`terminal.defaultCwd` 的设置来源仍为 DB override → `DEFAULT_TERMINAL_CWD` → 空值。改变的是适用范围：仅为没有显式目录的全局终端提供默认值。无效默认值会使需要它的全局新建失败，但不影响已有有效 cwd 的会话新建。

记录的是启动目录，不是用户在 shell 中执行 `cd` 后的实时目录。替换不恢复环境变量修改、后台作业、未执行输入或原进程状态；shell 自身的历史文件行为不等于进程恢复。

## 关闭、回收和替换

- 显式关闭始终请求后端：running、exited、已回收和已经关闭都经过逻辑 close。
- close 在发送成功确认前提交 durable revocation，再终止当前 PTY。离线浏览器错过关闭事件、随后服务器重启，也不能恢复这个 id。
- 缺少 attachment 不妨碍已认证客户端关闭其 context 中的逻辑终端。context 不匹配仍拒绝。未知旧 id 不可恢复，重复关闭可安全成功。
- close 持久化失败不报告成功；撤销后物理清理失败不会恢复资格。未发布进程若无法清理仍占据容量，禁止再为它生成替代进程。
- 最后一个 socket detach 后开始 grace timer。到期只回收 PTY 和 buffer，保留逻辑身份及恢复资格。
- 自然退出保留 exited session 和输出；没有 attachment 时仍经过 grace 回收。自然 shell `exit` 与显式关闭 tab 是不同操作。
- 只有**当前正在呈现且页面可见**的终端发出 recover。隐藏终端重连只 attach；发现丢失后标记 lost，选中时再恢复。已经发出的恢复请求可能在导航后完成，其结果仍属于原终端。
- 启动服务器、发现会话终端、grace timer 本身均不创建替代进程。
- 同一逻辑 id 的并发 recover 共享后端一次分配；先前的成功确认丢失后重试返回已有替代 PTY。close 在目录校验期间完成时，恢复必须在 spawn 前重新检查撤销。
- 分配前检查所有等待浏览器，首个调用者断线不会使其它仍连接的调用者一起失败；每个调用者附着时仍验证自己的连接。
- 替代 sessionId 先持久化再发布。所有 input / resize 携带物理 sessionId，旧 shell 的迟到数据不能作用于新 shell。

## 自动恢复限额

每个逻辑 id **滚动 24 小时最多三次自动恢复尝试**，时间记录在 SQLite，跨浏览器和后端重启共享。目录校验及容量检查后、spawn 前记录尝试，因此 spawn 失败也消耗一次，避免坏 shell 不断自动启动。重新附着已有替代 session 不消耗次数。

三次允许偶发重启和长断线恢复，同时限制整夜网络抖动的进程放大。超过限额显示持续提示和 **Start replacement shell** 操作；手动恢复绕过自动次数限制，但不清零历史，也不能绕过关闭、路径校验或容量限制。窗口推进不会定时拉起 shell，仍需发生新的前台恢复请求。

**Retry connection** 重试受限恢复流程；仅当需要实际尝试 spawn 时消耗自动额度，重新附着存活 session 或目录/容量校验失败不消耗。只有 **Start replacement shell** 表示绕过自动额度的明确手动操作。

资格记录不会随着 grace timer 过期而删除，当前没有额外的资格 TTL 或自动清理任务。长期使用会积累少量元数据；PTY 上限不限制记录数量。未来若引入记录清理，被忘记的 id 必须保持不可自动恢复。

## 会话发现与呈现

打开会话或该会话页面 socket 重连后，`useTerminalDiscovery` 请求现存 session 清单，经过 **仅附着** 成功后才将它们加入 workspace。包括仍有输出的 exited session。列表不枚举只有 durable identity 而没有 PTY/buffer 的历史记录。

attach 在返回 snapshot 前会发送 metadata，提前到达的通知仅更新 metadata cache，不创建可选择 tab。成功 ACK 才将 session 加入终端列表，避免独立路由选中尚未成功附着的 session；提前到达的 exited 状态仍保留，迟到的 running ACK 不能覆盖它。

列表与 attach 之间 session 被回收时，忽略或报告该 session，绝不转入 recover。发现不选中 tab，不覆盖文件视图和现有次序；同一 id 只出现一次。独立终端路由是唯一例外：该页面本身就是终端，在**完全没有选中项**时选中第一个并不覆盖任何意图，否则刷新后整页只剩一句「请选择终端」。会话 tab 不走这条路径。显式 New 保持“另外创建一个终端”的含义，并等待当次发现结束；失败的发现不无限阻塞 New。删除 context 会使迟到的发现失效。

替换保持 tab 位置和标题，在当前面板持续显示新 shell 名称与 cwd。最近一个被替换 shell 在本浏览器留下的输出保存在单独的只读折叠区域；新 xterm buffer 从替代 session 的状态开始，二者不混成连续 shell。替换和断线清除焦点，断线期间的输入不缓存、不重放。

后端先镜像输出再广播，output 带 sessionId/sequence，attach 返回同一序列边界的 VT snapshot。前端只追加 snapshot 之后的输出，防止 snapshot/live 重叠造成丢失或重复。逻辑关闭和连接变化使过期请求结果失效。

关闭超时或断线后的本地 pending 状态不等于服务器确认 closed。旧连接的失败不能覆盖新连接成功恢复的 metadata；同一物理 session 的 exited 状态不能被迟到的 running ACK 逆转。

客户端使用可靠 emit，并清除刚被 Socket.IO 判定为过期传输而放入 sendBuffer 的终端请求。此窗口中 `socket.connected` 可能仍为 true；除输入外，open/recover/close/attach 请求也不能缓存到重连后执行。sendBuffer 在当前 Socket.IO 类型中是公开属性，但非当前 v4 文档承诺的按事件发送选项；该依赖由实际 Socket.emit 测试覆盖。volatile 不适用于输入，因为正常连接的 backpressure 也可能丢弃按键。不要照搬旧版文档在 connect 回调里清空 buffer：当前版本在触发 connect 之前已经发送 buffer。

## Socket.IO 合约

`TerminalMetadata` 包含稳定 `id`、物理 `sessionId`、递增 `generation`、contextKey、cwd、shell、title、status、exitCode、signal、attachedCount、cols、rows、createdAt。

| 事件 | 请求 / 结果 |
| --- | --- |
| `terminal.config` | 返回 config |
| `terminal.list` | `{contextKey}` → 现存 sessions 和 config；不创建、不附着 |
| `terminal.open` | `{contextKey,cwd?,cols?,rows?,title?}` → 新逻辑终端 metadata，并附着当前 socket |
| `terminal.reconnect` | `{contextKey,terminalId}` → `{terminal,state,sequence}`；仅附着现存 session |
| `terminal.recover` | `{contextKey,terminalId,manual}` → `{terminal,state,sequence}`；前台恢复，资格和限额由后端决定 |
| `terminal.detach` | `{terminalId?}` → 仅释放当前 socket |
| `terminal.input` | `{contextKey,terminalId,sessionId,data}` |
| `terminal.resize` | `{contextKey,terminalId,sessionId,cols,rows}`；last visible resize wins |
| `terminal.rename` | `{contextKey,terminalId,title}` → 持久化共享标题 |
| `terminal.download` | `{contextKey,terminalId}` → filename/content |
| `terminal.close` | `{contextKey,terminalId}` → durable close；成功才移除发起浏览器的 tab |
| `terminal.output` | `{terminalId,sessionId,sequence,data}` |
| `terminal.metadata` | `{terminal}` |
| `terminal.exit` | 自然退出 `{terminal,closed:false}`；明确关闭 `{terminalId,contextKey,closed:true}` |

ACK 保留 `{ok,error?,errorCode?,params?}`。`terminal.session_lost` 表示有资格记录但无物理 session；`terminal.not_found` 是未知身份，不能据此创建。`terminal.closed`、`terminal.context_mismatch`、`terminal.socket_not_attached`、`terminal.stale_session`、`terminal.recovery_limit`、`terminal.launch_failed`、auth 错误均保持独立。客户端超时为 `terminal.transport_timeout`，不是进程丢失的证据。

TerminalGateway 显式绑定现有 `ApiKeyGuard`，不能假设 HTTP 的全局 guard 自动保护网关。网关级 exception filter 将 handler 之前的鉴权拒绝也传回 ACK；无 ACK 的请求发送 typed `terminal.error`。

## 配置与资源

| Setting | Default | 用途 |
| --- | --- | --- |
| `terminal.maxSessions` | 10（范围 1–50） | 同一后端的 PTY/headless 上限，在分配点检查；包括不能安全清理的未发布进程 |
| `terminal.graceMs` | 45000（范围 10000–300000） | 最后 detach 后物理资源保留时间，不是恢复资格的寿命 |
| `terminal.scrollback` | 5000（范围 100–50000） | 新建前后端 buffer 行数 |
| `terminal.defaultCwd` | 空 | 无显式 cwd 的全局终端默认目录 |

配置更新只影响相应的新分配和后续 detach timer，不移动已有 shell。

## 部署兼容性与验证

迁移 `0012_terminal_lifecycle` 由 drizzle-kit 生成，随正常数据库启动迁移创建 terminal identities。需要保留 WebUI SQLite 数据库，并协调更新客户端与后端；旧客户端缺少物理 sessionId，其输入/resize 会被拒绝，应刷新页面。

此前依赖默认值覆盖所有会话终端的部署会观察到变化：新的会话终端进入会话目录；缺失/失效的会话目录会明确报错。已有终端及替代进程继续使用该终端记录的实际启动目录。全局显式 cwd 现在也被尊重。

首次升级前已经丢失、没有 durable record 的旧 session 无法安全恢复。页面 reload 若发生在 grace 内可发现尚存会话 session；超过 grace 且浏览器已丢失本地 id 时，发现仍不会从历史记录自动创建终端。

生命周期 tests 使用真实 SQLite 迁移；integration test 重开文件数据库，并使用真实 `/bin/sh` 验证 explicit close、grace 和正常 shutdown 后 PID 不再存在。另有真实 Socket.IO 测试覆盖鉴权拒绝和丢失确认后的共享替代。前端单测覆盖发现竞态、前台恢复、限额操作、输入隔离和旧输出分离。终端位置与隐藏几何仍由 Chromium/WebKit browser project 验证。

支持模型为一个后端拥有 PTY。SQLite 事务不能把 OS spawn/kill 变成数据库事务，不承诺任意崩溃下 shell 启动副作用 exactly-once，也不承诺强杀后端会终止每个子孙作业。持续长断线仍可能触发窗口内有限次数替换。
