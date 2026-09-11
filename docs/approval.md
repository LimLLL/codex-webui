# Server requests 与人机交互

## 所有权与分发

每个 stdio 连接的 `ServerRequestOwner` 在 observer 之前接管所有 server-initiated JSON-RPC request。请求必须被答复、由明确的 handler 保留，或因原连接/上游生命周期结束而退休。人类等待不阻塞其它 RPC 流量，也没有统一超时；所有浏览器离线时仍可等待恢复。

生成的 `ServerRequest` union 的每个 method 都在 disposition 表中显式分类，新增 variant 会造成编译错误。原始 wire envelope 的 method 仍是开放字符串：未导出的运行时方法走错误答复，不能因类型断言而被丢弃。

| Method | 处理 |
| --- | --- |
| `item/commandExecution/requestApproval` | command/writeStdin 卡片，受主体与 advertised decisions 限制 |
| `item/fileChange/requestApproval` | 完整文件主体；主体缺失时仅 Decline/Cancel |
| `item/tool/requestUserInput` | 校验完整问题集后提供输入卡片 |
| `item/permissions/requestApproval` | 完整权限选项与显式 session scope |
| `mcpServer/elicitation/request` | 按 mode/schema 选择完整表单、URL 或仅 Decline/Cancel |
| `applyPatchApproval`、`execCommandApproval` | 明确拒绝 legacy 协议 |
| `item/tool/call` | 本客户端未注册执行器，明确拒绝 |
| `account/chatgptAuthTokens/refresh` | 无 refresh token，立即拒绝并提示重新登录 |
| `attestation/generate` | 不提供 attestation，明确拒绝 |
| 其它运行时 method | 明确拒绝，包括未导出的 `currentTime/read` |

已知不支持的能力使用参考客户端的 `-32000`；未知 method 使用 `-32601`。无效可识别参数返回 `-32602`，admission/持久化异常返回 `-32603`。错误不回显私人参数或异常内容。网关只订阅成功 admission 的请求，不负责决定谁拥有 RPC。

`human-server-requests.ts` 复用 ingress 的 method 分类。实际 admission 还验证参数是否可定位、完整显示、编码答复与恢复；“概念上是人类问题”不等于“本客户端已实现”。

## 身份与生命周期

每个新请求在 ingress 获得随机 `instanceId`。它与不可变 proposal 一起持久化，并贯穿：

- live `codex.serverRequest`；
- REST pending 读取；
- REST 和 Socket.IO 响应；
- 全局提交/退休通知；
- 浏览器去重、在途回调、恢复读取及通知关闭。

`generation` 仍用于本进程生命周期管理，不能作为跨 backend 重启的唯一身份。浏览器必须回传 `instanceId`；缺失时拒绝并要求刷新，不回退到“当前 generation + requestId”。

数据库以 instance 为主键，旧 generation/requestId 只是索引。重复 admission 不替换 params、thread、reviewSubject 或状态。相同 wire ID 在新连接上得到不同 instance。迁移分两步生成：先添加列，再变更主键；旧记录保留 null instance，没有新的响应权限，启动时旧 pending/submitted 被置为 expired。

SQLite 的 text PRIMARY KEY 允许多个 NULL，这是保留旧行的兼容行为。所有新 admission 都写入非空随机 instance；非 NULL 的唯一性在竞争连接之间同样生效：未提交写入使另一 writer 等待或返回 busy，提交后相同 instance 的插入返回唯一约束错误。无需改写旧行的身份。

| 状态 | 含义 |
| --- | --- |
| `pending` | 人类仍可作决定 |
| `submitted` | 本地决定已提交，等待 app-server 生命周期证据 |
| `resolved` | app-server 已处理或清理该请求，不暗示执行成功或用户接受 |
| `cancelled` | 删除执行器已取消所属工作 |
| `expired` | 原连接/后端生命周期结束，旧响应权限无效 |
| `failed` | 本客户端拒绝，或已提交决定的传输结果无法确认 |

响应入口先校验 instance、pending 状态、删除守卫、原请求约束与原连接 authority，再通过 SQLite CAS 提交 `submitted`。只有一个浏览器能提交成功。stdio 写入在数据库提交之后，不能放进一个声称可回滚传输的数据库事务中。

SQLite 与 stdio 没有共同事务：提交成功不证明 app-server 已接收；写失败也不证明零字节已发送。不恢复 pending、不自动重放决定、不引入 outbox/retry。原连接关闭后所有 authority 失效。app-server 的 `serverRequest/resolved` 和对应生命周期证据负责确认退休。

浏览器单独保留 `decision`，只在自己的 HTTP 提交成功后记录，不从全局退休推断其它浏览器的选择。即使 WebSocket 终态先于 HTTP 回应到达，也会补上同一 instance 的决定，保留已观察到的终态。已知决定在后续 delivery failure 时仍与「无法确认送达」一起显示；错误 HTTP 回应不能产生成功归因。

<a id="global-attention-contract"></a>

## 传输契约

REST:

- `GET /api/pending-approvals?threadIds=...` 返回 `{ generation, requests, failures }`。
- `requests` 包含 pending 与 submitted；内部 attention 计数仅统计 pending。
- `failures` 在 SQLite 内按请求范围及当前数值 generation 筛选，最多读取 updatedAt 最新的 20 条说明，按时间顺序展示；时间相同时以 instance 排序保持稳定。历史失败行不删除，也不再全部加载进 Node 后截断。数值 generation 在完整 backend 重启后可能复用，所以该筛选不是跨 backend 生命周期的严格隔离，仍可能重放最多 20 条旧说明；它不参与响应授权。
- `POST /api/pending-approvals/:requestId/respond` body 为 `{ instanceId, result, clientId? }`。
- Socket.IO `codex.serverResponse` 为 `{ id, instanceId, result }`，走同一校验和 CAS。

Live 请求还包含 `generation`、`reviewSubject`、`presentation`、`negativeOnlyReason`。后两项描述后端完整校验过的交互，不能让浏览器从无法理解的字段里自行推断授权。

`conversation.pending.resolved` 包含 `{ instanceId, generation, requestId, threadId, status }`，其中 status 也可为 submitted。原始 `serverRequest/resolved` 通知没有 WebUI instance，因此浏览器不直接用它按裸 requestId 解决卡片。

`codex.serverRequestFailed` 为 `{ instanceId, threadId, turnId, message }`。它独立记录客户端失败，不修改 turn 的 active/completed 状态。带 thread 的说明持久化在请求表，且重复恢复不会重复插入系统消息。无 thread 的账号失败即时显示，错误答复留在脱敏 wire log；其后实际 turn 错误仍由原有 turn-error 路径保存。

## 命令与文件审批

命令通常在 execution item 内联审批。只有可证明相同的原始动作才去重；子命令、writeStdin 和网络单独主体必须显示自己的授权内容。wrapper-stripped 显示文本不用于判定相同命令。

命令支持 accept/acceptForSession/decline/cancel 及服务器提供的 exec/network policy amendment。提交的复杂 decision 必须完整匹配原请求提供的选项，不能让浏览器自由构造持久规则。未知授权语义或缺失主体限制为 Decline/Cancel。

`availableDecisions` 已由 pinned README 描述，在同 tag Rust 协议中标为 experimental，因此普通生成导出没有该字段也不能视为不存在。MCP 的 `enumNames` 与数组 items 的 `anyOf` 则均在当前生成类型中。

文件 approval 的主体从 live item 捕获并归属于请求，包含每个文件、diff、对象 union 的操作种类与 rename 目标。它独立于 turn diff，也不借用历史缓存：测量表明等待审批的 file item 可能不在历史中。

主体一旦发布不再由后续 item 改写；item completion 仅释放候选，不清除等待中的 request subject。REST/live 返回隔离副本。主体缺失或不能完整解析时仍提供否定操作，两个响应入口都禁止接受不可见文件变更。Backend 重启使旧请求失效，因此主体不另建跨重启持久化层。

## 权限请求

`permission-interaction.ts` 识别完整 network/filesystem profile：

- literal path、glob pattern、已知 special scope 与 project-root subpath 分别显示；
- read/write 是可选授予项，deny 约束固定显示且不能移除；
- filesystem grant 保留原 deny entries 与 glob scan depth；
- 未知 scope、字段或 access 类型禁止任何授予，仍可拒绝。

浏览器提交 `result: { selected: string[], scope: "turn" | "session" }`。selected 只能引用 presentation 的可选 ID，不能携带自造路径。后端从原参数编码 app-server 的 `{ permissions, scope }`。未选权限不授予，session checkbox 默认为关闭；Decline 编码为空 grant，不能被解释为命令 approval 的简单 decision。

## MCP elicitation

`elicitation-interaction.ts` 在 admission 时判断整个 schema 是否可解释：

- 支持 string/number/integer/boolean、普通及 titled enum、multi-select enum；
- 校验 required、数值界限、字符串长度/format、数组数量与有限选项；
- 拒绝未声明字段、错误类型及未提供的枚举值；
- `openaiForm` 与 `openai/form` 中未知语义得到明确 unsupported 状态，没有部分表单或通用 Accept，仅 Decline/Cancel；
- URL 仅展示可显式打开的 HTTP(S) 地址，不代替用户访问，不把打开地址视为完成；用户另行 Continue 才答复。

浏览器提交 `{ action, content }`，后端验证后编码 `{ action, content, _meta: null }`。负面 action 的 content 必须为 null。表单失败保留草稿，不能静默清卡。

`turnId` 可以为 null。权限与 MCP 卡片用独立的 `interaction` timeline row，以 instance 为 key，不伪造 turn ID，也不因缺少历史 item 而消失。

## 多浏览器、删除与恢复

所有已认证浏览器接收 attention；thread room 只选择转录观看者。创建、回复、原生解决、失败和过期不依赖观看房间。

删除守卫期间照常保留请求但暂不广播。涉及删除的 pending 读取返回 409，不能把隐藏部分行的结果当完整集合。删除中止后只重放同一个仍 pending 的 instance；删除成功后取消 authority，旧抑制副本不复活。

恢复读取保留在途期间的新请求和已观察到的提交/退休状态。旧 HTTP 回调不能解决新 instance，旧 snapshot 不能重开已回答请求。网络错误只触发权威读取，不重试决定。

## 实现位置与验证

| 文件 | 责任 |
| --- | --- |
| `src/codex/server-request-owner.ts` | 开放 wire method、穷尽 disposition、原连接答复与退休 |
| `src/pending-approvals/pending-approvals.service.ts` | admission、不可变持久化、CAS、failure 与恢复 |
| `src/pending-approvals/human-request-contract.ts` | 可答复参数与 method-specific 响应校验 |
| `src/pending-approvals/permission-interaction.ts` | 完整权限显示及原始 grant 编码 |
| `src/pending-approvals/elicitation-interaction.ts` | MCP schema 和答复校验 |
| `web/src/hooks/use-request-response.ts` | 所有卡片共用的 instance-bound 提交 |
| `web/src/components/chat/turn-items/interaction-card.tsx` | 权限、MCP 表单与 URL 表面 |
| `web/src/lib/pending-approvals-sync.ts` | pending/submitted/failed 的恢复与去重 |

协议依据是 pinned README、参考客户端及 `server-request-disposition`、`auth-token-refresh`、`server-request-identity` probes。单元/集成测试覆盖未知方法、无 owner、invalid payload、数据库失败、传输失败、两浏览器竞争、同 generation/id 新 instance、nullable MCP、schema 边界和非空数据库迁移。JSON-RPC 拒绝的实际 turn outcome 由 app-server 决定，不由 WebUI 合成。
