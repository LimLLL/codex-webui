# FilesService 文件管理实现文档

## 概述

自建 NestJS FilesService，不依赖 codex app-server 的 `fs/*` 方法。文件管理是 WebUI 基础能力，不应绑定到某个 thread 是否 loaded。

## 后端模块 (src/files/)

### FilesService

文件: `src/files/files.service.ts`

核心方法:

| 方法 | 说明 |
|------|------|
| `resolveSafePath(path)` | 解析 realpath + workspace root 白名单校验（路径必须已存在） |
| `resolveSafeTargetPath(path, opts?)` | 目标路径校验（可不存在，校验 parent）。支持 `recursiveParent` 选项 |
| `validateEntryName(name)` | 拒绝空名、`.`、`..`、路径分隔符、null byte |
| `readDirectory(dir)` | 读取一级目录内容（含隐藏文件），按 `files.excludedDirs` 设置排除指定名称，目录优先排序 |
| `readFile(path)` | 读取文本文件（上限 5MB），返回 content + size + mtime（mtime 与内容配对，作为写入前置，见下文） |
| `writeFile(path, content, expectedMtime?)` | 保存文件，支持 mtime 冲突检测（1s 容差） |
| `createFile(path, content?, overwrite?)` | 创建新文件，默认空内容，默认不覆盖（wx flag） |
| `createDirectory(path, recursive?, overwrite?)` | 创建目录，可选 recursive（mkdir -p） |
| `renamePath(source, newName, overwrite?)` | 同目录重命名，newName 不含路径分隔符 |
| `copyPath(source, dest, overwrite?)` | 复制文件/目录（目录递归 `fs.cp`，不跟随 symlink） |
| `movePath(source, dest, overwrite?)` | 移动（`fs.rename`），跨设备 EXDEV 直接报错 |
| `deletePath(path, recursive?)` | 删除文件/symlink/目录。非空目录需 `recursive=true`。Symlink 只删 link |
| `prepareDownload(path)` | 返回 stream + filename + size，仅文件 |
| `saveUploadedFiles(dest, uploads, overwrite?)` | 流式写入 temp → rename/copy 原子化。支持 relativePath 保留目录层级 |
| `getMetadata(path)` | 返回类型/大小/mtime/权限 |
| `addWorkspaceRoot(root)` | 动态注册可访问目录（thread cwd 自动注册） |
| `getWorkspaceRoots()` | 返回当前已注册的目录列表 |

安全机制:
- 所有已存在路径通过 `resolveSafePath`（realpath + workspace root 校验）
- 新目标路径通过 `resolveSafeTargetPath`（校验 parent directory）
- `assertNoOverwrite` — 目标已存在默认拒绝（409 Conflict）
- `assertNotSelfOrDescendant` — copy/move 禁止目标为源或源的子路径
- `assertNotWorkspaceRoot` — 禁止直接操作 workspace root
- Upload path 逐 segment 校验（拒绝绝对路径、`..`、空 segment、反斜杠）
- Upload 先写 temp 文件再 finalize，中断/失败自动清理
- `rethrowFsError` 统一 fs 错误到 HTTP 异常（EEXIST→409, ENOENT→404, ENOTEMPTY→400, EXDEV→400）

### FilesController

文件: `src/files/files.controller.ts`

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/files/tree?root=` | 读取目录（一级，懒加载） |
| GET | `/api/files/read?path=` | 读取文件内容 |
| POST | `/api/files/write` | 保存文件。Body: `{ path, content, expectedMtime? }` |
| POST | `/api/files/create-file` | 创建新文件。Body: `{ path, content?, overwrite? }` |
| POST | `/api/files/create-directory` | 创建目录。Body: `{ path, recursive?, overwrite? }` |
| POST | `/api/files/rename` | 同目录重命名。Body: `{ path, newName, overwrite? }` |
| POST | `/api/files/copy` | 复制。Body: `{ sourcePath, destinationPath, overwrite? }` |
| POST | `/api/files/move` | 移动。Body: `{ sourcePath, destinationPath, overwrite? }` |
| GET | `/api/files/serve?path=&access_token?` | 内联文件服务：根据扩展名设置正确 Content-Type + `Content-Disposition: inline` + `Range`/206 + `Cache-Control: private, no-store`。支持 `access_token` query param（用于 `<img>/<video>/<audio>` 等） |
| GET | `/api/files/archive/list?path=` | 压缩包目录树预览：ZIP/TAR/TAR.GZ/TAR.BZ2/TAR.XZ/RAR/7z，不落盘解压 |
| GET | `/api/files/archive/entry?path=&entry=` | 压缩包单文件流式预览，支持 `Range`/206，限制 20,000 entries / 50MB entry / 1GB total |
| GET | `/api/files/download?path=` | 流式文件下载（Content-Type: octet-stream + Content-Disposition: attachment） |
| POST | `/api/files/upload?destinationPath=&overwrite?` | Multipart 上传（单/多文件/文件夹层级） |
| GET | `/api/files/metadata?path=` | 文件元信息 |
| GET | `/api/files/roots` | 列出已注册的 workspace roots |
| POST | `/api/files/roots` | 注册 workspace root。Body: `{ root }` |
| DELETE | `/api/files/delete?path=&recursive?` | 删除文件/目录 |

Upload 实现:
- `@fastify/multipart` 注册在 `main.ts`，启用 `preservePath: true`（保留文件夹层级）
- `files.uploadMaxBytes` runtime setting 控制单文件上传上限（DB override → `WEBUI_UPLOAD_MAX_BYTES` env → 100MB default；Fastify multipart limit 在 bootstrap 注册，修改后需重启生效）
- `files.excludedDirs` runtime setting 控制文件树按名称排除的目录/文件（逗号分隔，默认 `node_modules,.git,.next,dist,__pycache__,.DS_Store`）。空字符串表示不排除任何名称，reset/null 恢复默认。修改即时生效无需重启
- Controller 使用 `@Req()` 直接访问 Fastify request，调用 `request.files()` 异步迭代器
- `toUploadInputs` 将 multipart file parts 转为 `FileUploadInput` 供 service 消费

Serve（内联预览）实现:
- `GET /api/files/serve`：根据文件扩展名返回正确 MIME（`guessMimeType` 内置 30+ 格式映射）
- `Content-Disposition: inline` 允许浏览器原生渲染（图片/PDF/音视频等）
- 安全 headers：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、CSP sandbox（`default-src 'none'`，仅允许 img/media/style）、`Cache-Control: private, no-store`（URL 含 token，不缓存）
- `access_token` query param 认证：仅此端点接受（`allowsQueryAccessToken()`），JWT-only（跳过 API key fallback）。日志双重保护：Pino redact `req.query.access_token` + 自定义 serializer 清洗 `req.url`
- 三端点职责分离：`read`（JSON 文本内容给 Monaco）、`serve`（原始字节+正确 MIME 给浏览器渲染）、`download`（强制下载）

Download 实现:
- Controller 使用 `@Res()` 直接返回 Fastify reply
- 设置 `Content-Type: application/octet-stream`、`Content-Length`、`Content-Disposition`（UTF-8 编码 filename）
- `reply.send(stream)` 流式发送

### FilesGateway

文件: `src/files/files.gateway.ts`

按需 chokidar 文件监听，不是全局启动时 watch:

| 事件 | 方向 | 说明 |
|------|------|------|
| `fs.subscribe` | Client → Server | 订阅目录变更，首次时创建 chokidar watcher |
| `fs.unsubscribe` | Client → Server | 取消订阅，无订阅者时关闭 watcher |
| `fs.changed` | Server → Client | 文件变更通知。Payload: `{ event, path }` |

event 类型: `add`, `change`, `unlink`, `addDir`, `unlinkDir`

watcher 配置: depth 3, 忽略 node_modules/.git/dist/__pycache__/.DS_Store, ignoreInitial: true

## 前端

### files-store

文件: `web/src/stores/files-store.ts`

Zustand store 仅管理 UI 状态，REST 数据由 TanStack Query 管理。

| 字段 | 类型 | 说明 |
|------|------|------|
| `rootDir` | `string \| null` | 当前浏览的目录路径 |
| `selectedFile` | `string \| null` | 当前选中的文件路径 |
| `panelOpen` | `boolean` | 文件面板是否展示 |
| `expandedDirs` | `Set<string>` | 展开的目录（保留但 FileTree 不再使用） |
| `pendingLine` | `number \| null` | 待跳转的行号（一次性导航意图，到达即消费） |

Actions: `setRootDir`（重置所有状态）, `selectFile(path, line?)`, `clearPendingLine`, `setPanelOpen`, `toggleDirectory`, `navigateUp`

冲突检测用的 mtime **不在 store 里**：它随 `files/read` 响应与内容一起返回，由 CodeViewer 直接取用。曾经作为 store 字段由独立的 metadata 查询写入，两者新鲜度互不相干，导致新 mtime 为旧内容背书——详见下文。

### useFileOperations hook

文件: `web/src/hooks/use-file-operations.ts`

集中所有文件操作 mutations、query invalidation、selection 同步:

| 操作 | 实现 | 说明 |
|------|------|------|
| `createFile` | SDK mutation | 成功后 invalidate parent dir tree |
| `createDirectory` | SDK mutation | 成功后 invalidate parent dir tree |
| `renamePath` | SDK mutation | 成功后 remap selected descendant |
| `copyPath` | SDK mutation | 成功后 invalidate destination dir |
| `movePath` | SDK mutation | 成功后 invalidate src + dest, remap selected |
| `deletePath` | SDK mutation | 成功后清理 selected（含子路径） |
| `uploadFiles` | Direct fetch（FormData） | SDK 会 JSON 序列化 FormData，必须绕过。成功后 invalidate dest + 每个上传文件的 parent |
| `downloadFile` | Direct fetch + blob download | auth header 从 `getAuthorizationHeader()` 获取 |
| `refresh` | Query invalidation | 目录 → tree key，文件 → read + metadata key |

Auth 处理:
- Upload/download 使用 `getAuthorizationHeader()` 从 `auth-token.ts`（key: `codex.webui.jwt`）
- 401 触发 `codex-webui:auth-expired` 事件，与 SDK client 行为一致
- `readApiError()` 解析 NestJS 错误格式

Selection remap:
- `remapSelectedPath(selected, oldPath, newPath)` — 目录 rename/move 后自动更新选中文件路径（含子路径）

### 组件

| 组件 | 文件 | 说明 |
|------|------|------|
| FilesPanel | `components/files/files-panel.tsx` | 容器：左侧文件树 + 右侧文件查看器 |
| FileTree | `components/files/file-tree.tsx` | Windows Explorer 风格扁平浏览器。单击文件打开，双击目录进入，breadcrumb 返回上级。@dnd-kit/react 拖拽移动 |
| FileToolbar | `components/files/file-toolbar.tsx` | breadcrumb（上级 + 目录名）+ 上传文件/文件夹按钮 + 刷新 |
| FileContextMenu | `components/files/file-context-menu.tsx` | 右键菜单。目录: New File/Folder, Upload Files/Folder。文件: Download。通用: Rename, Copy to, Move to, Refresh, Delete |
| FileDialogs | `components/files/file-dialogs.tsx` | FileNameDialog（创建/重命名）、FilePathDialog（目录树选择器）、DeleteConfirmDialog（递归确认） |
| FileViewer | `components/files/file-viewer.tsx` | 文件查看 shell：路径 header + metadata 查询 + 代理到 `FileContentViewer` |
| FileContentViewer | `components/files/viewers/index.tsx` | Dispatcher：按扩展名路由到对应 viewer（`getFileCategory` from `lib/file-category.ts`），OnlyOffice 配置后 DOCX/XLSX/PPTX 走编辑模式 |
| CodeViewer | `components/files/viewers/code-viewer.tsx` | Monaco Editor 代码/文本查看编辑器（workspace 文件可保存） |
| ReadOnlyCodeViewer | `components/files/viewers/read-only-code-viewer.tsx` | Monaco 只读预览，用于 archive entry 文本/代码 |
| Image/Pdf/Media/Font/Office/Binary viewers | `components/files/viewers/*-viewer.tsx` | 图片、PDF、视频、音频、字体、DOCX（只读预览）、XLSX（只读预览）、OnlyOffice（编辑）、二进制 hex 预览 |
| ArchiveViewer | `components/files/viewers/archive-viewer.tsx` | 压缩包树浏览 + entry read-only dispatch |

### FileTree 交互模型

```
Windows Explorer 风格：
- 单击文件 → selectFile（打开 Monaco 预览）
- 单击目录 → 无操作
- 双击目录 → setRootDir（进入该目录）
- breadcrumb ↑ → navigateUp（返回上级）
- 右键 → FileContextMenu（操作菜单）
- 拖拽文件/目录 → drop 到目标目录 → movePath（移动）
- 外部文件拖入目录 → upload（上传）
```

### @dnd-kit/react 集成

- `DragDropProvider` 包裹 `ScrollArea` 内的内容
- 每个 `TreeRow` 使用 `useDraggable`（所有行可拖）+ `useDroppable`（仅目录可放）
- `Feedback.configure({ feedback: 'clone' })` — 拖拽时原位保留虚影，克隆体跟随鼠标
- dnd-kit ref 在外层 div，ContextMenuTrigger 在内层 div（避免 pointer event 冲突）
- 内层使用 `<div role="button">` 而非 `<button>`（button 会捕获 pointer event 阻止拖拽）
- `onDragEnd` 校验：不移动到自身、不移动到子路径、不移动到相同位置

### FilePathDialog 目录树选择器

- 替代了原先的文本输入框
- 复用 workspace roots + lazy-load 子目录模式（DirNode/DirChildren）
- 单击选中目录，双击展开
- 底部显示选中目录完整路径
- Copy/Move 时自动拼接 `selectedDir + / + entryName` 为目标路径

### 数据流

```
Thread 创建/切换 → rootDir 更新
  → FileToolbar 显示当前目录 breadcrumb
  → FlatDirectory 查询 GET /api/files/tree 显示一级内容
  → 双击目录 → setRootDir(path) → 刷新列表
  → breadcrumb ↑ → navigateUp → 刷新列表
  → 单击文件 → selectFile → FileContentViewer 路由（代码→Monaco，图片→ImageViewer）
  → 拖拽文件到目录 → POST /api/files/move → invalidate src + dest
  → 右键操作 → 对应 mutation → invalidate affected dirs
  → 上传 → direct fetch multipart → invalidate dest + nested dirs
```

## 测试

`src/files/files.service.spec.ts` — 37 个测试:
- resolveSafePath: 合法路径/越界路径/空路径/不存在路径
- readDirectory: 列表/排除 node_modules/目录优先排序
- readFile: 读取内容/拒绝目录/返回与内容配对的 mtime
- createFile: 创建空文件/拒绝已存在/拒绝越界
- createDirectory: 递归创建/拒绝已存在
- writeFile: 写入/mtime 冲突拒绝
- renamePath: 同目录重命名/拒绝路径穿越
- copyPath: 递归复制目录/拒绝自我复制/拒绝越界目标
- movePath: 同设备移动/拒绝覆盖
- getMetadata: 文件/目录元信息
- deletePath: 递归删除/拒绝非递归删非空目录/symlink 只删 link
- prepareDownload: 文件流/拒绝目录
- saveUploadedFiles: 保留文件夹层级/拒绝路径穿越/拒绝空 segment/拒绝覆盖
- addWorkspaceRoot: 动态注册/拒绝越界 root

E2e upload 测试延后（Fastify 插件在 NestJS 测试上下文注册有兼容问题）。

## 聊天消息中的文件引用

Agent 回复里的文件路径点击后在会话面板打开，而不是让浏览器导航到一个静态服务器上并不存在的地址（issue #15）。

### 识别（`lib/file-references.ts`）

纯函数，只做结构判定——**识别不等于存在性证明**，文件存不存在由打开动作本身回答。按来源分两套准入规则：

| 来源 | 规则 |
|------|------|
| markdown 链接 | 语法本身已声明导航意图，准入门槛低：非 scheme、非 protocol-relative、非纯 fragment 即可，含裸文件名 |
| inline code | 必须有结构信号：显式前缀 `./` `../` `/`，或「file-like 末段 + （目录分隔符 或 行号后缀）」 |

inline code 额外要求整个 token 合格，不从更大表达式里抠子串；命令、glob、替换、类型表达式、包名一律 inert。裸文件名（`package.json`、`Dockerfile`）**故意**不识别：散文里提及远多于引用，全做成可点会制造大量指向不存在文件的假可点元素。

行号语法支持 `path:42` 与 `path#L42`（1-based）。非法行号（0、负数、超 100 万）视为 **malformed 而非缺省**——文本许诺了具体位置，落到任意位置比不动更糟，所以整个 token 转为 inert。列号、区间（`:12:3`、`#L12-L20`）明确不支持且不臆测。

已知取舍：`example.com:3000` 这类「末段像文件名的 host:port」会被识别为带行号的文件，无 hostname 名单则无法与 `README.md:42` 区分，打开时如实失败。点分四段 IP（`127.0.0.1:8000`）单独排除。

### 两个容易踩的坑

- **URL sanitizer**：`react-markdown` 的 `defaultUrlTransform` 会把「第一个冒号出现在任何 `/` `?` `#` 之前」的 destination 抹成空串，即 `README.md:42` 这一种形态（带目录分隔符的 `src/a.ts:42` 不受影响）。仅对这一形态归一化成 `./README.md:42` 再交给默认 sanitizer，其余全部走原路径。该 transform **限定 `a` 的 href**——不限定时会一并改写 `img` 的 src 并真的发出请求。
- **链接解码**：链接 destination 是 percent-encoded 的（`<>` 包裹的空格也会被编码），需在**切掉行号后**解码一次，这样文件名里编码的 `#` 不会被反读成 fragment。inline code 是字面量，不解码。

被判定为「本地但无法解析」的链接渲染为惰性文本，**不能**退化成 `<a>`——退化即原样复现 404。

### 打开通道（`lib/open-file-request.ts`）

`codex-webui:open-file` 事件携带 `{ path, line?, sourceThreadId? }`，由 `thread-view` 接收。用户消息的 @mention 与图片徽章走同一通道。

- 行号是**一次性导航意图**（`files-store.pendingLine`），不是 tab 的持久属性；tab 仍按 path 去重，同一文件不同行是同一个 tab
- 面板必须在 ack route 请求**之前**把行号转交给 store
- 纯 path 打开清除既有行号意图；`selectFile` 不全局解析后缀，@mention 与文件树的路径保持字面语义
- 归属作废：请求携带发起会话 id，route 在渲染期丢弃非当前会话的请求（仅过滤会让它在切回时复活）；面板卸载/换会话时清 `pendingLine`，**并同时重置「已处理」的 seq 记号**——两者描述同一件事，只清目标却仍宣称已处理，会在 effect replay（StrictMode）下让首次打开永久丢掉跳转
- 定位前重新读一次 store：effect 闭包捕获的 `pendingLine` 可能已在 render 与 effect 之间被取消，仅凭捕获值会跳到届时在屏的那个文件上
- 只有文本 viewer 支持行号，由 `FileContentViewer` dispatcher 判定；其余 viewer 消费掉行号并提示不支持，避免 PDF 的行号变成页码

### CodeViewer 的三条硬约束

- **行号定位时机**：不能只等 mount。`@monaco-editor/react` 跨文件复用同一个 editor 实例、只换 model，且挂载是异步的——用布尔 ready 标志会因「重复设同值不触发重渲染」而在第二个文件之后静默失效。实例本身存进 state，新实例即新值
- **model 身份校验**：wrapper 会把 `path` prop 当 URI 解析，所以传入路径需逐段 `encodeURIComponent` 成 `file://` URI，否则文件名里的 `#` 会被当 fragment 截断、`%` 会被当转义。校验比对 scheme/authority/query/fragment/path 全等，不做 `endsWith` 后缀匹配（会误接受 `/other/work/app.ts`）
- **保存前置**：内容加载成功且**无进行中的刷新** + 有随内容返回的 mtime + editor 持有该文件的 model，缺一不可。读取失败时**保留**已有 editor 而非卸载（卸载会释放 model，丢掉未保存的编辑），改为禁用保存并显示重载失败横幅。

  写入前置**必须与它所描述的内容同源**。原先 mtime 来自 FileViewer 的独立 metadata 查询，两个查询各有各的 30 秒新鲜度时钟，于是存在这条真实的数据丢失路径：metadata 过期 31 秒、内容还新鲜 29 秒 → 文件被外部改动 → 可见性回归只重取 metadata → 新 mtime 落地而编辑器仍是旧内容 → 保存通过服务端冲突校验，覆盖他人改动。

  现在 `files/read` 直接返回与该次读取配对的 mtime（`fs.stat` 本来就已执行，不增加 syscall），CodeViewer 只认这一个来源，整类不一致从结构上消失。`isFetching` 则关掉「同一查询正在重取」这个更窄的窗口。

  mtime 在读取**之前**采集，这个方向是有意的：文件若在读取期间被改，得到的 mtime 比内容更旧，保存会被拒绝而非静默胜出（fail-safe）

`selectFile` 重选同一文件时保留 mtime，且 metadata 同步 effect 以路径为依赖——否则元数据已缓存、mtime 值未变，effect 不重跑，保存会被永久禁用。

## 注意事项

- macOS `/tmp` 是 `/private/tmp` 的 symlink，测试中需要 `fs.realpath()` 后再设为 workspace root
- Monaco Editor 通过 `@monaco-editor/react` 引入，默认从 CDN 加载 Monaco 核心。Monaco 是纯文本编辑器，不支持 VS Code 扩展或二进制文件
- 二进制文件（图片等）通过 `FileContentViewer` dispatcher 路由到专用 viewer，不走 Monaco
- 隐藏文件（以 `.` 开头）默认排除，`.env` 例外
- Upload 通过 direct fetch 发送（SDK 的 bodySerializer 会把 FormData 转 JSON）
- 跨设备 move（EXDEV）MVP 不支持，记录在 memory 中待后续实现
- `@dnd-kit/react` v0.4 使用 Pointer sensor，button 元素会捕获 pointer event 阻止拖拽，需用 div role=button 替代