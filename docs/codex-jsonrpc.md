# Codex JSON-RPC Client 实现文档

## 概述

`src/codex/codex-jsonrpc-client.ts` 实现了与 codex app-server 的 stdio JSON-RPC 通信。协议基于 JSON-RPC 2.0 但省略 `jsonrpc: "2.0"` 字段。

## 消息格式

### 发送（client → server）

```json
{ "method": "thread/start", "id": 2, "params": { ... } }   // request
{ "method": "initialized", "params": {} }                    // notification (no id)
{ "id": 99, "result": { "approved": true } }                 // server request response
```

### 接收（server → client）

三种消息通过 `handleMessage()` 中的字段检测区分：

| 类型 | 识别方式 | 处理 |
|------|----------|------|
| Response | 有 `id` + (`result` 或 `error`) | resolve/reject pending promise |
| Server Request | 有 `id` + `method` | emit `serverRequest` 事件 |
| Notification | 有 `method`, 无 `id` | emit `notification` 事件 |

## 错误处理

RPC 错误响应包含 `{ code, message, data? }`。`handleMessage()` 会抛出 `CodexRpcError`，保留 `code`、`data`、`method`、`requestId` 与原始 app-server message。`CodexService.getClient()` 在 app-server 未连接时抛出 `CodexUnavailableError`。

`AllExceptionsFilter` 将这两类错误映射为稳定 HTTP 错误：

- `CodexUnavailableError` → 503 + `codex.server_unavailable`
- `CodexRpcError` → `-32600` 映射 400，其它 RPC code 映射 502，统一使用 `codex.rpc_error` 并带 `rpcCode`

线程相关 predicate 集中在 `src/threads/thread-errors.ts`，用于区分未 materialized、实验 fork boundary 不支持、非法 fork boundary、删除有后代失败等情况。

## 请求关联

- `nextId` 自增分配 request id
- `pending` Map 存储 `{ resolve, reject, timer }`
- 默认 30s 超时，超时后自动 reject 并清理

## 进程管理 (CodexProcessManager)

- `onModuleInit` 时 spawn `codex app-server --listen stdio://`
- 执行 `initialize` → 等 response → 发 `initialized` notification
- 进程退出时 3s 后自动重启
- `addListener()` 注册的事件监听会跨重启保留

## JSONL 审计日志

所有消息写入 `logs/codex-jsonrpc.jsonl`，每行格式：

```json
{"ts":"2026-05-10T14:20:25.123Z","dir":"out","msg":{"method":"thread/start","id":2,"params":{...}}}
{"ts":"2026-05-10T14:20:25.456Z","dir":"in","msg":{"id":2,"result":{...}}}
```

- `dir: "out"` = 发往 app-server
- `dir: "in"` = 从 app-server 接收
- 可直接用 Python `json.loads()` 逐行解析

## 初始化握手

```
client → initialize { clientInfo, capabilities: { experimentalApi: true, requestAttestation: false } }
server → { id: 1, result: { userAgent, codexHome, platformFamily, platformOs } }
client → initialized {}  (notification, no id)
```

## 关键注意事项

- `process` 参数名与 Node.js 全局 `process` 冲突，日志相关代码用 `globalThis.process.cwd()`
- WriteStream 用 append 模式，进程重启不覆盖
- 进程 close 时清理所有 pending promise 并关闭 log stream
