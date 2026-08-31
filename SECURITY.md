# 安全策略 / Security Policy

## 上报方式 / Reporting a vulnerability

**请不要通过公开 issue 报告安全漏洞。**

请使用 GitHub 的私密上报通道：[Report a vulnerability](https://github.com/LimLLL/codex-webui/security/advisories/new)。

**Please do not report security vulnerabilities through public issues.**

Use GitHub's private reporting channel instead: [Report a vulnerability](https://github.com/LimLLL/codex-webui/security/advisories/new).

上报时请尽量包含 / Please include where possible:

- 受影响的版本（镜像 tag 或 commit SHA）/ Affected version (image tag or commit SHA)
- 部署方式与是否有反向代理 / Deployment method and whether a reverse proxy is involved
- 复现步骤，以及攻击者需要具备的前提条件（是否已认证、是否同网段等）/ Reproduction steps and the preconditions an attacker needs (authenticated or not, same network, etc.)
- 影响评估：能读到什么、能改什么、能执行什么 / Impact: what can be read, modified, or executed

⚠️ 上报材料里请自行去除 API Key、账号邮箱和私有路径。
⚠️ Please scrub API keys, account emails and private paths from your report.

## 维护范围 / Supported versions

只对 `main` 分支和 `latest` 镜像提供安全修复，不向后移植到旧 tag。
Security fixes are provided for the `main` branch and the `latest` image only; they are not backported to older tags.

## 响应预期 / What to expect

这是个人维护的开源项目，没有 SLA，也没有赏金计划。我会尽快确认收到并给出评估结论，修复后在 advisory 中致谢（除非你希望匿名）。

This is a personally maintained open-source project — there is no SLA and no bug bounty. I will acknowledge your report and share an assessment as soon as I can, and credit you in the advisory once fixed (unless you prefer to stay anonymous).

## 威胁模型 / Threat model

Codex WebUI 的设计前提是：**通过 `WEBUI_API_KEY` 认证的用户是受信任的操作者**。认证之后，用户本来就能读写工作区文件、开终端执行命令、并驱动 Codex 修改代码——这些是产品的核心功能，不是漏洞。

Codex WebUI assumes that **anyone authenticated with `WEBUI_API_KEY` is a trusted operator**. Once authenticated, a user is expected to be able to read and write workspace files, run terminal commands, and drive Codex to modify code — these are core features, not vulnerabilities.

### 属于漏洞 / In scope

- 绕过认证访问 REST 接口或 WebSocket / Bypassing authentication on REST endpoints or the WebSocket gateway
- 路径穿越，读写 `security.workspaceRoots` 之外的文件 / Path traversal outside `security.workspaceRoots`
- 越权访问他人的终端会话、线程或待审批请求 / Accessing another user's terminal session, thread, or pending approval
- API Key、JWT、账号凭据泄漏到日志、诊断导出或错误响应中 / Leaking API keys, JWTs or account credentials into logs, the diagnostics export, or error responses
- 伪造审批响应，绕过审批流程执行命令或写文件 / Forging approval responses to execute commands or write files without approval
- OnlyOffice 回调的 JWT 校验绕过 / Bypassing JWT verification on the OnlyOffice save callback
- 存储型或反射型 XSS，尤其是经由渲染的模型输出与文件内容 / Stored or reflected XSS, especially via rendered model output and file contents
- 依赖链中可被实际利用的漏洞 / Practically exploitable vulnerabilities in the dependency chain

### 不属于漏洞 / Out of scope

- 已认证用户能读写工作区文件、执行终端命令 —— 设计如此 / Authenticated users being able to read/write workspace files and run terminal commands — by design
- 纯 HTTP 部署下 `WEBUI_API_KEY` 明文传输 —— [README](README.md#https--反向代理) 已明确要求生产环境用反向代理终止 HTTPS / `WEBUI_API_KEY` sent in cleartext over plain HTTP — the README explicitly requires terminating HTTPS at a reverse proxy in production
- 使用弱 `WEBUI_API_KEY` 或将服务直接暴露到公网导致的后果 / Consequences of choosing a weak `WEBUI_API_KEY` or exposing the service directly to the internet
- Codex CLI / app-server 本身的问题 —— 请报到 [openai/codex](https://github.com/openai/codex/security) / Issues in the Codex CLI or app-server itself — report those to [openai/codex](https://github.com/openai/codex/security)
- 无实际影响的扫描器输出、缺失的安全响应头等理论性报告 / Scanner output, missing security headers, and similar theoretical findings with no demonstrated impact

## 部署加固建议 / Hardening recommendations

- 用足够随机的 `WEBUI_API_KEY`，不要复用其他地方的密钥 / Use a strong, unique `WEBUI_API_KEY`
- 生产环境务必在反向代理层启用 HTTPS / Always terminate HTTPS at a reverse proxy in production
- 把 `security.workspaceRoots` 收敛到真正需要的目录 / Narrow `security.workspaceRoots` to the directories you actually need
- 用 Docker 部署时不要把宿主机根目录挂进容器 / Do not mount the host root filesystem into the container
- 分享诊断导出前先检查内容 / Review the diagnostics export before sharing it