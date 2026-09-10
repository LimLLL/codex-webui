# Approval 审批流实现文档

## 概述

当 Codex agent 需要执行命令或修改文件时，app-server 发送 server request 请求用户审批。后端先持久化到 SQLite（`pending_server_requests` 表），再通过 Socket.IO 推送给前端。用户操作后通过 REST CAS 接口响应，确保多设备场景下只有第一个 pending 请求能被处理。删除会话时，仍处于 pending 的请求在该会话真正被中断或删除后转为 `cancelled`。

## 数据流

```
codex app-server (server request, 有 id)
  → CodexJsonRpcClient.handleMessage() 识别为 server request
  → emit('serverRequest', msg)
  → CodexProcessManager event listener
  → ThreadsGateway.handleCodexServerRequest()
  → PendingApprovalsService.recordServerRequest() 写入 pending_server_requests
  → 若 thread 正在删除则仍记为 pending、但不广播（暂存内存，守卫释放时按需重放）；否则 Socket.IO emit 'codex.serverRequest' to thread room
  → 前端 useCodexSocket 监听
  → 共享 runtime parser 校验 kind / approvalId / identities / availableDecisions / amendments（lib/approval-parsers.ts）
  → addApprovalForThread() 写入对应 thread runtime
  → 非当前 thread 时弹 snackbar + jump-to-thread
  → ApprovalItem / FileChangeItem 组件渲染审批卡片
  → 用户选择操作
  → POST /api/pending-approvals/:requestId/respond
  → PendingApprovalsService.respondToRequest()
  → SQLite 事务: CAS status=pending → resolved (changes===1)
  → CodexJsonRpcClient.respondToServerRequest(id, result)
  → app-server stdin
```

## 审批类型

| Server Request Method                   | 审批类型                 | 关键参数                                                                                               |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `item/commandExecution/requestApproval` | 命令执行 / 终端输入      | kind (`command`/`writeStdin`), approvalId, command, cwd, reason, availableDecisions, proposedExecpolicyAmendment, proposedNetworkPolicyAmendments, additionalPermissions, networkApprovalContext |
| `item/fileChange/requestApproval`       | 文件变更                 | reason, grantRoot                                                                                      |
| `item/tool/requestUserInput`            | 用户输入（EXPERIMENTAL） | questions: [{id, header, question, isOther, isSecret, options}]                                        |

## 可用决策 (Decisions)

### 命令执行 (CommandExecutionApprovalDecision)

| Decision                        | UI 按钮                 | 说明               | 显示条件                                                           |
| ------------------------------- | ----------------------- | ------------------ | ------------------------------------------------------------------ |
| `accept`                        | Accept                  | 接受这一次         | 默认显示 / `availableDecisions` 包含                               |
| `acceptForSession`              | Accept for session      | 本次会话全部接受   | 仅 `availableDecisions` 显式包含时显示                             |
| `decline`                       | Decline                 | 拒绝               | 默认显示 / `availableDecisions` 包含                               |
| `cancel`                        | Cancel                  | 取消操作           | 仅 `availableDecisions` 显式包含时显示                             |
| `acceptWithExecpolicyAmendment` | Accept with exec policy | 接受并加入命令模式 | `availableDecisions` 包含 + `proposedExecpolicyAmendment` 非空     |
| `applyNetworkPolicyAmendment`   | Apply (每条规则)        | 应用网络策略规则   | `availableDecisions` 包含 + `proposedNetworkPolicyAmendments` 非空 |

### 文件变更 (FileChangeApprovalDecision)

| Decision           | UI 按钮            | 说明             |
| ------------------ | ------------------ | ---------------- |
| `accept`           | Accept             | 接受             |
| `acceptForSession` | Accept for session | 本次会话全部接受 |
| `decline`          | Decline            | 拒绝             |
| `cancel`           | Cancel             | 取消             |

### 安全策略

- **可选 decisions**：未提供 `availableDecisions` 时，仅显示 accept/decline（deny-by-default）
- **Session 级授权**：`acceptForSession`/`cancel` 需要服务端显式提供
- **Amendments 不可自由构造**：exec/network policy 修正内容来自服务端 `proposed*` 字段，用户只能选择接受
- **Approval reviewer 配置**：`approvals_reviewer` / `apps.*.approvals_reviewer` 改变 app-server 将审批 review 路由给用户、automatic review 还是 guardian subagent；WebUI 只通过 Settings/Integrations 的二次确认控件写 config，不改变 approval request 的 REST 响应协议。

## 前端文件

| 文件                                              | 作用                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `types/approval.ts`                               | ApprovalRequest, UserInputRequest, UserInputQuestion, UserInputOption 类型       |
| `lib/user-input-parsers.ts`                       | 防御性解析 requestUserInput payload（userInputFromSocket, userInputFromPending） |
| `stores/timeline-store.ts`                        | approvals 与 userInputRequests 均按 requestId 索引，并为 request 所属 turn 保留时间线入口 |
| `hooks/use-codex-socket.ts`                       | 监听 `codex.serverRequest`，分发 approval / userInput / snackbar                 |
| `components/chat/turn-items/approval-item.tsx`    | 命令执行 / Terminal Input 审批卡片，动态按钮 + proposed amendments 展示          |
| `components/chat/turn-items/user-input-card.tsx`  | 用户输入卡片：radio/checkbox/text/password + submit                              |
| `components/chat/turn-items/file-change-item.tsx` | 文件变更审批（内联按钮，支持全部 4 种决策）                                      |
| `components/chat/turn-block.tsx`                  | ItemWithRequests：在对应 item 下方渲染审批/输入卡片；unattached 请求独立渲染     |

## 后端文件

| 文件                                             | 作用                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `codex/codex-jsonrpc-client.ts`                  | 识别 server request，提供 respondToServerRequest                                        |
| `threads/threads.gateway.ts`                     | 持久化 serverRequest，删除期间抑制广播并在守卫释放时重放，接收 serverResponse 透传回 app-server |
| `pending-approvals/pending-approvals.service.ts` | CAS 响应、generation expire、删除时取消 pending 请求并拒绝迟到响应                      |

## 审批卡片 UI 状态

| 状态                 | 边框颜色 | 标签                              |
| -------------------- | -------- | --------------------------------- |
| Pending              | 黄色     | (显示操作按钮)                    |
| Accepted             | 绿色     | "Accepted"                        |
| Accepted for session | 绿色     | "Accepted for session" (双勾图标) |
| Declined             | 红色     | "Declined"                        |
| Cancelled            | 橙色     | "Cancelled"                       |
| Resolved             | 灰色     | "Resolved" (服务端已处理)         |

## User Input Request 流程（EXPERIMENTAL）

```
app-server → item/tool/requestUserInput (questions[])
  → PendingApprovalsService.recordServerRequest() (泛型，无需区分)
  → Socket.IO → use-codex-socket handleCodexServerRequest
  → userInputFromSocket() 解析 → store.addUserInputRequestForThread()
  → UserInputCard 渲染 (radio/checkbox/text/password)
  → 用户 submit → pendingApprovalsRespond REST
  → PendingApprovalsService.respondToRequest() → app-server
```

响应格式: `{ answers: { [questionId]: { answers: string[] } } }`

## 注意事项

- **所有阻塞请求都以 JSON-RPC `requestId` 为 key 存储。** 同一个 command item 可先收到 `kind: command`，之后再收到一个或多个 `kind: writeStdin` 回调；按 itemId 存储会互相覆盖。
- `approvalId` 是 app-server 提供的审批身份并原样保留用于显示/诊断；实际响应仍必须使用 JSON-RPC `requestId`。
- `writeStdin` 的 `itemId` 指向原 command item，但 `turnId` 是当前回调所在 turn，两者可以不同。渲染按 request 的 turn 归属：同 turn 的卡片附着到 item；item 不在当前 turn 时作为 unattached Terminal Input Approval 卡片显示，不修改原 command 的完成状态。
- live socket 与 SQLite 恢复共用同一个 approval parser，避免刷新前后把 `writeStdin` 解释成不同类型。
- 切换 thread 时清空 approvals/userInputRequests 状态
- server request 的 `id` 必须原样回传，app-server 靠它关联响应
- `serverRequest/resolved` 通知 → 按 requestId 匹配 approvals 或 userInputRequests → 标记 resolved
- `pendingResolvedRequestIds` 处理乱序到达：resolved 先于 hydrate 时暂存，hydrate 时自动标记
- **响应必须用 `throwOnError: true` 发出。** 生成的客户端默认以 `{ data, error }` 解析而不抛出，且本项目的 error interceptor 是 `return error` 而非 `throw`，所以失败的响应（另一台设备先答的 409、app-server 重启期间的 503）会照常走进 `.then()`，把卡片标成 Accepted 而服务端什么也没做。响应失败的请求保持未解决，等待权威证据。
- 删除中的 thread 会拒绝新的审批响应；相关 pending 请求由删除执行器标记为 `cancelled`
- **抑制必须可逆**：删除期间到达的 server request 只是不广播，DB 行保持 `pending`，并由 gateway 暂存。删除守卫释放时（`ThreadDeletionRegistryService.onRelease`）逐条比对 DB：仍为 `pending` 的重放到 thread room，已 `cancelled` 的丢弃。判据用 DB 状态而非删除结果，因为被真正删掉的 thread 其请求必然已在本地清理阶段取消 —— 这样重放天然不会为已消失的会话弹出卡片

## Backend payload fidelity

SQLite persistence and websocket forwarding retain request params unchanged, including experimental `additionalPermissions` and network-only `networkApprovalContext`. Filesystem access modes and structured paths survive REST recovery intact.

A **special** filesystem path is an object union in the pinned schema — `root`,
`minimal`, `project_roots` with a sub-path, `tmpdir`, `slash_tmp`, `unknown`
with its own path — and never a string. A client testing it for a string
therefore discards every structured scope, and an overlay whose only entry was
one collapses to null and vanishes from the card entirely. The scope tag is the
security-relevant part (`root` and `tmpdir` authorize very different things) and
is parsed and rendered rather than flattened to the word "special". Omitted network permission data remains unspecified; it is never normalized to unrestricted access. Backend contract tests cover both transports. See [thread-policy-recovery.md](thread-policy-recovery.md).

## Startup and reconnect recovery

`pending-approvals-sync.ts` reconciles approvals and user-input requests with the
backend pending set. Absence is resolution evidence only for requests held
before the read and unchanged since then. Existing cards keep their decisions;
new events cannot be cleared by an older empty snapshot. A scoped sync changes
only those conversations, including when it supersedes an older overlapping
read. This does not infer which decision another device made: recovered
resolution stays neutral (`resolved`).

## Global pending discovery

`conversation.pending.changed` on `/ws` carries only `{ generation }` and reaches
authenticated clients independently of conversation rooms. It requests a fresh
pending-set read after committed creation/resolution, cancellation, and expiry
(including backend startup). Failed response transactions emit nothing. Creation
held by deletion defers the hint until guard release. Existing persistence, CAS
responses, suppression and request-time reconciliation remain the authority.
See [conversation-recovery.md](conversation-recovery.md).
