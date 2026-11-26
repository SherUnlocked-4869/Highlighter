# Highlighter (v5.0.1) 全量代码评审与优化建议报告

- **评审日期**：2026-11-26
- **代码基线**：`master@8416120`（应用版本 `5.0.1`）
- **评审范围**：Electron 主进程与架构门禁、多窗口渲染层（截图 / 长截图 / 贴图 / 录屏与剪辑 / 划词工具条与 AI 会话 / 识别 / 剪贴板 / 本地搜索 / 配置中心）、C++ 原生划词钩子（`vendor/selection-hook`）、Rust 原生 Sidecar（`native/clipboard`、`native/ocr`、`native/everything-search`）以及 C# 外设电量服务（`native/device-battery`）。

---

## 一、 总体评价与架构亮点

项目整体工程成熟度高，具备多项优秀的桌面应用实践：
1. **严格的安全与窗口边界**：通过 `main/services/ipc-security.js` 与 `main/services/window-security.js` 实现了基于窗口角色（`role`）的 IPC 鉴权和本地文件加载白名单；导出结果通过 `main/services/export-result-service.js` 以 `resultId` 寻址，避免了任意路径打开风险。
2. **多语言原生协同架构**：将系统级与计算密集型能力（Win32 划词钩子、SQLite 剪贴板事务与粘贴注入、PaddleOCR ONNX 推理、Everything IPC 桥接、HID 外设电量读取）拆分为独立的 Native Sidecar / `UtilityProcess`；通过 `main/services/credential-store.js` 结合 Windows DPAPI（`safeStorage`）实现了带内存会话态兜底的凭据保护。
3. **完善的质量门禁**：涵盖架构约束检查、i18n 对称性校验、Electron Fuses 校验（`scripts/verify-electron-fuses.js`）以及高覆盖率的单元与运行时探针测试。

同时，在高密度特性迭代与硬性行数门禁下，代码库中也暴露出若干**功能链路断裂、主线程同步 I/O 阻塞、缓存预算泄漏及跨进程事件风暴**问题，具体如下。

---

## 二、 高危缺陷与架构隐患 (P0 级修复建议)

### 1. 可编辑截图文档 (`CaptureDocumentService`) 与历史服务 (`HistoryService`) 删除及恢复链路断裂，导致海量磁盘文件永久泄漏
- **涉及代码**：
  - `main/services/history-service.js` (`#L116-L120`, `#L187-L246`, `#L405-L439`, `#L510-L566`)
  - `main/services/capture-document-service.js` (`#L201-L219`, `#L1039-L1087`)
  - `main/services/data-root-migration.js` (`#L103-L120`)
  - `main.js` (`#L199`, `#L1098-L1114`)
- **根因分析**：
  1. **删除历史记录时遗留整个 `history/documents/<documentId>/` 目录**：可编辑截图架构将全屏底图 `base/<baseAssetId>.png`、历史版本 `revisions/<rev>.result.png` / `.doc.json` / `.thumb.png` 存储在 `history/documents/<documentId>/` 下。但 `main.js:1109-1113` 的 `history:delete`、`history:delete-many`、`history:clear`、`history:cleanup` 全部直接调用 `HistoryService.deleteFiles(item)`（`main/services/history-service.js:116-120`），仅删除了当前 head 的 `item.filePath` 和 `item.thumbnailPath` 两个文件，**从未调用 `captureDocumentService.deleteDocumentFiles(documentId)`**。
  2. **孤儿清理与容量统计失真**：`HistoryService.orphanFiles()`（`main/services/history-service.js:194-201`）仅扫描顶层文件（`if (!entry.isFile()) continue`），完全忽略 `documents/` 子目录；`CaptureDocumentService.documentStats()`（`main/services/capture-document-service.js:1054`）在生产代码中从未被调用。
  3. **启动索引恢复死代码**：`CaptureDocumentService.recoverIndex()`（`main/services/capture-document-service.js:201`）实现了防断电/非原子写损坏的索引备份恢复，但 `main.js:199` 初始化 `captureDocumentService` 后从未调用该方法。
  4. **实时数据目录迁移遗漏文档路径重写**：`main/services/data-root-migration.js:114-116` 的 `rewriteConfig()` 仅重写了 `['filePath', 'thumbnailPath']`，漏掉了 `docPath` 和 `baseImagePath`（对比 `main/services/data-root-backup.js:1246-1259` 已包含完整字段）。迁移数据目录并清理旧目录后，所有历史截图的“重新编辑”会因找不到底图与文档而降级或报错。
- **优化方案**：
  - 在 `initializeStore()` 中创建 `captureDocumentService` 后立即调用 `captureDocumentService.recoverIndex()`。
  - 在 `HistoryService.deleteFiles(item)` 中，若条目关联了 `documentId` 或存在 `documents/<id>` 目录，同步调用 `deleteDocumentFiles` 清理整个文档目录；将 `documentStats()` 整合进 `history:stats`。
  - 将 `data-root-backup.js` 的 `HISTORY_ENTRY_PATH_KEYS` 抽取至 `main/services/data-root.js` 并在 `data-root-migration.js` 中统一调用。

---

### 2. 马赛克画笔缓存预算计数器 (`mosaicPatchBytes`) 永久泄漏，导致拖拽几次后缓存彻底失效
- **涉及代码**：`capture/capture.js` (`#L323-L327`, `#L676-L682`, `#L750-L773`, `#L2213`, `#L2381`, `#L2459`)
- **根因分析**：
  1. `mosaicPatchCache` 是以标注对象引用为 Key 的 `WeakMap`，配合计数器 `let mosaicPatchBytes = 0`（上限 `MOSAIC_PATCH_BUDGET = 16 MiB`）。
  2. 当用户拖拽移动（`#L2213`）、方向键微调（`#L2331`）、缩放（`#L2381`）或修改样式（`#L2459`）时，每一帧都会生成新的不可变标注对象替换 `annotations[index]`。旧对象在 `WeakMap` 中随 GC 回收，但 **`mosaicPatchBytes` 从未扣减旧对象占用的字节数**。
  3. 用户拖拽马赛克笔触十几帧后，`mosaicPatchBytes` 就会迅速突破 16 MiB，导致后续 `mosaicPatchBytes + bytes <= MOSAIC_PATCH_BUDGET`（`#L764`）永远为 `false`，所有马赛克笔触退化为每帧重新创建两个离屏 Canvas 全量重绘。
  4. 此外，正在涂抹中的 `activeAnnotation` 尚未分配 `id`（`#L758` 仅在 `if (item.id)` 时缓存），因此涂抹过程中每一帧都在新建两个离屏 Canvas。
- **优化方案**：
  - **架构级简化（全局马赛克底图化）**：由于马赛克网格相位已全局对齐到画布原点（`#L707-L710`），进入截图时只需预生成一张全屏马赛克底图 Canvas；绘制任意马赛克笔触（无论涂抹中还是已提交）只需在复用蒙版层上 `traceStroke` 并 `drawImage`，彻底消除单笔触离屏 Canvas 分配与 `mosaicPatchBytes` 账本管理。
  - **最小改动方案**：将 `mosaicPatchCache` 改为按 `item.id` 索引的 LRU `Map<number, { key, patch, bytes }>`，在覆盖或删除 `item.id` 时精确减去旧 `entry.bytes`。

---

### 3. `action.js` 的 `simpleMarkdown` 解析器破坏代码块内容，且流式渲染存在 $O(N^2)$ 全量 DOM 重建
- **涉及代码**：`action/action.js` (`#L13-L16`, `#L218-L288`, `#L432-L451`)
- **根因分析**：
  1. **代码块内部被二次按行解析破坏**：`action/action.js:220` 先将 ```` ```lang\n...``` ```` 替换为 `<pre><code>...</code></pre>`，随后在 `#L222` **对包含 `<pre><code>` 的字符串按 `\n` 切分逐行解析**：
     - 代码块内的所有空行在 `#L236` (`if (!trimmed) { closeList(); continue }`) 被直接丢弃；
     - 代码块内以 `#`（如 Python/Shell 注释 `# comment`、C `#include`）、`- `、`1. `、`---`、`> ` 开头的行被 `#L239-L280` 误转成 `<h1>`、`<ul><li>`、`<hr>`、`<blockquote>`；
     - 代码块中间行在 `#L284` 被包裹进 `<p>${inlineMarkdown(line)}</p>`，导致缩进丢失且代码中的 `*ptr`、`__init__` 被转成斜体或粗体！
  2. **流式生成期间无法选中复制已生成段落**：`#L435-L450` 每帧 `requestAnimationFrame` 都对全量累积文本重跑正则与 `DOMPurify.sanitize` 并重写整个 `turn.answerEl.innerHTML`，不仅在长文本回答时产生 $O(N^2)$ CPU 开销，还会每帧重置用户的鼠标文本选区（`window.getSelection()`）。
- **优化方案**：
  - 在 `simpleMarkdown` 的逐行状态机中维护 `inCodeBlock` 布尔状态：遇到 `^``` ` 切换状态，在 `inCodeBlock` 期间原样保留代码行与空行，流式未闭合时自动在末尾补齐 `</code></pre>`；同时增加对 Markdown 表格（`table/thead/tbody/tr/th/td`）及 `h4`–`h6` 的支持。
  - 将流式输出按已闭合块切分为“稳定前缀块 DOM”与“活跃尾部块 DOM”，每帧仅更新尾部活跃节点。

---

### 4. `OcrService` 与 `EverythingService` 管道分块 UTF-8 解码截断导致中文乱码，且 `WM_COPYDATA` 缺乏 `dwId` 校验
- **涉及代码**：
  - `main/services/ocr-service.js` (`#L159`, `#L186-L187`)
  - `main/services/everything-service.js` (`#L209`, `#L236-L237`)
  - `native/everything-search/src/main.rs` (`#L153-L163`, `#L322-L325`)
- **根因分析**：
  1. **跨 Chunk 多字节 UTF-8 截断**：两个服务都只设置了 `child.stderr.setEncoding('utf8')`，漏掉了 `child.stdout.setEncoding('utf8')`，并在 `data` 事件中直接执行 `this.stdoutBuffer += chunk.toString('utf8')`。当返回的大段 JSON（大量 OCR 文本块或 600 条中文路径）跨越 64 KiB 管道缓冲区边界并恰好切开一个 3 字节 UTF-8 中文字符时，边界字符会变成两个 `U+FFFD` 替换符（``）。
  2. **Everything `WM_COPYDATA` 迟到包错位**：`native/everything-search/src/main.rs:322-325` 为每次查询分配了递增的 `dwId`，但 `reply_wndproc`（`#L153-L163`）收到 `WM_COPYDATA` 时未校验回传的 `EVERYTHING_IPC_LIST2.dwId`（偏移 `8..12` 字节）是否等于当前 `pending.query_id`。若前序探测查询 `"*.exe"` 超时后迟到返回，会张冠李戴覆盖用户当前查询的结果。
- **优化方案**：
  - 为 `child.stdout` 显式调用 `setEncoding('utf8')`。
  - 在 `QueryTask` 中记录 `query_id: u32`，并在 `reply_wndproc` 中校验 `dwId == pending.query_id`。

---

### 5. 主进程硬行数上限 (`MAIN_LINE_CEILING = 1330`) 催生的“单行 360 字符挤压”与门禁漏检
- **涉及代码**：
  - `scripts/check-architecture.js` (`#L25-L73`)
  - `main.js` (`#L71`, `#L304`, `#L495-L496`, `#L668`, `#L901-L929`, `#L1165`, `#L1175`, `#L1289`, `#L1306-L1327`)
  - `config/routes/settings.js` (`#L677`, `#L682`)、`config/routes/selection-toolbar.js` (`#L9`)
- **根因分析**：
  - `main.js` 当前为 **1329 行**，距离 `scripts/check-architecture.js:25` 的 `1330` 上限仅剩 1 行。为绕过行数门禁，代码中出现了大量用分号把多条语句挤在同一行（如 `main.js:1165`、`main.js:1289`）以及单行 350+ 字符的超长语句（如 `main.js:668`、`main.js:927`）。
  - `check-architecture.js:49-58` 的 `FORBIDDEN_IN_MAIN` 只检查了 `secureIpcMain.on('record:` 而未检查 `secureIpcMain.handle('record:`，导致 `main.js:1165` 直接在 `main.js` 散落注册了 `'record:pin-frame'`。
- **优化方案**：
  - 将托盘构建（`createTrayIcon`）抽离至 `main/domains/tray/index.js`，将 IPC 注册聚合至 `main/ipc/index.js`，为 `main.js` 释放 350+ 行空间并恢复可读的多行格式。
  - 在 `check-architecture.js` 中将正则升级为 `/secureIpcMain\.(on|handle)\('/`，并增加非模板行最大单行字符数限制。

---

## 三、 性能优化建议 (Performance Optimizations)

### 1. 设置、日志与历史存储：消除高频同步读盘、`JSON.parse` 与重复 DPAPI 解密 (P0)
- **涉及代码**：
  - `main.js` (`#L160-L185`, `#L309-L311`, `#L337`)
  - `main/services/settings-service.js` (`#L90-L127`)
  - `main/services/credential-store.js` (`#L188-L227`, `#L331-L363`)
  - `main/services/app-logger.js` (`#L16-L40`, `#L72-L99`)
  - `main/services/history-service.js` (`#L92-L104`, `#L374-L398`)
- **性能瓶颈**：
  1. **每写一行日志都同步读取解析一次完整的 `config.json`**：`main.js:337` 的日志开关回调写为 `isEnabled: () => ... && store.get('settings', {}).system?.runLog !== false`。`electron-store` 的 `store.get()` 无内存缓存，每次调用都会同步执行 `fs.readFileSync(configPath)` + `JSON.parse()`；且 `settings` 与 `captureHistory` 混存在同一个 `config.json` 中。
  2. **`getSettings()` 零缓存与重复 DPAPI 解密**：每次调用 `getSettings()` 都会同步读盘解析 `config.json`、执行全量归一化，并对每个配置的 AI 供应商调用 `safeStorage.decryptString()`（Windows DPAPI 同步系统调用）；`getPublicSettings()` 在 `getSettings()` 解密完一遍后，调用 `getCredentialState()` 又会重新遍历解密第二遍。
  3. **`app-logger.js` 每行日志 4 次同步 `fs` 调用 + 双重脱敏**：`app-logger.js:89-92` 每写一行日志都同步执行 `mkdirSync` + `existsSync` + `statSync` + `appendFileSync`，且 `formatLogMessage` 已执行过 `sanitizeValue`，第 78 行构造 `entry` 时又对 `message` 重复执行了第二次正则脱敏。
  4. **`HistoryService.list()` 全量同步 `fs.existsSync`**：每次分页查询（默认取 40 条）都会先对历史数组中的**全部**记录同步调用 `fs.existsSync(item.filePath)`（`main/services/history-service.js:377`）。
- **优化方案**：
  - 在 `SettingsService` 中增加内存快照缓存，仅在 `persistSettings` / `resetSettings` 时更新缓存；将 `main.js:337` 替换为读取内存布尔变量 `runLogEnabled`。
  - 将 `captureHistory` 从 `config.json` 拆分至独立的 `history/index.json` 并维护内存索引缓存。
  - 在 `app-logger.js` 中仅在启动和轮转时执行 `mkdirSync`/`statSync`，日常写入通过内存 `currentBytes` 累加判断轮转并采用异步流或 100ms 缓冲落盘。

---

### 2. 划词全局钩子：阻断日常打字与滚轮的跨进程 IPC 消息风暴 (P0)
- **涉及代码**：
  - `vendor/selection-hook/src/windows/selection_hook.cc` (`#L1215-L1283`, `#L1706-L1850`)
  - `main/services/selection-hook-host.js` (`#L66-L77`)
  - `main/domains/selection/index.js` (`#L288-L298`)
  - `main/services/selection-window-manager.js` (`#L546-L552`)
- **性能瓶颈**：
  - 用户在日常打字或浏览网页滚动滚轮时，系统范围内的**每一次按键按下 (`WM_KEYDOWN`)** 和**每一个滚轮刻度 (`WM_MOUSEWHEEL`)** 都会从 C++ 钩子线程通过 TSFN 投递到 `selection-hook-host` 子进程，再无条件通过 `parentPort.postMessage` 跨进程发往 Electron 主进程。
  - 主进程收到后调用 `hideToolbar()`（`selection-window-manager.js:546-552`），而 `hideToolbar()` **甚至没有检查 `win.isVisible()`** 就直接调用 `win.hide()`。
- **优化方案**：
  - 在 `hideToolbar()` 首行增加 `if (!this.isWindowHealthy(win) || !win.isVisible()) return`。
  - 在主进程与 `selection-hook-host.js` 之间同步 `toolbarVisible` 布尔标志：当悬浮工具条未显示时，子进程不再向主进程转发 `key-down`、`mouse-wheel`、`mouse-down` 事件（仅在 C++ 层保留 `highlighter::ObserveInput` 原子计数供剪贴板护栏使用），可消除日常使用中 99% 以上的后台 IPC 唤醒。

---

### 3. 录屏与视频导出：持久化分片 `FileHandle`、合并 FFmpeg 波纹滤镜与硬件加速编码 (P0)
- **涉及代码**：
  - `main/services/recording-service.js` (`#L317-L325`)
  - `shared/recording-export-options.js` (`#L689-L703`, `#L804-L826`, `#L870-L945`)
  - `record/recording-utils.js` (`#L605-L619`)
- **性能瓶颈**：
  1. **每秒重复 `open/write/close` 触发杀软重扫**：`RecordingService.appendChunk` 每秒调用 `await this.fs.appendFile(session.inputPath, buffer)`。传入路径字符串会导致每秒对 `capture.webm` 执行一次 `open` -> `write` -> `close(fd)`。在 Windows 上，写句柄 `close(fd)` 会发出 `IRP_MJ_CLEANUP` 触发 Windows Defender 微过滤器扫描整个大文件，录制 15~30 分钟后易引发 I/O 尖峰与回压暂停。
  2. **Demo 导出为每个点击波纹创建独立输入流与串联 `overlay` 滤镜**：`shared/recording-export-options.js:804-826` 对最多 30 个点击事件注入了 **30 个 `-loop 1 -i ripple.png` 输入流**，并在 `filter_complex` 中串联了 **30 个 `scale=eval=frame` + 30 个 `overlay` 节点**，每一帧画面都必须穿过 60 层滤镜。
  3. **纯 CPU 软编码**：MP4/WebM 导出硬编码使用 `libx264` / `libvpx-vp9`，在高分屏 + `zoompan` 合成时 CPU 满载且耗时较长。
- **优化方案**：
  - 在 `startSession` 中 `await this.fs.open(inputPath, 'w')` 持有持久 `FileHandle`，`appendChunk` 直接调用 `session.fileHandle.write()`，结束时统一 `close()`。
  - 将不重叠的点击波纹合并为 **1~2 个 `-loop 1 -i ripple.png` 输入流 + 分段表达式 `overlay` 节点**，将 60 个滤镜节点缩减至 2~4 个。
  - 启动时探测 `h264_nvenc` / `h264_qsv` / `h264_amf` 硬件编码器，可用时优先使用硬件加速并在失败时平滑回退到 `libx264`。

---

### 4. Everything 本地搜索：缓存目标窗口 `HWND`、保留托管索引进程并移除 PowerShell WMI 冷启动 (P1)
- **涉及代码**：
  - `native/everything-search/src/main.rs` (`#L358-L416`, `#L675-L686`)
  - `main/services/everything-service.js` (`#L159-L167`, `#L483-L538`)
- **性能瓶颈**：
  1. **每次查询都遍历全桌面窗口并发送 6 次探测请求**：Rust Sidecar 在处理每一次 `"query"` 时都会先调用 `resolve_target(&reply)`，执行 `EnumWindows` 遍历桌面上所有顶层窗口、发送 5 次同步 `SendMessageTimeoutW` 版本查询以及 **1 次 `"*.exe"` 的 `WM_COPYDATA` 探测搜索**。当开启“匹配路径”时，用户每输入 1 个字符前端会并发发起 2 次 `query`，导致每敲一个键都执行 2 次全桌面枚举和 4 次 Everything 搜索（其中 2 次是搜 `"*.exe"`）。
  2. **120s 空闲回收误杀托管 `Everything.exe` 且冷启动 PowerShell 耗时数秒**：`scheduleIdleStop()` 在 2 分钟空闲后调用 `this.stop()`，其中 `stopManagedEverything()` 会把后台 `Everything.exe` 索引进程也杀掉（导致下次搜索必须重新冷启动扫描磁盘），且 `probeProcessImagePath(pid)` 通过 `execFile('powershell.exe', [..., 'Get-CimInstance Win32_Process...'])` 校验路径，单次冷启动 PowerShell + WMI 耗时 **1~3.5 秒**。
- **优化方案**：
  - 在 `native/everything-search/src/main.rs` 中缓存 `cached_target: Option<TargetInfo>`，只要 `IsWindow(target.hwnd)` 有效就直接发送查询，仅在通信失败时重新 `resolve_target`。
  - 将 `stop()` 拆分为 `stopSidecar()`（供 120s 空闲回收调用，保留 `Everything.exe`）与 `dispose()`（应用退出时调用）；用 Win32 API `QueryFullProcessImageNameW`（耗时 <0.1ms）替代 PowerShell WMI。

---

### 5. 剪贴板管理：SQLite 内存计数缓存、缩短全局 `Barrier` 持锁时间与缩略图缓存定向淘汰 (P1)
- **涉及代码**：
  - `native/clipboard/src/storage.rs` (`#L448-L490`, `#L543`, `#L555-L577`, `#L927-L977`)
  - `native/clipboard/src/writer.rs` (`#L65-L135`, `#L162-L200`, `#L348-L406`)
  - `main/domains/clipboard/index.js` (`#L135-L140`)、`clipboard/clipboard.js` (`#L901`)
- **性能瓶颈**：
  1. **每次复制都执行全表聚合与 `maintain()`**：`Store::accept` 每次写入前执行 `SELECT COALESCE(sum(byte_length),0) FROM payloads`，写入末尾无条件同步调用 `self.maintain()?`（开启新事务执行排序裁剪、`incremental_vacuum(128)` 及 `wal_checkpoint(PASSIVE)`）。
  2. **在全局 `Barrier` 独占锁内解码 4K PNG 并做两次 64 MiB SHA-256**：`copy_item` 和 `prepare_paste` 先调用 `barrier.begin_local` 进入独占状态，随后才调用 `image_formats(bytes)` 解码大图、转换 BGRA 并对 64 MiB `CF_DIBV5` 计算 SHA-256；写入剪贴板后又在 `verify_formats` 中持锁读回 64 MiB 数据算第二遍 SHA-256（总耗时 150~350ms，极易导致另一侧 `selection-hook` 60ms 租约等待超时）。
  3. **每次 `history` 事件清空全部缩略图缓存**：每当新增记录或点击“固定/取消固定”触发 `history` 事件时，主进程 `invalidateThumbnails()` 与渲染进程 `thumbCache.clear()` 会将所有已缓存的缩略图全部清空。
- **优化方案**：
  - 在 `Store` 内存中维护 `item_count`、`pinned_count`、`payload_bytes` 增量计数；仅在 `item_count > history_limit` 时同步裁剪，把 `vacuum` 与 `checkpoint` 交给周期性的 `maintain_if_due()`。
  - 将 `image_formats(&bytes)` 移到 `barrier.begin_local` 之前执行；在 `verify_formats` 中当 `context.unchanged(generation)` 为真时仅校验 `GlobalSize` 而不再重复计算 64 MiB SHA-256。
  - 内容寻址的缩略图缓存仅在 `delete(ids)` / `clear` 时定向删除对应条目。

---

### 6. 截图、长截图与贴图：窗口预热、空白检测快速短路、单次流水线拼接与由粗到精帧匹配 (P1)
- **涉及代码**：
  - `main/domains/capture/index.js` (`#L597-L615`, `#L636-L649`, `#L726-L729`, `#L1036-L1128`)
  - `main/services/long-capture-session.js` (`#L73-L74`, `#L82-L116`)
  - `long-capture/long-capture.js` (`#L217-L284`)、`long-capture/matcher.js` (`#L72-L139`)
  - `main/services/pin-image-store.js` (`#L318-L357`)、`pin/pin.js` (`#L203-L222`)
- **性能瓶颈**：
  1. **每次截图冷启动 `BrowserWindow` + 重复 `spawn/kill` `SmartSelect.exe`**：每次呼出截图都重新创建窗口加载 5200+ 行 `capture.js` 并启停 `SmartSelect.exe`。
  2. **`isBlankCapture` 主进程同步解码 4K PNG**：`capture/index.js:726` 对每张截屏调用 `isBlankCapture(nativeImage.createFromBuffer(buffer))`，在主线程同步解码整张 4K PNG 并缩放转位图。
  3. **长截图完成时 4~5 次冗余全图编解码与同步拷贝**：`LongCaptureSession.render()` 先合成写盘 `composite.png`，若存在 `trimStart/trimEnd` 再把 `composite.png` 从磁盘读回完整解码并二次编码写盘 `result.png`（无裁剪则 `fs.copyFileSync` 复制一份），随后 `persistHistoryFile` 再次同步拷贝并连续两次调用 `sharp`。
  4. **长截图 `matcher.js` 伪粗搜死代码**：`matcher.js:92-102` 以步长 `1` 暴力遍历了所有 `shift`，导致 `#L105-L115` 在 `[coarseBestShift - 1, coarseBestShift + 1]` 范围内的“精搜”完全成为无效冗余代码。
  5. **`pin-image-store.js` 采用 FIFO 而非 LRU 驻留内存**：最先创建的贴图占满 32 MiB 预算后，后续所有新贴图被迫全部走磁盘 `startSpill`。
- **优化方案**：
  - 预热隐藏的截图 `BrowserWindow`，将 `SmartSelect.exe` 改为常驻守护进程（通过 `refresh` 指令刷新窗口树）。
  - 在 `isBlankCapture` 前增加 `if (buffer.length > 32 * 1024) return false`（全黑/纯白 4K PNG 压缩后通常 <15KB），99.9% 正常截图可零解码跳过。
  - `LongCaptureSession.render()` 直接根据 `trimStart/trimEnd` 计算条带偏移，单次 Sharp 流水线直出 `result.png`；滚动采集中一旦切出条带立即向 Worker 发送 `commit`，将 PNG 编码与异步写盘解耦到后台队列。
  - `matcher.js` 第一阶段改为 `step = 4` 或 1D 行均值向量粗搜，第二阶段仅在候选峰值邻域 `±4px` 内精搜（可降低 75% 匹配耗时）。
  - `pin-image-store.js` 在超出 32 MiB 预算时按 LRU 将最旧的 resident 贴图溢写到磁盘。

---

### 7. Token 用量统计、对话存储、OCR 与 AI 客户端优化 (P2)
- **涉及代码**：
  - `main/services/usage-collector.js` (`#L248-L280`)、`main/services/usage-feature.js` (`#L279-L290`)、`main/usage-scan-worker.js` (`#L186-L198`)、`main/services/usage-detail-query.js` (`#L31`)
  - `main/services/conversation-store.js` (`#L45-L103`)
  - `main/services/ocr-service.js` (`#L313-L327`)、`native/ocr/src/main.rs` (`#L90`, `#L139`)、`recognition/recognition.js` (`#L173-L228`)
  - `main/services/ai/client.js` (`#L94-L108`, `#L179-L190`, `#L533-L628`)、`main/services/translation-proxy-service.js` (`#L109-L128`, `#L268-L277`)
  - `main/services/data-root-migration.js` (`#L454`, `#L480`)
- **优化要点**：
  1. **Usage 模块**：在 `usage-collector.js:278` 调用 `commitScan` 前删除 `cursors.hourly`（避免将 24 个月的 `usage_bucket` 数据冗余 JSON 序列化进 `scan_state` 表导致 `usage.db` 膨胀一倍）；为 `usage-feature.js:284` 的 `getStatus()` 增加 30s 缓存，避免前端每次切换时间周期都在主进程对所有 DSH 会话文件同步 `fs.statSync`；在 `usage-detail-query.js:31` 对 `entry.models` 去重。
  2. **ConversationStore**：维护内存索引 `Map<id, { filePath, savedAt }>`，消除每次划词窗口失焦重建托盘时 `hasConversation()` 对目录下全部 20 个 JSON 文件的同步读取与解析。
  3. **OCR 与二维码**：将 `native/ocr/src/main.rs:139` 的 `FilterType::Lanczos3` 改为 `FilterType::CatmullRom` 并开启 ONNX `GraphOptimizationLevel::Level3`；通过 stdin 二进制帧传输图片字节流替代每次在临时目录落盘写 PNG；在 `recognition.js` 中优先使用 Chromium 原生 `BarcodeDetector`，回退 `jsQR` 时在候选循环间让出主线程。
  4. **AI 客户端与翻译代理**：在 `ai/client.js` 中缓存 `withConnectionFallback` 已探测成功的 `(baseUrl, protocol)` 避免每次请求先撞一次 404；将 `translateOcrTextBlocks` 改为带索引 `[{"i": 0, "t": "..."}]` 的 JSON 结构，仅对缺失索引并发补翻，消除因 LLM 合并断行导致的 24 次串行请求雪崩；为 `translation-proxy-service.js` 配置 `keepAlive: true` 的 `http/https.Agent`。
  5. **数据迁移**：在 `data-root-migration.js:454` 保存 `await createHistoryManifest(staging.history)` 的结果并在第 480 行直接复用，避免对同一批文件连续计算两遍全量 SHA-256。

---

## 四、 功能缺陷修复与体验优化建议 (Feature & UX Optimizations)

### 1. 截图与标注 (`capture`)
- **修复多选标注无法用鼠标一起拖拽移动** (`capture/capture.js:2189-2216`)：目前框选多个标注后支持批量改色和方向键微调，但鼠标拖拽 `beginPendingMove` / `moveAnnotationTo` 只记录并移动了鼠标按下的那 1 个标注。应在 `pendingMove` 中保存所有 `selectedIds` 的初始快照与联合包围盒并同步平移。
- **将文字标注的阻塞式 `window.prompt()` 升级为画布内联编辑器，并修复中文包围盒宽度截断** (`capture/capture.js:2923`, `capture/annotation-geometry.js:36, 173-177`)：
  - 使用内联浮动 `<textarea>` 替代原生 `prompt()`，支持多行输入、实时预览与双击已有文字标注重新编辑；
  - `TEXT_WIDTH_RATIO = 0.6` 按英文半角字符估算宽度，导致中文文字的包围盒比实际渲染宽度小 40%，选中框截断在文字中间且右半部分无法点击命中。应区分 CJK 全角字符（`1.0em`）与 ASCII 半角字符（`0.58em`）或基于 `ctx.measureText` 缓存真实包围盒。
- **接通截图导出 PDF 的结果反馈条** (`capture/capture.js:4551, 4907-4910`)：`capture.js` 已初始化 `exportResultBar` 与 `showExportResult(result)`，主进程 `exportPdf` 也返回了 `receipt`，只需在 `capture.js:4551` 接收返回值并调用 `showExportResult(receipt)`。

### 2. 长截图与贴图 (`long-capture` & `pin`)
- **修复长截图预览画布级联重采样模糊与非线性裁剪畸变** (`long-capture/long-capture.js:127-135, 221-261`)：`appendPreview` 在高度超过 1200px 时每次将旧画布乘以 `1000 / old.height` 缩小重绘，导致长图上半部分被反复缩放十几次后模糊成色块且纵向比例非线性失真，进而使 `updateTrimPreview` 的线性百分比裁剪线与实际裁剪位置严重错位。应改为维护固定缩略宽度的条带列表按统一比例绘制。
- **长截图自动剥离固定悬浮顶栏/底栏 (Sticky Header / Footer)** (`long-capture/long-capture.js:195-215`, `long-capture/matcher.js:20-25`)：对比相邻帧首尾静止行（`stickyTop` / `stickyBottom`），切取新增条带时避开固定栏，解决网页长截图每隔一屏出现重复导航栏的问题。
- **贴图支持非破坏性矢量重标注** (`main/domains/pin/index.js:1370-1436`)：从截图创建贴图时在 `_pinData` 中保留 `baseImageBuffer` 与矢量 `annotations` 快照（或关联 `documentId`），使右键“重新标注”能够选中、移动或删除原有标注，而非拍平为死像素。
- **消除跨 DPI 显示器拖拽贴图松手时的二次跳动与视图导出闪烁** (`main/domains/pin/index.js:432-460, 1706-1719`)：`pin:move-end` 应合并 `syncPinDisplayScale` 与 `applySnapOnDragEnd` 的目标 `bounds` 后只调用一次 `win.setBounds`；`exportPinView` 改为在渲染进程离屏 Canvas 直接合成图像与 OCR 叠层，避免向可见 DOM 注入隐藏样式后再 `capturePage()` 造成的边框闪烁。

### 3. 录屏与编辑器 (`record`)
- **修复窗口录制后点击“重新录制 (`editorRerecord`)”静默退化为全屏录制** (`main/domains/record/index.js:2990-3015`)：`editorRerecord` 只判断了 `if (project.mode === 'region')`，将 `project.mode === 'window'` 落入 `else` 分支强制按 `mode: 'display'` 全屏录制。应补充 `window` 分支重新查找绑定目标窗口或回退至录屏工作台。
- **修复重启应用后打开历史录屏项目丢失帧率 (`frameRate: 0`)** (`main/domains/record/index.js:1951-1961`)：`editorInitPayload` 仅读取内存 `probedMetadataByProject` 中的帧率，漏掉了 `|| Number(project?.captureConfig?.frameRate)` 回退，导致重启后打开历史项目无法选择 30/60 FPS 导出。
- **修复高分屏大窗口录制被 1920×1080 缩略图尺寸强制降采样** (`main/domains/record/index.js:55, 1383`, `record/record.js:1199-1207`)：`buildOutputCanvas` 应优先使用视频流首帧真实 `sourceVideo.videoWidth / videoHeight` 作为冻结画布尺寸；自身窗口过滤应结合 `win.getMediaSourceId()` 进行精确句柄过滤（`record/index.js:1348-1361`）。
- **优化双路混音静态 -6dB 衰减与动态调大增益削波爆音** (`record/audio-mixer.js:63-77, 265-274`)：移除静态 `masterGain = 1 / total`，保持 `master.gain.value = 1.0` 并在 `master` 与 `destination` 之间串联 WebAudio `DynamicsCompressorNode`（配置为软限幅器 Limiter），兼顾单路 100% 原始响度与双路叠加防爆音。
- **Direct-Track 模式下提前禁用标注入口** (`record/record.js:1307-1314, 2472-2474`)：在 Direct-Track 生效时应在 UI 上禁用屏幕标注按钮，避免用户落笔后直接触发 `annotations-present` 报错并强行中断正在进行的录屏。

### 4. 划词、AI、OCR、剪贴板与本地搜索 (`selection` / `ai` / `ocr` / `clipboard` / `search`)
- **将应用黑名单下发至 C++ 原生层并默认保护终端程序免受 `Ctrl+C` 注入** (`main/services/selection-hook-host.js:86`, `vendor/selection-hook/src/windows/core/engine.cc:132-145`)：目前 `shouldFilterApp` 仅在主进程接收事件后过滤，导致黑名单应用（及终端程序）在开启剪贴板回退时仍被 C++ 线程注入 `Ctrl+C`（在终端中会直接发送 `SIGINT` 中断正在运行的命令）。同时在 `vendor/selection-hook/src/windows/lib/clipboard.cc:191` 中将 `BackupClipboard` 的格式计数置于 `IsSkippedFormat` 之后并将上限从 64 提升至 256。
- **解除全局单一 `processing` 锁对新划词及本地复制/搜索动作的阻塞** (`main/domains/selection/index.js:92, 439`, `main/ipc/selection-ipc.js:36`)：将流控制器按窗口实例绑定；当一个已固定（Pin）的结果窗正在长考生成时，允许正常触发新的划词复制、搜索或新窗口问答；未固定窗口 `blur` 隐藏时允许当前轮次在后台继续流式完成并写入 `ConversationStore`。
- **修复专有名词翻译回声检测 (`isTranslationEcho`) 报错与纯汉字日文语种误判** (`main/services/ai/client.js:327-332, 387-406`)：划选 `"DeepSeek"`、`"GitHub"` 等专有名词时模型返回原文属于合理结果，重试一次后若仍相同应作为正常译文输出而非抛错中断；在 `translation-proxy-service.js:65-70, 271-275` 中透传客户端 `Authorization` 头并补充 `Access-Control-Allow-Private-Network: true`。
- **修复剪贴板面板 `Ctrl+Enter` 粘贴因手指未在 300ms 内松开 `Ctrl` 而失败 (`FOCUS_OR_KEYS_BUSY`)** (`clipboard/clipboard.js:793-795`, `native/clipboard/src/paste.rs:148-167, 368-395`)：放宽修饰键释放等待窗口至 600ms，或在其他修饰键已释放且目标窗口焦点就绪时复用已按下的 `Ctrl` 状态完成粘贴。
- **重构 OCR 表格识别的列聚类算法并输出合并单元格 `merges`** (`capture/recognition-utils.js:72-92, 116-153`)：用 **1D 水平区间投影聚类** 替代目前的“行块数众数 + 数组下标取中位数”，解决稀疏表格列数低估与列锚点错位问题，并向 `main/services/table-workbook.js:188` 输出跨列 `merges`。
- **修复本地搜索 `.exe`/`.lnk` 图标全部混淆、文件夹显示为 `?` 及双查询合并排序断裂** (`search/search.js:201-206, 254-279`, `search/search-utils.js:59-87`, `native/everything-search/src/main.rs:532`)：对 `.exe`/`.lnk`/`.ico` 按完整路径缓存图标；在 Everything Sidecar 请求 `REQ_ATTRIBUTES` 识别目录并渲染文件夹 SVG 图标；在 `mergeQueryResults` 中按用户选择的 `sortMode` 对合并结果统一排序。

### 5. 配置中心与主窗口生命周期 (`config` & `main-window-reclaimer`)
- **开放底层已实现的“截图水印 (Watermark)”设置 UI** (`main/services/settings-defaults.js:84`, `config/routes/settings.js:350-365`)：底层配置校验与渲染均已支持 `screenshot.watermark`，仅需在“功能设置 -> 截图与输出”中补齐表单控件即可零后端成本上线水印配置。
- **修复路由切换时的 `historySearchTimer` 跨路由 DOM 覆写与 `main-window-reclaimer` 竞态** (`config/routes/history.js:486-515, 586`, `main.js:829-837`, `config/routes/models-provider.js:28`)：
  - 在 `renderHistoryPage` 首行校验 `if (currentRoute !== 'history') return`，并在路由离开时清理 `historySearchTimer`；
  - 在 `mainWindow` 显示时调用 `mainWindowReclaim.disarm()`；
  - 修复 `'models-provider-settings'` 未注册进 `ROUTE_DRAFT_REASONS.models` 导致主窗口永久无法被空闲回收的泄漏，并为 `chat` / `translation` / `usage` 价格编辑补充脏状态保护；
  - 修复 `config/routes/translation.js:23` 点击 `#swapLanguage` 只交换文本未交换源/目标语言下拉框的问题；在 `config/routes/recording.js:1513` 离开路由时调用 `cancelRecordingPreflight()`。

---

## 五、 高价值创新功能建议 (New Feature Proposals)

### 1. 智能隐私脱敏助手（截图一键自动打码 / Auto-Redact）
- **背景与价值**：用户在分享研发或办公截图前，常需手动涂抹 API Key（`sk-...`）、手机号、邮箱、身份证号、内网 IP 等敏感信息。
- **实现路径**：在截图马赛克工具二级面板新增**「智能脱敏」**按钮，调用本地 `OcrService` 提取 `textBlocks` 坐标框，结合内置敏感信息正则规则库自动批量生成 `{ type: 'blur' }` 可编辑标注层（受现有 `shared/occlusion-mask.js` 保护，支持单步撤销或点选删除单个打码框）。

### 2. 历史截图全文 OCR 索引检索 & 剪贴板图片一键 OCR / 转表格 / 转贴图
- **背景与价值**：`main/services/history-service.js:35-36` 的 `matchesHistoryFilter` 已经预留了对 `item.ocrText` 和 `item.tags` 的检索逻辑，但目前没有任何地方写入这两个字段；同时剪贴板面板（`clipboard/clipboard.js:479`）对图片记录隐藏了扩展动作入口。
- **实现路径**：
  - 在截图保存后利用空闲的 `OcrService` 后台提取图中文字写入历史记录 `ocrText`，并在历史页支持自定义 `tags`，让用户直接搜图中文字即可定位历史截图；
  - 在剪贴板图片预览层与右键菜单中提供**「提取文字 (OCR)」、「识别为 Excel 表格」与「固定为桌面贴图 (Pin)」**一键操作。

### 3. 录屏「快捷键胶囊 HUD 轨 (Keystroke Visualizer)」与「一键剔除静音停顿段」
- **背景与价值**：录屏模块已具备独立 `utilityProcess` 采集的鼠标轨迹与点击事件轨（`events.json`）及非破坏性时间轴剪辑器。
- **实现路径**：
  - 在录制期间同步采集带修饰键的快捷键组合（如 `Ctrl+Shift+P`、`Alt+Tab`，自动忽略普通连续打字以防泄露密码）存入 `events.json`，在编辑器中支持一键开启底部快捷键胶囊提示；
  - 结合音频音量包络与鼠标静止区间，在编辑器时间轴提供**「一键裁剪空白停顿」**，自动调用 `trim-controller.js` 切分并剔除静音停顿片段。

### 4. 本地搜索窗口「空格键快速预览 (Quick Look)」与「原生文件拖拽发送」
- **实现路径**：
  - 参照剪贴板窗口已有的空格预览交互（`clipboard/clipboard.js:797-804`），在本地搜索窗口（`search/search.js`）支持按 `Space` 键即时预览图片、代码、Markdown、JSON 与文本文件；
  - 接入 Electron `webContents.startDrag({ file: item.fullPath, icon })`，支持直接从搜索结果列表将文件拖拽到微信、钉钉、VS Code 或浏览器中。

### 5. 贴图「UI 像素对齐洋葱皮模式 (Pixel Diff)」与「贴图工作区快照」
- **实现路径**：
  - 在贴图开启“点击穿透 + 半透明”时，支持快捷键切换 `mix-blend-mode: difference` 或 1Hz 交替闪烁，辅助前端与设计师 1:1 像素级比对设计稿；
  - 支持将当前桌面上所有活跃贴图的位置、缩放、旋转与矢量标注一键保存为「贴图工作区快照」，随时挂起或恢复整组参考图。

### 6. 配置中心「全局搜索 (`Ctrl+K`)」与「密码加密单文件 ZIP 备份（含 API Key 迁移）」
- **实现路径**：
  - 在主窗口侧边栏顶部提供全局搜索框（`Ctrl+K`），输入关键词即可检索并直达 15 个路由及子 Tab 下的具体设置项；
  - 复用已安装的 `adm-zip`（`package.json:186`）支持导出单文件 `.hlbackup.zip`，并提供可选的“设置备份主密码（基于 `scrypt` + `AES-256-GCM` 加密 API 密钥）”，解决用户换机恢复备份后需重新配置所有 AI 供应商 API Key 的痛点。
