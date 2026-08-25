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
  → runtime parsers 校验 availableDecisions/amendments（lib/approval-parsers.ts）
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
| `item/commandExecution/requestApproval` | 命令执行                 | command, cwd, reason, availableDecisions, proposedExecpolicyAmendment, proposedNetworkPolicyAmendments |
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

- **Legacy 兼容**：旧版 app-server 不发送 `availableDecisions` 时，仅显示 accept/decline（deny-by-default）
- **Session 级授权**：`acceptForSession`/`cancel` 需要服务端显式提供
- **Amendments 不可自由构造**：exec/network policy 修正内容来自服务端 `proposed*` 字段，用户只能选择接受

## 前端文件

| 文件                                              | 作用                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `types/approval.ts`                               | ApprovalRequest, UserInputRequest, UserInputQuestion, UserInputOption 类型       |
| `lib/user-input-parsers.ts`                       | 防御性解析 requestUserInput payload（userInputFromSocket, userInputFromPending） |
| `stores/timeline-store.ts`                        | approvals 按 itemId 索引，userInputRequests 按 requestId 索引                    |
| `hooks/use-codex-socket.ts`                       | 监听 `codex.serverRequest`，分发 approval / userInput / snackbar                 |
| `components/chat/turn-items/approval-item.tsx`    | 命令执行审批卡片，动态按钮 + proposed amendments 展示                            |
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

- 审批状态以 `itemId` 为 key 存储，因为一个 item 对应一个审批请求
- **用户输入请求以 `requestId` 为 key 存储**，防止同 item 多请求覆盖；渲染时按 itemId 从 values 查找
- 切换 thread 时清空 approvals/userInputRequests 状态
- server request 的 `id` 必须原样回传，app-server 靠它关联响应
- `serverRequest/resolved` 通知 → 按 requestId 匹配 approvals 或 userInputRequests → 标记 resolved
- `pendingResolvedRequestIds` 处理乱序到达：resolved 先于 hydrate 时暂存，hydrate 时自动标记
- 删除中的 thread 会拒绝新的审批响应；相关 pending 请求由删除执行器标记为 `cancelled`
- **抑制必须可逆**：删除期间到达的 server request 只是不广播，DB 行保持 `pending`，并由 gateway 暂存。删除守卫释放时（`ThreadDeletionRegistryService.onRelease`）逐条比对 DB：仍为 `pending` 的重放到 thread room，已 `cancelled` 的丢弃。判据用 DB 状态而非删除结果，因为被真正删掉的 thread 其请求必然已在本地清理阶段取消 —— 这样重放天然不会为已消失的会话弹出卡片
