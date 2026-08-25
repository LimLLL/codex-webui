# REST API 实现文档

## 概述

所有 REST 端点在 `/api` 前缀下。Swagger UI: `GET /api/docs`。OpenAPI JSON: `GET /api/docs-json`。

## 错误响应

所有 HTTP 错误统一返回 `{ statusCode, errorCode, message, params? }`。`AllExceptionsFilter`（全局注册）负责标准化：

- `BusinessException`：携带稳定 `errorCode`（如 `files.path_not_found`）+ 可选 `params`（i18n 插值参数）。
- `CodexRpcError` / `CodexUnavailableError`：分别映射为 `codex.rpc_error` / `codex.server_unavailable`，保留 RPC code 供客户端区分实验字段、非法边界、服务不可用等。
- 其他 `HttpException`：按 HTTP 状态映射到 `http.*` fallback code（400→`http.bad_request`，404→`http.not_found` 等）。
- 未知异常：`500` + `http.internal_error`。

前端通过 `getApiErrorMessage()` 提取 `errorCode` → `t('error.${errorCode}', { defaultValue: message, ...params })`，优先显示翻译，无翻译时回退英文 message。错误码定义见 `src/common/error-codes.ts`，翻译见 `web/src/locales/zh-CN.json`。

## 已实现端点

### App

| Method | Path          | Controller    | 说明                              |
| ------ | ------------- | ------------- | --------------------------------- |
| GET    | `/api/status` | AppController | 健康检查, 返回 `{ status: "ok" }` |

### Codex Status

| Method | Path                | Controller            | 说明                                                                                                                                                                                                           |
| ------ | ------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/codex/status` | CodexStatusController | 聚合状态：appServer/initialize/account/config/provider/models/runtime。30s TTL 缓存，5s unavailable。Runtime rollup: ready/degraded/unavailable + reasons。Provider env key 优先从 config.model_providers 读取 |

### Codex Config

| Method | Path                    | Controller            | 说明                                                                                                                                   |
| ------ | ----------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/codex/config`     | CodexConfigController | 读取完整 Codex config + origins（includeLayers:true），bigint→number，敏感字段 redaction                                               |
| PATCH  | `/api/codex/config`     | CodexConfigController | 结构化编辑 curated config 字段（allowlist 14 个 key）。Body: `{ edits: [{ keyPath, value }] }`。写 user config.toml + reloadUserConfig |
| GET    | `/api/codex/config/raw` | CodexConfigController | 读取 user config.toml 原始内容，返回 `{ filePath, content }`                                                                           |
| PUT    | `/api/codex/config/raw` | CodexConfigController | 替换 user config.toml 内容并触发热加载。Body: `{ content }`                                                                            |

**Allowlist**: profile, model, review_model, model_provider, model_context_window, model_auto_compact_token_limit, instructions, developer_instructions, compact_prompt, model_reasoning_effort, model_reasoning_summary, model_verbosity, web_search, service_tier

### Account

| Method | Path                        | Controller        | 说明                                                                    |
| ------ | --------------------------- | ----------------- | ----------------------------------------------------------------------- |
| GET    | `/api/account`              | AccountController | 读取 account/read，并附带 provider id/name/masked base URL/env key 状态 |
| POST   | `/api/account/login`        | AccountController | 启动 API Key / ChatGPT / device-code 登录                               |
| POST   | `/api/account/login/cancel` | AccountController | 取消 pending ChatGPT 登录                                               |
| POST   | `/api/account/logout`       | AccountController | 登出 app-server 维护的 Codex account                                    |
| GET    | `/api/account/rate-limits`  | AccountController | 读取 ChatGPT rate limits 与 credits；API proxy 模式可能不可用           |

### Threads

| Method | Path                                             | Controller                | 说明                                                                                                                 |
| ------ | ------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/threads`                                   | ThreadsController         | 创建新 paginated history thread。Body: `{ model?, cwd?, approvalPolicy? }`                                           |
| GET    | `/api/threads`                                   | ThreadsController         | 列表。Query: `cursor, limit, archived, searchTerm, cwd, sortKey`                                                     |
| GET    | `/api/threads/loaded`                            | ThreadsController         | 列出 app-server 内存中加载的 thread IDs。Query: `cursor, limit`。用于 refresh recovery                               |
| GET    | `/api/threads/branch-trees`                      | ThreadsController         | 列出本地已知的消息级分支树                                                                                           |
| GET    | `/api/threads/branch-adoption/status`            | ThreadsDeletionController | 读取启动期外部分叉认领扫描器状态、计数和诊断；删除 preview/execute 均受该状态门控                                    |
| GET    | `/api/threads/:threadId`                         | ThreadsController         | 读取单个 thread。Query: `includeTurns`                                                                               |
| GET    | `/api/threads/:threadId/branch-state`            | ThreadsController         | 读取 compact guard 状态与持久化树成员。包含本地创建和启动期认领的拓扑，不做每请求 app-server 扫描                    |
| GET    | `/api/threads/:threadId/branch-tree`             | ThreadsController         | 读取 thread 所在本地分支树                                                                                           |
| GET    | `/api/threads/:threadId/delete-preview`          | ThreadsDeletionController | 预览删除该 thread 及所有 fork 后代：返回确认用 id 集、叶到根删除顺序、运行中会话、待审批、扫描器诊断与 blocker       |
| POST   | `/api/threads/:threadId/delete`                  | ThreadsDeletionController | 按确认过的 `expectedThreadIds` 执行级联删除；执行前和自动中断后重新规划，id 集漂移时返回结构化 conflict/partial 结果 |
| POST   | `/api/threads/:threadId/resume`                  | ThreadsController         | 恢复 thread, 返回含 turns 历史                                                                                       |
| POST   | `/api/threads/:threadId/archive`                 | ThreadsController         | 归档本地已知整棵分支树                                                                                               |
| POST   | `/api/threads/:threadId/unarchive`               | ThreadsController         | 取消归档本地已知整棵分支树                                                                                           |
| POST   | `/api/threads/:threadId/compact`                 | ThreadsController         | 压缩上下文；有本地后代时返回 conflict                                                                                |
| POST   | `/api/threads/:threadId/branches`                | ThreadsController         | 编辑历史 user message：`thread/fork(beforeTurnId)` 后持久化分支拓扑                                                  |
| POST   | `/api/threads/:threadId/fork`                    | ThreadsController         | 普通 fork，不写入消息级版本拓扑                                                                                      |
| PATCH  | `/api/threads/:threadId/name`                    | ThreadsController         | 设置 thread 显示名                                                                                                   |
| POST   | `/api/threads/:threadId/turns`                   | ThreadsController         | 发送消息。Body: `{ input: UserInput[] }`，支持 text/image/localImage/skill/mention                                   |
| POST   | `/api/threads/:threadId/turns/:turnId/steer`     | ThreadsController         | 向进行中的 turn 发送 rich user input                                                                                 |
| POST   | `/api/threads/:threadId/turns/:turnId/interrupt` | ThreadsController         | 中断进行中的 turn                                                                                                    |
| GET    | `/api/threads/:threadId/token-usage`             | TokenUsageController      | 按分支 provenance 读取 token usage                                                                                   |
| GET    | `/api/threads/:threadId/turn-diffs`              | TurnDiffController        | 按分支 provenance 读取持久化 turn diff                                                                               |
| GET    | `/api/threads/:threadId/turn-errors`             | TurnErrorsController      | 读取持久化 turn 错误，页面刷新后恢复失败提示                                                                         |

### Chat

| Method | Path               | Controller     | 说明                                                                             |
| ------ | ------------------ | -------------- | -------------------------------------------------------------------------------- |
| POST   | `/api/chat/upload` | ChatController | Multipart 单文件暂存到 `CODEX_HOME/webui-uploads/`，返回 app-server 可读绝对路径 |

### Models

| Method | Path          | Controller       | 说明                                 |
| ------ | ------------- | ---------------- | ------------------------------------ |
| GET    | `/api/models` | ModelsController | 列出可用模型。Query: `cursor, limit` |

### Skills

| Method | Path               | Controller       | 说明                                      |
| ------ | ------------------ | ---------------- | ----------------------------------------- |
| GET    | `/api/skills?cwd=` | SkillsController | 调 `skills/list`，原样返回 Codex response |

### MCP Servers

| Method | Path                      | Controller           | 说明                                                      |
| ------ | ------------------------- | -------------------- | --------------------------------------------------------- |
| GET    | `/api/mcp-servers`        | McpServersController | 调 `mcpServerStatus/list`，Query: `cursor, limit, detail` |
| POST   | `/api/mcp-servers/reload` | McpServersController | 调 `config/mcpServer/reload`，重新加载所有 MCP servers    |

### Settings

| Method | Path                      | Controller         | 说明                                                                                                                                                         |
| ------ | ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/settings?category=` | SettingsController | 列出 runtime settings，返回 value/source/type/category/default/constraints                                                                                   |
| GET    | `/api/settings/:key`      | SettingsController | 读取单个 setting；`general.onlyofficeUrl`、`general.onlyofficeJwtSecret`、`general.onlyofficeSaveMaxBytes`、`general.publicBaseUrl` 控制 OnlyOffice 编辑集成 |
| PATCH  | `/api/settings/:key`      | SettingsController | 更新单个 setting；`value: null` 清除 DB override 并回退到 env/default                                                                                        |
| DELETE | `/api/settings/:key`      | SettingsController | 清除单个 setting 的 DB override                                                                                                                              |
| PATCH  | `/api/settings`           | SettingsController | 批量更新 settings，全部校验通过后原子提交                                                                                                                    |

### Files

| Method | Path                                            | Controller           | 说明                                                                                                                                                                |
| ------ | ----------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/files/tree?root=`                         | FilesController      | 读取目录（一级，懒加载）                                                                                                                                            |
| GET    | `/api/files/read?path=`                         | FilesController      | 读取文件内容（上限 5MB）                                                                                                                                            |
| POST   | `/api/files/write`                              | FilesController      | 保存文件。Body: `{ path, content, expectedMtime? }`                                                                                                                 |
| POST   | `/api/files/create-file`                        | FilesController      | 创建新文件。Body: `{ path, content?, overwrite? }`                                                                                                                  |
| POST   | `/api/files/create-directory`                   | FilesController      | 创建目录。Body: `{ path, recursive?, overwrite? }`                                                                                                                  |
| POST   | `/api/files/rename`                             | FilesController      | 同目录重命名。Body: `{ path, newName, overwrite? }`                                                                                                                 |
| POST   | `/api/files/copy`                               | FilesController      | 复制文件/目录。Body: `{ sourcePath, destinationPath, overwrite? }`                                                                                                  |
| POST   | `/api/files/move`                               | FilesController      | 移动文件/目录。Body: `{ sourcePath, destinationPath, overwrite? }`                                                                                                  |
| GET    | `/api/files/serve?path=&access_token?`          | FilesController      | 内联文件服务（正确 Content-Type + inline disposition），支持 `access_token` query param 和 `Range`/206                                                              |
| GET    | `/api/files/archive/list?path=`                 | ArchiveController    | 列出 ZIP/TAR/RAR/7z 压缩包目录树，不落盘解压                                                                                                                        |
| GET    | `/api/files/archive/entry?path=&entry=`         | ArchiveController    | 流式读取单个压缩包条目，支持 `Range`/206                                                                                                                            |
| GET    | `/api/files/download?path=`                     | FilesController      | 流式文件下载（Content-Type: octet-stream + attachment）                                                                                                             |
| POST   | `/api/files/upload?destinationPath=&overwrite?` | FilesController      | Multipart 文件上传（支持文件夹层级）                                                                                                                                |
| GET    | `/api/files/metadata?path=`                     | FilesController      | 文件元信息                                                                                                                                                          |
| GET    | `/api/files/roots`                              | FilesController      | 列出已注册的 workspace roots                                                                                                                                        |
| POST   | `/api/files/roots`                              | FilesController      | 注册 workspace root。Body: `{ root }`                                                                                                                               |
| DELETE | `/api/files/delete?path=&recursive?`            | FilesController      | 删除文件/目录（recursive 可选）                                                                                                                                     |
| GET    | `/api/onlyoffice/config?path=&mode?`            | OnlyOfficeController | 生成 OnlyOffice Docs editor config（默认 edit 模式，?mode=view 切换只读），JWT secret 配置时签名 token                                                              |
| POST   | `/api/onlyoffice/callback?path=&state=`         | OnlyOfficeController | OnlyOffice 保存回调（@Public）；status=2/6 时要求 signed state + Document Server outbox JWT，下载修改后文件并按 `general.onlyofficeSaveMaxBytes` 原子写回 workspace |

## JSON-RPC 映射

每个 REST 端点内部调用 `CodexService.request()` 转为 JSON-RPC:

| REST                                  | JSON-RPC method                                               |
| ------------------------------------- | ------------------------------------------------------------- |
| POST /threads                         | `thread/start`                                                |
| GET /threads                          | `thread/list`                                                 |
| GET /threads/:id                      | `thread/read`                                                 |
| POST /threads/:id/resume              | `thread/resume`                                               |
| POST /threads/:id/turns               | `turn/start`                                                  |
| POST /threads/:id/turns/:id/interrupt | `turn/interrupt`                                              |
| POST /threads/:id/archive             | `thread/archive`                                              |
| POST /threads/:id/unarchive           | `thread/unarchive`                                            |
| POST /threads/:id/compact             | `thread/compact/start`                                        |
| POST /threads/:id/branches            | `thread/fork` with experimental `beforeTurnId`                |
| POST /threads/:id/fork                | `thread/fork`                                                 |
| GET /threads/branch-adoption/status   | local rollout scanner state                                   |
| GET /threads/:id/delete-preview       | `thread/list` plus local/adopted topology                     |
| POST /threads/:id/delete              | `turn/interrupt` as needed, then `thread/delete` leaf-to-root |
| GET /models                           | `model/list`                                                  |
| GET /skills                           | `skills/list`                                                 |
| POST /skills/config                   | `skills/config/write`                                         |
| GET /apps                             | `app/list`                                                    |
| GET /plugins                          | `plugin/list`                                                 |
| GET /plugins/detail                   | `plugin/read`                                                 |
| POST /plugins/install                 | `plugin/install`                                              |
| POST /plugins/uninstall               | `plugin/uninstall`                                            |
| POST /mcp-servers/oauth/login         | `mcpServer/oauth/login`                                       |

## 待实现端点

- 无（当前全部已实现）

## 认证

- `ApiKeyGuard` 已全局挂载 (`APP_GUARD` in `app.module.ts`)
- HTTP: 验证 `Authorization: Bearer <JWT/API_KEY>`；fallback 读取 `access_token` query param（RFC 6750 §2.3，用于 `<img>`/`<video>` 等无法设 header 的场景）
- WebSocket: 验证 `handshake.auth.token` 或 `Authorization` header
- `ThreadsGateway.handleConnection` 在连接阶段拒绝未认证 socket
- 前端: `LoginPage` 验证后存 `sessionStorage`，REST/WS 自动携带 token；`buildFileServeUrl(path)` 生成带 `access_token` 的内联文件 URL

## 注意事项

- Fastify adapter 要求 POST 请求带 `Content-Type: application/json` 时 body 不能为空，即使没有参数也要传 `{}`
- Query 参数均为 string，controller 内做类型转换 (如 `Number(limit)`, `archived === 'true'`)
