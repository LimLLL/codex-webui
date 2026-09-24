# FilesService 文件管理实现文档

## 概述

NestJS FilesService 保留独立 CRUD、策略校验和 Range 流服务。只有监听使用 app-server 的 connection-scoped `fs/watch`，不依赖 loaded thread。

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
- Upload 在创建 parent 前验证最近已有 ancestor，finalize 前再次解析真实 parent，拦截已有 symlink escape；先写 temp 再 finalize，失败清理。完整 no-follow handle walk / 消除 TOCTOU 竞态仍是后续加固项。
- 带 expectedMtime 的写入在目标不存在时拒绝；显式 Save As/recreate 使用 create-file，无隐式重建。
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

网关只承载经过认证的可见范围租约；实际 native `fs/watch` 状态由独立的
`FileWatchCoordinatorService` 管理。app-server 的目录 watch 非递归，因此前端
浏览器当前目录、目录树中展开的目录，以及打开文档的文件路径分别申请租约。
同一连接内相同 canonical path 只注册一次，连接重建后 coordinator 为每个租约分配新
watchId，并发出一次刷新信号；这只同步可见范围，不是全盘 filesystem watcher。

| 事件 | 方向 | 说明 |
|------|------|------|
| `fs.watch.acquire` | Client → Server | `{ path, leaseId }` 申请经过 workspace policy 校验的路径租约 |
| `fs.watch.release` | Client → Server | `{ leaseId }` 释放调用方租约；断开连接时服务端也会清理 |
| `fs.changed` | Server → Client | Payload: `{ watchPath, changedPaths, refresh }`。路径不携带 kind，客户端重读 metadata/query 判断 |

网关显式使用 `ApiKeyGuard`。Socket.IO handler 不会自动继承 HTTP 全局 guard，不能依赖
其它 gateway 或全局配置保护 watch lease。

## 前端

### files-store

文件: `web/src/stores/files-store.ts`

Zustand store 仅管理 UI 状态，REST 数据由 TanStack Query 管理。

| 字段 | 类型 | 说明 |
|------|------|------|
| `rootDir` | `string \| null` | 当前浏览的目录路径 |
| `selectedFile` | `string \| null` | 当前选中的文件路径 |

Actions: `setRootDir`（重置 root 与 selection）, `selectFile`, `navigateUp`。
重命名、移动和删除由应用级 reconciler 按完整路径组件修复 root 与 selection。

冲突检测用的 mtime **不在 store 里**：它随 `files/read` 响应与内容一起返回，由 CodeViewer 直接取用。曾经作为 store 字段由独立的 metadata 查询写入，两者新鲜度互不相干，导致新 mtime 为旧内容背书——详见下文。

### useFileOperations hook

文件: `web/src/hooks/use-file-operations.ts`

集中所有文件操作 mutations、query invalidation，并向应用级 reconciler 发布确认后的路径变化:

| 操作 | 实现 | 说明 |
|------|------|------|
| `createFile` | SDK mutation | 成功后 invalidate parent dir tree |
| `createDirectory` | SDK mutation | 成功后 invalidate parent dir tree |
| `renamePath` | SDK mutation | 成功后发布 rename event；reconciler 修复所有 path-keyed state |
| `copyPath` | SDK mutation | 成功后 invalidate destination dir |
| `movePath` | SDK mutation | 成功后 invalidate src + dest 并发布 rename event |
| `deletePath` | SDK mutation | 成功后发布 subtree delete event |
| `uploadFiles` | Direct fetch（FormData） | SDK 会 JSON 序列化 FormData，必须绕过。成功后 invalidate dest + 每个上传文件的 parent |
| `downloadFile` | Direct fetch + blob download | auth header 从 `getAuthorizationHeader()` 获取 |
| `refresh` | Query invalidation | 目录 → tree key，文件 → read + metadata key |

Auth 处理:
- Upload/download 使用 `getAuthorizationHeader()` 从 `auth-token.ts`（key: `codex.webui.jwt`）
- 401 触发 `codex-webui:auth-expired` 事件，与 SDK client 行为一致
- `readApiError()` 解析 NestJS 错误格式

每个写操作都用 `beginFileMutation` / `finishFileMutation` 把自己括起来，外部观察在这段区间内
必须等待。**创建与复制同样要括**：让路径「出现」和让路径「消失」一样会误导观察者——未加括号的
创建会让并发的两路径批次解析出一缺一在，而那正是外部分类最容易读错的形状。

Selection remap:
- `remapPaths` / `removePaths` — 目录 rename/move/delete 后按完整路径组件更新 root 与 selection，
  复用 `file-change-events` 导出的 `pathIsWithin` / `remapFilePath`，不另写一份内联谓词
  （两者在根目录父级上并不等价）。

### 组件

| 组件 | 文件 | 说明 |
|------|------|------|
| FilesPanel | `components/files/files-panel.tsx` | 容器：左侧文件树 + 右侧文件查看器 |
| FileTree | `components/files/file-tree.tsx` | Windows Explorer 风格扁平浏览器。单击文件打开，双击目录进入，breadcrumb 返回上级。@dnd-kit/react 拖拽移动 |
| FileToolbar | `components/files/file-toolbar.tsx` | breadcrumb（上级 + 目录名）+ 上传文件/文件夹按钮 + 刷新 |
| FileContextMenu | `components/files/file-context-menu.tsx` | 右键菜单。目录: New File/Folder, Upload Files/Folder。文件: Download。通用: Rename, Copy to, Move to, Refresh, Delete |
| FileDialogs | `components/files/file-dialogs.tsx` | FilePathDialog（共享目录树选择器）、DeleteConfirmDialog（递归确认）；名称输入全部使用 inline editor |
| DirectorySelectionTree | `components/files/directory-selection-tree.tsx` | 新会话与 copy/move 共用的懒加载目录树；拥有展开状态，调用方拥有 selected path；菜单仅 New Folder/Rename/Delete/Refresh |
| InlineEntryEditor | `components/files/inline-entry-editor.tsx` | Windows 风格行内新建/重命名，Enter/Escape、blur 提交、IME 安全及错误保留 draft |
| SaveAsDialog | `components/files/save-as-dialog.tsx` | detached dirty document 的恢复入口，使用 create-file 并保留 document identity |
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
- 空白区域右键 → 当前目录的 New File/New Folder/Upload/Refresh；目录行的 New File/New Folder 先进入该目录，列表读取失败则回滚
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

### DirectorySelectionTree 目录树选择器

- 新会话 workspace picker 与 Copy/Move destination picker 使用同一个组件
- 复用 workspace roots + lazy-load 子目录模式；组件拥有 expanded set，调用方拥有 selected path
- 单击选中目录，双击展开
- 目录行复用 FileContextMenu；exact workspace root 隐藏 rename/delete，后端仍是最终权限边界
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
  → 右键/空白区域操作 → 对应 mutation → invalidate affected dirs + 发布 unified file-change event
  → 上传 → direct fetch multipart → invalidate dest + nested dirs
  → fs.changed / local mutation → 应用级 reconciler 同时修复 files store、documents、workspace tabs/views
```

## 测试

`src/files/files.service.spec.ts` — 覆盖路径安全、保护 root、symlink upload escape、mtime
缺失目标 precondition、metadata symlink type 及 CRUD/upload 行为；
`src/archive/archive.service.spec.ts` 覆盖 archive tree、range stream、unsafe/encrypted/
oversized entry、目录和不支持格式。
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

租约并发、释放、重连 epoch 和鉴权由 coordinator/gateway 测试验证；native 目录非递归、文件 watch 固定路径等行为来自 `codex_probe/probes/fs-watch.ts`。
ZIP/TAR adapter 测试使用真实 archive 数据。ZIP 输出通过标准 Node PassThrough，规避当前 yauzl 3.3.0 stored-entry async-iteration 卡住的问题（upstream #169）。

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

### 打开通道与共享文档

`codex-webui:open-file` 携带 `{ path, line?, sourceThreadId? }`。发起动作时按来源会话解析绝对路径；工作区只接受该来源的请求，文件打开不再依赖单个全局 selected-file。tab descriptor 按路径去重，行号和请求序号不构成 tab 身份。

`workspace-store` 的每个 file view 保存 cursor/scroll 与一次性 reveal intent。激活时先恢复普通 view state，再在 editor 持有正确 model 后 reveal；新请求取代旧请求，关闭/离开取消 intent。非文本 viewer 消费并提示不支持行号。异步读取只更新 document，不重开已关闭的 tab。

`document-store` 用稳定 document identity 加 path index 共享工作模型。路径移动只更新 live
path，Monaco model URI 与文件系统路径解耦，side maps（owners/readers/listeners）全部按
identity 索引；新文件占用旧路径时会得到新 identity。Monaco model 在 editor widget 之外保留；
打开的 tab 本身持有 owner，即使 editor widget 未挂载也保留 identity；干净且无 owner 的 model 可释放，dirty/saving model 保留文本和 undo。

首次读取把 content 与 server mtime 成对作为 saved baseline。后台读取不能覆盖 dirty model 或提升其 expectedMtime。Save 捕获实际提交文本及 revision；成功返回的 mtime 属于这份文本，若请求期间又有编辑，文档仍 dirty。失败保留 draft 和旧 baseline。Query cache 不反复把 fetched text 写入 dirty editor。服务端读取前采集 mtime 的保守校验方向保留不变。

目录删除后的 dirty document 进入 detached 状态：普通 save/reload 被拒绝，编辑器和关闭
确认都提供 Save As/recreate；create 成功后只更新同一 identity 的 live path、baseline、mtime
和 dirty 状态。应用级恢复栏让独立 Files viewer 已卸载的 detached 脏缓冲区仍能另存为或显式放弃。完整 view/document/terminal 生命周期见 [workspace-tabs.md](workspace-tabs.md)。

## 注意事项

- macOS `/tmp` 是 `/private/tmp` 的 symlink，测试中需要 `fs.realpath()` 后再设为 workspace root
- Monaco Editor 通过 `@monaco-editor/react` 引入，默认从 CDN 加载 Monaco 核心。Monaco 是纯文本编辑器，不支持 VS Code 扩展或二进制文件
- 二进制文件（图片等）通过 `FileContentViewer` dispatcher 路由到专用 viewer，不走 Monaco
- 文件列表包含隐藏文件；排除规则来自 runtime excludedDirs 设置
- Upload 通过 direct fetch 发送（SDK 的 bodySerializer 会把 FormData 转 JSON）
- 跨设备 move（EXDEV）MVP 不支持，记录在 memory 中待后续实现
- `@dnd-kit/react` v0.4 使用 Pointer sensor，button 元素会捕获 pointer event 阻止拖拽，需用 div role=button 替代


### 同步边界与尚存限制

本地确认后的 rename/move/delete 与外部观察统一进入路径事件处理器；外部观察等待当前
本地 mutation 的确认，避免 file watch 的旧路径消失通知抢先把正在移动的文档 detached。
通知中的 metadata 只有明确 path_not_found 才能触发 detach，权限/网络失败只刷新。

**外部观察一律不升级为 relocation。** `pnpm probe fs-watch-classification` 在钉住的 CLI 上
实测：同一被监听目录内的一次 rename，与一次「删除 A 并新建无关的 B」，发出的是**结构
完全相同的两路径通知**——

```
rename        → changedPaths: [rename-new.txt,        rename-old.txt]
delete-create → changedPaths: [delete-create-new.txt, delete-create-old.txt]
```

所以「一个路径消失、一个路径出现」不构成移动的证据，成对顺序也不稳定（该轮为新路径在前，
而 `fs-watch` 的 `[14]` 连测五次均为旧路径在前）。若据此推断，agent 在同一目录里删一个文件
又建另一个（`git checkout`、构建步骤中常见）就会把用户打开的缓冲静默 retarget 到无关文件：
`expectedMtime` 通常能挡住最终写入，但标签页已经在声称错误的文件，干净文档还会载入外来内容。

因此消失的路径一律 detach——保留正文与 undo 历史并要求显式恢复。**只有本客户端自己的
mutation 会产生 `rename`**，因为它的 REST 响应权威地给出了两端。单文件 watch 钉在路径上
不跟随文件（`fs-watch` 的 `[15]`），所以确认改名后必须显式释放旧租约并申请新租约。

可见范围之外的目录变化与断线期间的历史无法重建。重连只重新注册 desired scopes 并重新读取；
未观察到的消失可变成 detached，不能宣称恢复了所有外部 relocation。
真实浏览器项目覆盖 Radix modal/menu 的焦点和布局；jsdom 测试只验证键盘事件与业务状态。
