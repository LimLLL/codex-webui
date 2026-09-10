# 模型目录管理

Pinned CLI 可以在 `turn/start` 返回 inProgress 后仍短暂报告 thread/read=idle。
后端因此同时使用本连接已发送工作的保留记录和上游状态查询。两者都是限定范围的
证据，**不证明同一 Codex home 上所有客户端已空闲**。

模型目录是完整替换文件。WebUI 不合并单条覆盖，不维护模板继承图，也不写上游
`models_cache.json`。隐藏模型选择是独立能力：`GET /api/models?includeHidden=true`
透传上游参数，前端不再二次过滤返回的 hidden 条目（折叠在开关后）。

## API

所有接口沿用 WebUI 身份认证。目录内容采用原始 JSON 字符串，避免表单往返丢失
未知字段、嵌套指令、显式 null 或格式。编辑器 UI 见文末「前端」一节。

| 方法 | 路径（`/api/codex/catalog` 下） | 请求 / 行为 |
|---|---|---|
| GET | `/` | `ready`、`startupError`、`configuredPointer`、`managed`、`pointerApplied`、`runningPaths`、`activation`、`repairError`；不要求 child 可用 |
| GET | `/draft` | `{content, warnings}`；无草稿时 content 为 null |
| POST | `/seed` | `{source: "bundled" \| "effective", expectedDraft}`；导出所有条目并保存草稿 |
| GET | `/effective` | 按当前配置重新解析完整目录；不是现有 child 内存的精确导出 |
| POST | `/validate` | `{content}`；只验证，不发布 |
| PUT | `/draft` | `{content, expectedDraft}`；expectedDraft 为上次读取的完整文本，无草稿时为 null |
| GET | `/blockers` | `{canApply, generation, blockers, scope, limitations}`；scope 固定为 managedAppServer；blocker 可含 processIds、requestMethod、turnId |
| POST | `/apply` | `{expectedDraft, expectedPointer}`；要求健康 child，确认空闲后发布并重启 |
| POST | `/default` | `{expectedPointer}`；仅清除仍指向 WebUI 托管文件的 user leaf，然后重启 |
| POST | `/restore` | `{expectedPointer}`；恢复上一 activation 的来源；child 停止时也可使用 |
| POST | `/restart` | 显式重试修复后的启动；child 正在运行时先检查活动工作 |

所有 POST 返回 200；冲突返回 409。Apply 拒绝时的标准错误 message 数组列出阻塞
会话和原因；`/blockers` 提供结构化列表。保存或应用前置文本/指针不匹配时要求重新读取。

`managed` 表示当前指针指向本后端拥有的槽位文件，也就是 `/default` 会接受的前提；
外部手写的指针 `managed:false`，此时不提供「使用默认目录」动作。

`pointerApplied` 与 raw config 保存返回的 `restartRequired` **使用同一判据**
（`matchesRunningCatalog`）：拿配置当前指向的东西和**运行中 child 实际加载的**
比，而不是和上一份文件比。按文件差异判断会让「改了指针、再存一次无关内容」的
第二次保存报 `restartRequired:false`，而 child 仍在跑旧目录；两处判据不一致则会
出现「提示你重启但面板不给按钮」。没有 child 时无从比较，返回 true。

UI 据此区分「已配置」「正在运行」「本后端托管」三件事，并且在没有 user-level
指针时只说「没有用户级覆盖」，不断言 bundled 目录正在生效——低层配置仍可能提供
目录，`runningPaths` 才是关于实际加载内容的唯一陈述。

**已知取舍**：目录来自更低配置层（如 profile）而无 user-level 指针时，
`matchesRunningCatalog(null)` 会判为不一致并提示重启，尽管重启后解析结果相同。
同步接口无法区分它与「指针刚被移除但尚未重启」，而后者是真需要重启的。提示文案
因此说「运行中的目录与配置当前指向的不一致」，不指责用户，且重启本身幂等。

清除 managed override 可能暴露低层配置中的外部目录，不保证最终来源就是 bundled。
删除最后一个自定义条目不会自动清除 override；官方条目也允许有意删除。首次 seed
保留完整导出（包括 hidden 和内部 review 模型），不只复制 picker 可见行。

## 原生验证与导出

**目录文件的读取本身也要有界**，而不只是解析有界。配置指针由用户控制，且在启动和
修复两条路径上都会被读——它绝不能反过来把负责修复它的服务器搞停。因此统一走
`readCatalogFile`：先 `stat` 拒绝非普通文件（FIFO / 设备节点会让读取无限期挂起且
没有超时）和超限大小，再**异步**读取，避免慢文件系统占住事件循环。

`CatalogNativeService` 用实际执行的 Codex binary 的 `debug models` 加候选目录配置，
执行真实上游反序列化。验证进程使用临时 CODEX_HOME、临时 cwd、独立配置且不继承
账户凭据。执行上限 20 秒，输入及合计输出上限 8 MiB；超时/输出超限杀掉并回收进程。
临时文件在调用结束后移除。entry schema、enum、指令必填规则不在 TypeScript 重写。
WebUI 另外检查非空 models、slug 和重复 slug；空指令给出 warning。

有效目录导出复制 user config、认证文件和现有模型缓存到临时 home；相对 user catalog
指针先转换为原配置目录下的位置。Codex 可刷新这个临时缓存，原缓存保持不变。导出
仍可能与已有进程冻结的目录不同；它不构成运行中进程的原子快照。

`docs/upstream/model-catalog-0.153.2.json` 是 pinned binary 的完整 bundled 导出，包含
11 个条目及指令。用 `pnpm codex:catalog` 刷新；升级 CLI 时一起修改脚本目标版本、
刷新文件及协议 README。保留 CODEX-LICENSE、CODEX-NOTICE。运行时从 binary 导出，
不依赖容器包含 docs 目录。

## 文件与激活

文件位于 `CODEX_HOME/webui/model-catalog/`：

- `draft.json` 是 `{content}` envelope，本身不能作为 upstream catalog。
- `catalog-a.json`、`catalog-b.json` 是两个完整目录槽位。当前引用文件不原地覆盖，
  下次候选只写未引用槽位，成功后保留此前工作的文件。应用前直接比较启动时内容；若外部修改了文件或切换了尚未重启的来源，先要求重启/修复。
- `activation.json` 仅记录 outcome（pending/accepted/reverted）以及 before/after
  user-level pointer，null 表示 leaf 缺失。没有整份 config 历史或额外校验指纹。

写入采用同目录临时文件、rename、文件和目录 fsync。保存草稿检查 user 配置中的
目录引用以及现有进程加载的引用，也拒绝符号链接/硬链接别名。配置 leaf 使用
`toml-eslint-parser` 的 AST source range 编辑，仅替换值或移除该赋值，保留无关
配置、注释与格式；正常激活仍用上游 `config/batchWrite` + expectedVersion。

顺序：验证候选 → 排他准入并确认空闲 → 写 pending → 写未引用槽位 → 条件修改
config pointer → flush → 停止旧 child → 初始化新 child 并检查 config/model-list →
写 accepted → 释放准入 → 通知 ready / 恢复会话。用户确认覆盖的是具体草稿与指针。

冷启动必须先处理 pending，再 spawn。未完成的应用被撤销，不会自动继续发布：
当前指针仍为 before 时保持原样，等于 after 时仅恢复该 leaf；若两者都不匹配，
保留外部改动并停在修复状态。恢复过程可重复执行。accepted 不因 HTTP 响应丢失撤销。

自动 rollback 只用于候选第一次启动的目录解析或目录读取拒绝。凭据、provider、
推理、超时等错误不触发它；恢复旧来源只尝试一次。外部文件仍归用户所有，Restore
前会重新验证，不能保证用户随后删改过的外部文件仍然可用。

## 活动检查与会话恢复

不使用 socket subscription registry 或 sidebar running 投影。检查所有页的
`thread/loaded/list`，逐个 metadata-only `thread/read`，active（包括 approval/input
等待）阻塞。再查 background terminals、active goal、queued submissions。

- WebUI 独立终端不属于 Codex child 生命周期；Codex background terminal 属于阻塞。
- 暂停 goal 不会打断当前 turn；需要分别处理。
- 队列接口没有 paused/runnable 标志；非空队列报告“无法确认空闲”，不称为 running。
- ephemeral thread 的 goal RPC 在 pinned binary 上被拒绝，同样报告无法确认空闲。
- 查询失败、进程 generation 改变、检查过程中 loaded set 改变均拒绝应用。

HTTP mutation interceptor 覆盖完整请求内的多步操作；Socket.IO 审批回复单独检查
准入。重启后的 auto-resume 自身也占用准入，且先恢复父线程再恢复 owner-controlled
子线程。恢复只调用 resume，并使用 `recordActive:false`；不重放 prompt 或启动 turn。
已有 lifecycle、approval generation expiry 和前端恢复消息保持使用。

### 已接收工作与终态

每个 `CodexJsonRpcClient` 拥有只记录本 stdio 连接发出请求的 `CodexAcceptedWork`。
发送前建立保留项，收到成功响应时绑定 thread/turn ID，HTTP 响应完成不释放它。
turn/start、review/start、thread/queue/start 在对应 turn/completed 的 completed、
failed、interrupted 终态释放；响应本身已是终态也可释放。早到的通知和超时后迟到的
响应在 transport 边界处理。明确的 invalid-request/invalid-params 拒绝移除本次预留；
超时、内部错误、传输结果不明不能证明未接收，继续拒绝应用。

本连接 queue/add 接收的提交通过 queuedSubmission 的 clientUserMessageId 对应
userMessage.clientId，跟踪自动出队后的 turn 至终态；明确删除尚未出队的提交也可
释放。外部 turn/goal 通知本身不会创建本地接收记录。

**compact/start 绑定到它自己开启的 turn**。该请求只返回 `{}`，没有可归属的
turn ID，因此曾经只能保守持有。对钉住的 app-server 实测后发现存在真正的归属证据
（顺序即实测所得）：

```
--- compact/start 已发送 ---
--- ACK 收到: {} ---
turn/started      turn.id = T
item/started      contextCompaction, turnId = T
item/completed    contextCompaction, turnId = T
turn/completed    turn.id = T, status = completed
```

手动压缩会**新开一个 turn**，其 `contextCompaction` item 带着这个 turn id。

关键在于「自动压缩会不会伪装成它」。读上游 0.153.2 源码确认（这一条只测不够，
必须看实现）：

- 四条**手动**路径（local `compact.rs`、`compact_remote`、`compact_remote_v2`、
  `compact_token_budget`）**全部**显式 `send_event(TurnStarted)` 再发 item，
  token_budget 的注释直说「manual compaction runs outside run_turn」。
- **inline 自动压缩**（`run_inline_auto_compact_task`）接收外层已在跑的
  `step_context`，**从不发 `TurnStarted`**。

所以「本连接观察到 started 的 turn」这个集合天然排除了自动压缩。绑定要求三个
条件**同时**成立，缺一不绑：

- turn 的 `turn/started` 在本次 ack **之后**被观察到（用单调序号比较）。这排除了
  跑在既有 turn 里的 inline 自动压缩。
- `contextCompaction` 是该 turn 的**第一个** item。这排除了「一个普通 turn 干到
  一半触发自动压缩」——普通 turn 会先发出 userMessage / agentMessage 等 item。
- 该 turn 尚未被认领。认领按 turn 生命周期一次性生效，因此一个 turn 永远只能
  释放一条预留，重复投递的 `item/started` 也不会绑第二条。

turn 记录按 `threadId + turnId` 存（turn id 只在 thread 内唯一），`turn/started`
幂等（重复上报不会给旧 turn 一个新序号），thread 关闭时按线程清理。item 不带
turnId、turn 未观察到 started（含超出上限被遗忘）、item 早于 ack 到达，**一律
不绑定**，该预留继续阻塞——歧义只会降为「无法确认空闲」，绝不因此放行。

绑定成功后就走普通的 `turn/completed` 终态路径，与 turn/start、review/start 共用
同一套逻辑，不再从 item 反推终态。

native 测试对钉住的 app-server 断言前提成立：ack 之后确实新开 turn、item 确实带
该 turn id、且预留确实先绑定后释放。上游哪天改了，测试会失败而不是静默退化。

**残余风险**：某个普通 turn 在 ack 之后开始，且它的**第一个** item 就是自动压缩
（pre-turn 自动压缩）。此时会误绑。该窗口内该 thread 上确有压缩在跑，且本地预留
只是上游状态查询的补充——真正的活动检查仍会看到运行中的 turn。

**仍然保守的两类**：`thread/shellCommand` 同样只返回空对象，但它「progress streams
through standard turn/item notifications」且没有专属 item 类型，与普通 turn 的
commandExecution item 无法区分，默认超时长达一小时；goal/set 激活后的自动
continuation 没有逐次 dispatch ID，暂停/清除 goal 不证明此前排入的工作已结束。
这两类继续报告“无法确认空闲”，直到观察到对应 thread/closed 或真实 child process
close。因此执行过 `!` shell 命令或启用过 goal 的会话即便看起来 idle，也可能仍被
拒绝目录应用；需要等待实际关闭/卸载，或由运维显式停止已有进程。没有定时过期、
TTL、清空记录按钮，也不会借 restart 端点强行绕过。相关诊断带 requestMethod，
不会伪称一个未知状态仍是正在运行的 turn。

**自动压缩不产生预留**：记录只在本连接主动 dispatch 时创建，codex 自身触发的
auto-compaction 不经过本客户端。

### 检查范围与外部客户端窗口

本地记录与 live RPC 互补：保留项封闭本连接接受请求后、状态尚不可见的窗口；上游
查询继续检查当前 child 的全部 loaded threads、等待、background terminals、goal 和
queue。检查前后都读取保留项，实际停进程前再次拒绝未终结的本地工作。

独立 CLI、其他 app-server、其它连接发出的请求不在本地记录的证明范围中，也不保证
出现在当前 child 的 loaded list。检查和实际切换之间，这些外部客户端仍可能开始工作；
Codex 自主调度也不是由 HTTP 准入冻结的。`canApply:true` 仅表示本次检查没有发现
当前托管进程的阻塞，不是全局 idle 或原子的 drain/freeze 保证。共享 Codex home 的
目录/配置改动还可能影响其他实例下一次启动，部署方应自行协调这些实例。

## 不依赖 child 的修复

`GET /api/codex/config/raw` 直接读解析出的 Codex home，不调用 config/read。
`PUT` 支持 expectedContent，写入前校验 TOML 和所引用的目录，返回 warnings、
restartRequired、reloaded。child 不可用时可修改/移除坏的 catalog pointer，再调用
`/catalog/restart`；有可用上一 activation 时可以 `/restore`。

Apply 要求当前 child 健康，以免把已损坏的当前目录写成新的“上一工作目录”。原始
编辑器 UI 独立于 structured config 查询渲染，因此 config/read 失败时仍可用。

启动失败不会让 Nest 退出。正常运行的 child 意外退出后仍延迟 3 秒尝试恢复；
一次性的启动故障（卷挂载稍晚、二进制短暂占用）同样按 3 秒重试，否则一个瞬时
问题会变成只能人工干预的永久宕机。**三类情况明确不重试**，保留诊断等待显式修复：

- 目录被拒（解析/读取失败）：确定性失败，重试只会空转。
- pending 恢复本身失败：恢复是 spawn 的前置条件，跳过它就会加载崩溃现场遗留的
  那份目录——正是这项检查要防的事。
- 旧 child 停止超时：进程可能还活着，再拉一个等于同一个 Codex home 上跑两个
  app-server，比停在原地更糟。这一条只是**推迟**而非放弃：该进程真正退出时补发
  一次，否则停止慢就等于永久宕机。`suspendRetries()`（离线修复）会连同这笔欠账
  一起清掉。

「意外退出」按 **child 逐个记账**，不是读共享的 controlled 标志：受控重启若在停止
阶段超时，`finally` 会清掉该标志，此后旧 child 真正退出时就会被误判为崩溃并触发
普通重启——那会在 activation 记录仍为 pending 时启动候选进程，绕过接受与回滚。
本管理器主动要求停止的 child 一律登记，其退出不触发自动重启。

启动失败后的 `stop()` 超时**不覆盖原始诊断**，只记日志：保留的 stderr 才是分类
依据，用「did not exit」顶替它会把一次确定性的目录拒绝重新变成重试循环。

正常实例不会被修复接口直接强杀：`/restart` 对运行中的 child 同样执行活动检查。

结构化和 raw config 保存都返回 model / review_model 的目录检查 warning：缺失精确
条目、可通过 prefix/namespace 继承、hidden、无法读取目录。托管目录的检查使用启动
时读取的内存副本，后续磁盘修改不会冒充已加载的新目录。

## 验证范围

单元测试使用临时文件和受控 RPC/lifecycle，覆盖条件写入、引用别名、崩溃边界、
准入、活动/未知状态、狭义 rollback、raw 修复和 warning。原生集成测试验证 pinned
导出一致性、真实 enum/指令拒绝、缓存不变、pending 冷恢复、启动失败后的修复、
ready 顺序和本地 HTTP provider 上的真实 active turn、inline review、manual compaction、
queue 自动出队与 goal 自动 continuation；不调用付费推理服务。
HTTP 集成覆盖真实启动失败后的认证/raw 修复、restart、seed、apply、hidden model list、
restore 以及 blockers 的 scope/limitations contract。

真实多 agent 自动调度与 approval/user-input 暂停组合未在集成环境复现；这些判据
有单元覆盖和 upstream status 实现依据。未做 Docker build 本地验证。

前端单元覆盖：字段推导（缺省/null/空字符串三态、未知上游字段的往返保真、嵌套对象经
JSON 编辑器往返）、条目按 slug 定位（重解析后替换、改名落回原行、条目消失报冲突、
新增时按 slug 覆盖）、草稿并发协调（脏草稿不被服务端内容顶替；并钉住「协调分不出
新旧」这一点，用以说明写入为何必须回填缓存）、条目非对象时的防御式解析。

后端新增覆盖：压缩 turn 绑定（ack 前已开始的 turn 不被认领、一个 turn 只绑一条、
普通 turn 中途压缩不绑、重复 `turn/started` 不刷新序号、跨 thread 同名 turn id 不
借用、无 turnId / 未观察到 started / item 早于 ack 均不绑定）、pending 恢复失败不
spawn、停止超时不拉起替代进程但在该进程真正退出后补发一次、本管理器主动停止的
child 退出后不自动重启。native 测试断言压缩确实新开 turn、item 带该 turn id、且
预留先绑定后释放。

**每条新测试都做过变异验证**：摘掉对应修复后必须失败，且逐条确认。这一轮就有两条
测试是「摘掉修复照样通过」的假测试——一条 hook 级并发测试（wrapper 每次渲染新建
QueryClient，TanStack 通知时序在 renderHook 下不可靠，已改为纯函数测试），一条跨
thread 用例（被另一个守卫掩盖，重写后才真正命中）。测试通过本身不算证据。

原测试表中尚未覆盖的部分：修复页错误状态渲染；浏览器
composer draft/branch selection 的跨重启恢复；真实多设备网络竞态与多 agent ownership
恢复（当前为受控 Promise/父子顺序测试）；真实断电和 fsync/磁盘满故障。文件测试模拟
了各个 publication/pointer/outcome 崩溃状态，但不等价于硬件级断电测试。

## 前端

设置 → Codex 下方的「模型目录」区块（`web/src/components/settings/catalog/`）。

**草稿与应用分离**：所有编辑只改草稿，草稿文件永远不是运行中进程加载的那个。
「应用并重启 Codex」是独立按钮，且在有阻塞工作时由后端拒绝。

**表单字段从模板派生**，不是硬编码清单。上游 `ModelInfo` 有约四十个字段且会随
CLI 升级增加；写死清单会在升级后静默停止暴露新字段，而表单往返时丢弃未知字段
等于悄悄改掉模型。字段类型也从模板取值推断，因此本项目从未见过的字段照样可编辑。
`applyField` 区分「缺省 / null / 空字符串」——三者在上游语义不同，空输入清成 null
或删除该键，绝不写入 `""`。

**新增条目必须先选模板**，整份复制（一次性拷贝，不是活引用）。这不只是便利：
上游会拒绝既无 `base_instructions` 又无 `model_messages.instructions_template` 的
条目，而 `visibility` / `supported_in_api` 等字段直接决定模型能否被选中。

**表单中途输入按原文保留**。半个数字、写到一半的对象都还不能解析，若此时回退渲染
上一份已解析的值，这一次按键就被撤销了——JSON 和数字字段会因此完全无法逐字符编辑。
字段定义取自「打开时的条目 + 模板」而非实时草稿，否则清空一个字符串会让它的编辑器
在编辑途中变成 JSON。对话框每次打开都重置，取消后重开同一条目不会续上被放弃的草稿。

**条目按 slug 定位**，不用对象身份：文档每次渲染都重新解析，对话框持有的条目和列表
里的永远不是同一个对象，身份查找必然落空并悄悄丢弃这次编辑。改名仍落在原来那行；
若该条目已被（多半是从裸 JSON 编辑器）删除，报冲突而不是静默追加一条。

**草稿并发**：`committed` 是每次写入的前置条件，绝不能在有未保存改动时被另一个浏览器
的内容顶替——那会让下一次保存带着新前置条件和旧内容通过校验，覆盖掉对方的改动。
草稿干净时才采纳服务端版本，脏的时候保持原样，让分歧按设计变成 409。保存成功后只
替换「确实发出去的那段文本」，请求在途中敲的字不会被丢掉。

拒绝覆盖只是设计的一半：基线此时是**故意过时**的，若不给出路，之后每次保存和 seed
都会永远撞前置条件。因此检测到服务端草稿与基线不一致且本地有改动时，明确提示并提供
「放弃我的改动、载入已保存的草稿」。该动作用 `staleTime: 0` 强制真读（默认缓存会
把用户想逃离的那份内容原样返回，按钮看起来毫无反应），在保存/seed 在途时禁用（否则
较早的响应会在采纳之后把基线改回去，冲突原地复现），失败会显示错误而不是吞掉 promise。

**写入必须把自己的结果写回查询缓存**。协调逻辑只能看出「不一样」，分不出新旧：保存
成功后本地基线已推进，而缓存里还是保存前的内容，此时协调判定为「干净且有差异」，
立刻把编辑器回滚到刚被替换掉的那份。`reconcileDraft` 有一条专门钉住这个行为的测试，
说明为什么缓存写入是必需的，而不是顺手优化。

**裸 JSON 编辑器**与表单编辑同一份文档，默认折叠，带明确风险提示。校验按钮调用
后端的原生校验（pinned binary），不做客户端 schema 判定。文档是合法 JSON 但条目
不是对象（如 `{"models":[null]}`）时，结构化列表退让并提示改用 JSON 编辑器修复，
文档本身不动。

**阻塞列表**逐条给出真正能解除它的动作，并渲染后端返回的 `limitations`。其中两类
明确说明没有应用内出路：`thread/shellCommand` 和已激活的 `thread/goal/set` 在上游
都没有终态信号，而本应用不会向上游发送 thread 关闭——暂停 goal 或在浏览器里关掉
会话都不解除预留，只有 Codex 卸载该会话或进程重启才行。写「暂停 goal 后再检查」
这类无效指引比不写更糟。

**修复入口在失败状态下必须可达**：`config/read` 失败正是需要裸 TOML 编辑器的时候，
因此它独立于结构化配置查询渲染（`raw-config-editor.tsx`）。关键是它在**所有状态下
占据同一个树位置**——按 loading / error / success 分别 early-return 会让它卸载重挂，
而卸载会丢掉用户正在写的 TOML，恰恰发生在读取失败、最需要它的时候。退让的是结构化
区块，不是它。

**「重启 Codex」不能只挂在错误分支**：通过裸配置改掉 catalog 指针后 child 完全健康，
却仍需重启才生效。因此该动作同时出现在启动失败块和「已配置但未生效」提示里，用的是
同一个 `/catalog/restart`（后端照常先做活动检查）。裸配置保存后一并失效目录状态查询，
否则「已配置 / 正在运行」的判断会停留在写入之前。目录相关 mutation 用 `onSettled`
刷新——失败的激活同样可能改变指针、activation 记录或启动诊断。
「恢复上一份」的显示条件与后端前置条件一致（`outcome !== 'reverted'` 且
`after === 当前指针`）——失败的激活留下的是 `pending` 记录，把它排除掉恰好会在最
需要恢复的状态下藏起这个出口。

**配置保存如实反映响应**：`restartRequired` / `reloaded` 决定提示文案，不再一律
宣称「已保存并重新加载」；裸保存带上 `expectedContent` 前置条件。目录检查 warning
（配置的 model / review_model 不在目录中）在**两条**保存路径都显示；结构化路径的
warning 由写入响应产生，而保存后的失效会重新拉取一个不带 warning 的读取，因此必须
单独留存，否则这条正是本功能要提示的信息会一闪即逝。

**模型选择器**改为请求 `includeHidden`，隐藏模型折叠在开关后；若当前生效模型本身
是隐藏的，它始终出现在列表里——否则用户看不到自己在跑什么，也切不回去。
