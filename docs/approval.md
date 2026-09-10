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
  → 文件审批先关联完整 reviewSubject，再写入并发布；原始 params 不变
  → 若 thread 正在删除则仍记为 pending、但不广播（含主体暂存，守卫释放时按需重放）；否则 Socket.IO emit 'codex.serverRequest' to authenticated room
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

## Global attention contract

Room membership selects transcript consumers only. Human requests are emitted
once to the authenticated audience on `/ws`, without joining a thread room or
resuming a conversation. The original `codex.serverRequest` fields remain intact:

```ts
{
  id: number | string; // original JSON-RPC ID
  method: string;
  params: Record<string, unknown>; // unchanged upstream parameters
  generation: number;
  reviewSubject: {
    type: 'fileChange';
    changes: Array<{
      path: string;
      kind: { type: 'add' } | { type: 'delete' }
        | { type: 'update'; move_path: string | null };
      diff: string;
    }>;
  } | null;
}
```

Only `item/fileChange/requestApproval` needs the additional subject. Commands
(including `writeStdin` and network-only approvals), user-input questions,
permission requests, MCP elicitations and the legacy `applyPatchApproval` /
`execCommandApproval` requests carry their subjects in `params`, and use
`reviewSubject: null`. The explicit classification excludes dynamic tool calls,
account token refresh, attestation, current-time reads and unknown methods from
this gateway's human-request channel and pending inventory. It does not implement
a new responder for machine-facing requests. Backend delivery support does not
imply that every method already has a browser renderer.

The pinned `file-approval-context` probe observed one approval spanning two files
and the pending item absent from history while other items remained readable.
The backend therefore captures the preceding file item's **entire** change set,
preserving object-union kinds and rename destinations. Capture follows the
committed write, so a failed insert cannot overwrite the last committed subject
and a replacement row that captures nothing drops the previous one rather than
inheriting it. Both are synchronous, so no read interleaves before the hint.

That capture depends on `item/started` reaching the backend ahead of the approval
on the same wire, which is **observed rather than promised by the protocol**, so
it is not what liveness rests on. A missing item is logged as an error and the
request is published anyway with `reviewSubject: null` — never a fabricated
empty subject and never a history fallback. Withholding it instead would leave
app-server waiting on an answer no browser was ever offered.

A null subject on a file approval is therefore a state the protocol can reach,
and it is enforced rather than merely documented: `respondToRequest` refuses any
decision other than `decline` or `cancel` with HTTP 409
`approvals.subject_unavailable`. The check sits at the shared service boundary,
so the REST route and the legacy socket response path are both covered — a
client still drawing an Accept button cannot approve changes nobody could see.
Clients should present only Decline in that state; the backend does not rely on
them to. This is the same rule that forbids approving a change set rendered only
in part.

Only in-flight file proposals and pending request subjects are retained; item,
turn, thread and generation cleanup remove candidates, while a pending request
keeps its subject through deletion suppression until it is retired. Retention is
process-local because backend startup already expires all old RPC requests. No
database migration or durable transcript cache is required.

`GET /api/pending-approvals?threadIds=...` returns:

```ts
{
  generation: number;
  requests: Array<{
    generation: number;
    requestId: string;
    threadId: string;
    turnId: string | null;
    itemId: string | null;
    method: string;
    params: Record<string, unknown>;
    reviewSubject: FileChangeApprovalSubjectDto | null; // same subject as live
    status: 'pending';
    createdAt: number;
    updatedAt: number;
  }>;
}
```

Omitted/empty `threadIds` means all threads; supplied IDs restrict the complete
read scope. Times are Unix milliseconds. If any thread in that scope is under
deletion, the endpoint returns HTTP **409**, error code
`threads.delete_in_progress`, with **no snapshot**. It never returns a successful
partial list by hiding guarded rows. Clients retain their pending state on that
failure and refresh on the guard-release `conversation.pending.changed` hint.
An unrelated scoped read and global live delivery for other threads continue.
Internal deletion planning still reads the guarded rows. Releasing a guard
replays surviving requests with the same subject to the authenticated audience;
cancelled or expired requests, including reused IDs from another generation, are
not replayed.

Committed retirement emits `conversation.pending.resolved` globally:

```ts
{
  generation: number;
  requestId: string;
  threadId: string;
  status: 'resolved' | 'cancelled' | 'expired';
}
```

This covers successful CAS responses, upstream resolution, deletion cancellation,
child-generation expiry and startup expiry. A failed response write rolls back
without retirement or an invalidation. An upstream resolution following a local
response does not emit a duplicate retirement. `resolved` means no longer
answerable, **not accepted**, and says nothing about item execution success.
Existing per-room `codex.notification` delivery, including the raw
`serverRequest/resolved`, is retained for compatibility. Both content-free global
hints also remain; only the hints are sent at authentication, not request replay.

The browser must normalize live IDs with `String(id)` and scope identities by
generation. Generation is local to one backend lifetime, not a replay cursor.
Use the same idempotent ingestion for live and recovered requests, preserve local
answers/drafts, and let retirement defeat stale snapshots. Successful absence
resolves only requests held before the read and unchanged since then; newer
overlapping reads supersede older evidence. An error resolves nothing. The
backend contract is available now; browser ingestion and notification decisions
are separate integration work.
