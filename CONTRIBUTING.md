# 贡献指南

感谢你愿意为 Codex WebUI 出力。

[English](./CONTRIBUTING.en.md)

---

## 开始之前

**Codex WebUI 是 [OpenAI Codex CLI](https://github.com/openai/codex) 的 Web 前端，不是一个独立的 Agent 实现。** 这决定了三条边界：

1. **`codex app-server` 是唯一事实来源。** 线程、回合、rollout 历史都以 app-server 为准，WebUI 只做投影和必要的本地持久化（分支拓扑、token 用量、审批状态等）。
2. **上游没有原语的能力，不在客户端模拟。** 如果某个功能需要 WebUI 自己伪造 app-server 不提供的语义，通常不会被接受——这类补丁在协议演进时必然腐烂。提议前建议翻一下 [`docs/upstream/`](docs/upstream/README.md) 里 vendored 的协议文档。
3. **不擅自引入新的第三方依赖。** 优先用项目已有依赖或标准库。确实需要新依赖时，请在 issue 里说明理由并等待确认，不要直接在 PR 里带进来。

动手之前：

- **修 Bug** —— 直接开 [Bug issue](../../issues/new?template=bug_report.yml)，或者带着 issue 编号提 PR。
- **加功能 / 重构** —— **请先开 issue 讨论方案再写代码。** 改动面大的 PR 如果方向不对，返工成本对双方都很高。
- **改文档、修错别字** —— 直接提 PR，不用先开 issue。

---

## 开发环境

### 前置条件

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 20（镜像用 22） | `node-pty`、`better-sqlite3` 是原生模块，切换 Node 版本后需要重新编译 |
| pnpm | 10.x | 建议 `corepack enable` 让版本跟随 `packageManager` 字段 |
| Codex CLI | 跟随 devDependency | 不需要全局安装，见下方说明 |

`pnpm install` 会把 `@openai/codex` 作为 devDependency 装到 `node_modules/.bin/codex`，构建脚本优先用它，因此**协议类型生成不依赖你全局装的 codex 版本**。但要真正跑起来对话，仍然需要一个已登录或已配置 API Key 的 Codex 环境（`~/.codex`）。

### 搭建步骤

后端和前端是**两个独立的 pnpm 项目**（`web/` 有自己的 lockfile），需要分别安装依赖：

```bash
git clone https://github.com/LimLLL/codex-webui.git
cd codex-webui

pnpm install                 # 后端依赖
cd web && pnpm install && cd ..   # 前端依赖

cp .env.example .env         # 至少填 WEBUI_API_KEY

pnpm start:dev               # 后端，默认 8172
cd web && pnpm dev           # 前端，5173，自动代理 /api 与 /socket.io
```

打开 `http://localhost:5173`，用 `.env` 里的 `WEBUI_API_KEY` 登录。

首次 build/test/lint 会自动执行 `pnpm codex:schema`，把 app-server 的 TS 类型生成到 `src/codex/codex-schema/`。**该目录不入版本库**，本地缺失时会自动补齐。

### 换过 Node 版本之后

原生模块需要重编，否则后端起不来：

```bash
cd node_modules/.pnpm/node-pty@*/node_modules/node-pty && npx node-gyp rebuild
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npx node-gyp rebuild
```

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `pnpm start:dev` | 后端开发模式（watch） |
| `pnpm build` | 编译后端到 `dist/` |
| `pnpm test` / `pnpm test:cov` | 后端测试 / 带覆盖率 |
| `pnpm lint` | ESLint 自动修复，**同时会跑前端 lint** |
| `pnpm codex:schema` | 重新生成 app-server TS 类型 |
| `pnpm generate:api` | 由后端 OpenAPI 重新生成前端 SDK（需后端在跑） |
| `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:studio` | 生成迁移 / 执行迁移 / 打开 Drizzle Studio |
| `cd web && pnpm dev` / `pnpm build` / `pnpm test` | 前端开发 / 构建到 `../public/` / 测试 |
| `npx vitest run src/files/files.service.spec.ts` | 跑单个测试文件 |

**验证改动请用 `pnpm lint`，不要用 `tsc --noEmit`。**

---

## 项目结构

架构总览见 [`docs/codexwebui-architecture.md`](docs/codexwebui-architecture.md)，各模块的详细文档索引在 [`CLAUDE.md`](CLAUDE.md) 里（那份文件是给 AI 助手看的，但模块表和文档索引对人同样有用）。

- `src/` —— NestJS 后端，每个功能一个模块（controller + service + module）
- `web/src/` —— React 前端：`routes/` 页面、`components/` 组件、`stores/` Zustand、`hooks/` 自定义 hooks、`generated/api/` 自动生成的 SDK
- `docs/` —— 实现文档，**已纳入版本管理且对外公开**
- `drizzle/` —— 数据库迁移

**不要在没有说明的情况下改变既定的目录结构和分层。**

---

## 代码规范

- **后端**：NestJS 模块模式，一个功能一组 controller + service + module。
- **前端**：组件放 `components/`，状态放 `stores/`，hooks 放 `hooks/`，类型放 `types/`。
- **格式化**：ESLint（`recommendedTypeChecked`）+ Prettier，单引号、尾逗号。生成的 schema 与 SDK 不参与检查。
- **文件长度**：单文件建议不超过 500 行（含注释），超了就拆。
- **注释**：模块顶部一句话说明用途；公开方法写 JSDoc（purpose / params / returns / throws）；TS 的 `interface`、`type`、`enum` 加 JSDoc；行内注释只用来解释不显然的逻辑，不要复述代码。
- **i18n**：文案走 `react-i18next`，**key 就是英文自然语言原文**，中文翻译补到 `web/src/locales/zh-CN.json`。不要硬编码中文到组件里。
- **日志**：用 Pino。记录入参、分支决策、异常等关键点；**循环体和高频调用路径里不要打日志**；敏感字段依赖 redact 配置。
- **错误处理**：可恢复的错误就近处理并记录；不可恢复的错误 fail-fast 向上抛出。**不要静默吞掉异常。**
- **改动范围**：一个 PR 只做一件事。发现顺手能修的其他问题，请另开 issue 或另提 PR。

---

## 测试

前后端统一用 Vitest，测试文件与被测代码同目录（`.spec.ts` / `.spec.tsx`）。

**该写测试的**：核心业务逻辑（输入 → 预期输出）、容易回归的边界与错误路径、外部集成（Mock 保持最小）。

**不必写的**：为凑覆盖率而写的、重复冗余的、测实现细节（具体颜色值、类名）的、过度 Mock 导致失真的。

两个容易踩的坑：

- **后端必须用 SWC 作为唯一的 transformer**（`unplugin-swc` + `esbuild: false` + `oxc: false`）。esbuild 和 Oxc 都会丢掉 NestJS 依赖注入所需的 `emitDecoratorMetadata`，而且报错形式是"无法解析的参数下标"，不是构建失败，非常难查。`app.module.spec.ts` 会编译整张依赖图作为哨兵测试。
- **依赖数据库的 service 用 `src/database/database.testing.ts` 提供的内存 SQLite**，它会跑真实的 `drizzle/` 迁移，所以 schema 漂移会直接让测试挂掉。**不要手抄 DDL 到 spec 里。**

---

## 数据库迁移

改了 `src/database/` 下的 schema 之后：

```bash
pnpm db:generate    # 生成迁移
pnpm db:migrate     # 本地应用
```

把 `drizzle/` 下新生成的迁移文件一起提交。**不要手写迁移文件，也不要修改已经提交过的迁移**——别人的数据库已经执行过它们了。

---

## 改了后端接口

前端 SDK（`web/src/generated/api/`）由后端的 OpenAPI spec 自动生成。改了 controller 或 DTO 之后：

```bash
pnpm start:dev            # 先把后端跑起来
pnpm generate:api         # 另一个终端
```

把生成结果一起提交。**不要手改 `generated/` 下的文件**，下次生成就没了。

---

## 升级 Codex CLI 版本

`@openai/codex` 这个 devDependency 锁定了整个协议面。**升它是一次协议迁移，不是版本号 bump**，流程是：

1. 改版本号并重装
2. `pnpm codex:schema` 重新生成类型，**逐项 diff** 出被删除、改名、语义变化的字段
3. 更新 [`docs/upstream/`](docs/upstream/README.md) 下 vendored 的协议文档，保持与 CLI 版本同 tag
4. 跑全量测试，重点看 JSON-RPC 调用和通知处理

顺带一提：**schema 里没导出 ≠ 运行时不支持**。上游文档里描述了但生成类型未覆盖的方法通常运行时可用，需要实测确认，不要直接判定不支持。

---

## 文档

**代码改完要顺手更新文档，这是交付的一部分。** 检查清单：

1. `CLAUDE.md` —— 模块表、前端结构表等索引信息（只放一句话摘要）
2. `docs/` —— 逐个检查受影响的文档
3. `docs/remaining-tasks.md` —— 标记完成项、补充新发现的待办

⚠️ **`docs/` 已纳入版本管理并对外公开**，不要写入个人信息、绝对路径、主机名、密钥。

---

## Commit 与 PR

**Commit message** 沿用 Conventional Commits：

```
type(scope): 简短描述

feat(threads): 新增分支删除的级联确认
fix(web): 修复子路径部署下 Socket.IO 连不上
docs: 更新反向代理配置说明
```

常用 `type`：`feat` `fix` `docs` `test` `refactor` `build` `chore` `improve`。`scope` 用模块名（`threads` `codex` `files` `web` `terminal` …）。中英文都可以，仓库现有历史以中文为主。

**PR 流程**：

1. 从 `main` 开分支
2. 提交前跑 `pnpm lint`、`pnpm test`、`cd web && pnpm test`
3. 按 PR 模板填写改动说明和验证情况——**没跑的检查项就如实留空**，不要照着勾
4. 一个 PR 只解决一个问题

---

## 许可

本项目采用 [AGPL-3.0 或更新版本](LICENSE)（`AGPL-3.0-or-later`），版权归 LimLLL 所有。**提交 Pull Request 即表示你同意以该许可发布你的贡献。**

注意 AGPL 的网络条款：如果你修改了本项目并通过网络对外提供服务，需要向使用者提供修改后的完整源码。

---

## 安全问题

**请不要用公开 issue 报告安全漏洞**，见 [SECURITY.md](SECURITY.md)。