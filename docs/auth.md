# 认证与安全实现文档

## 概述

单用户部署的 API Key + JWT 认证体系。API Key 用于首次登录，签发 JWT 后续使用。

## 后端 (src/auth/)

### AuthService

文件: `src/auth/auth.service.ts`

| 方法 | 说明 |
|------|------|
| `signToken(payload)` | 签发 JWT（TTL 24h） |
| `verifyToken(token)` | 验证 JWT 签名 + 过期 |
| `validateApiKey(key)` | 校验原始 API Key |

JWT secret 派生: `HMAC-SHA256(WEBUI_API_KEY, "codex-webui-jwt")`

### ApiKeyGuard

文件: `src/auth/api-key.guard.ts`

全局挂载（`APP_GUARD`），`HttpToken { value, source }` 追踪 token 来源，执行顺序:
1. 检查 `@Public()` 装饰器 → 跳过
2. WebSocket → 从 `handshake.auth.token` 或 `Authorization` header 提取 → `authenticateToken()`（JWT + API key fallback）
3. HTTP → 提取 token：优先 `Authorization: Bearer <token>` header（source: `header`），fallback `access_token` query param（source: `query`）
4. `access_token` query param 限制：仅 `GET /api/files/serve` 允许（`allowsQueryAccessToken()` 校验 method + path），且必须为 JWT 格式（3 段式）
5. source=`query` → 直接走 `verifyJwt()`，**跳过 API key fallback**（防止 URL 中暴露 API key）
6. source=`header` → 走 `authenticateToken()`（JWT 优先 + API key fallback）
7. 均失败 → 401

### AuthController

文件: `src/auth/auth.controller.ts`

| Method | Path | 说明 |
|--------|------|------|
| POST | `/api/auth/login` | 校验 API Key → 签发 JWT |
| POST | `/api/auth/logout` | 无状态，仅返回 ok |

`@Public()` 装饰器免除 login 端点的认证。

## 前端

### auth-token.ts

文件: `web/src/auth-token.ts`

sessionStorage key: `codex.webui.jwt`

| 函数 | 说明 |
|------|------|
| `getApiToken()` | 读取 JWT |
| `setApiToken(token)` | 存储 JWT |
| `clearApiToken()` | 清除 JWT |
| `getAuthorizationHeader()` | 返回 `Bearer <token>` 或 null |
| `buildFileServeUrl(path)` | 生成 `/api/files/serve?path=...&access_token=...` URL，用于 `<img src>` 等 |

### 认证流程

```
LoginPage → POST /api/auth/login(apiKey) → JWT
  → sessionStorage.setItem('codex.webui.jwt', jwt)
  → REST: api-client interceptor 自动加 Authorization header
  → Socket.IO: handshake auth.token
  → 401 响应 → clearApiToken() → dispatch 'codex-webui:auth-expired' → redirect /login
  → Auth guard (TanStack Router beforeLoad): 无 token → redirect /login?redirect=originalPath
```

### 直接 fetch 场景

upload/download 绕过 SDK 使用直接 fetch 时，必须:
- 用 `getAuthorizationHeader()` 获取 auth header（不要直接读 sessionStorage）
- 401 时调 `clearApiToken()` + dispatch `codex-webui:auth-expired`

## WebSocket 认证

ThreadsGateway/FilesGateway/TerminalGateway 共享 `/ws` namespace:
- Handshake 阶段校验 `auth.token`（JWT 或 API Key）
- 未认证连接直接拒绝（`next(new Error(...))`）

## Swagger

`NODE_ENV !== 'production'` 时才注册 SwaggerModule，生产环境自动禁用。

## Config 脱敏

`/api/codex/status` 的 config 字段只返回白名单摘要（sandboxMode, approvalPolicy, model, modelProvider），不暴露 raw config。

## Pino 日志脱敏

redact paths: `Authorization`, `cookie`, `req.query.access_token`, `set-cookie`, `token`, `accessToken`, `apiKey`, `password`（含 `*.` 前缀）。

自定义 `req` serializer：`sanitizeUrl()` 将 `req.url` 中的 `access_token=xxx` 替换为 `access_token=[Redacted]`，防止 JWT 通过 URL 日志泄露。双重保护（serializer 清洗 URL 字符串 + redact 清洗 query 对象）。

## 策略切换

SecurityPolicyBadge (ChatInput popover):
- `POST /api/codex/approval-policy` → `config/batchWrite` + `reloadUserConfig:true`
- `POST /api/codex/sandbox-mode` → 同上
- 显示网络访问状态，危险选项红色高亮

## 审批卡片

详见 [approval.md](approval.md)。

支持 accept, acceptForSession, decline, cancel + exec/network policy amendments。按钮由服务端 `availableDecisions` 动态控制。