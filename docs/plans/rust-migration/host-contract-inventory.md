# R0-02 宿主合同盘点与差异清单

日期：2026-11-10。状态：**R0 证据，不是生产合同**。实现规格见
[`contract-format.md`](../../../docs/plans/rust-migration/contract-format.md)；上位计划见
[`2026-11-10-rust-migration-development-plan.md`](../2026-11-10-rust-migration-development-plan.md) §4、§5.1、§9.1、§10。

本文件登记**从现有 JS 源码实际提取**的结果、与计划 §4.1/§5.1/§9.1 的差异、无法自动解析的
`knownGaps`、未生成夹具的原因。只陈述证据，不修改 `main/`、`preload*.js`、`shared/`。

## 1. 产物与复现

| 产物 | 内容 |
|---|---|
| [`contracts/host/host-contracts.json`](../../../contracts/host/host-contracts.json) | 13 角色、257 个已解析方法、142 个 handles、49 个 listeners、62 个 receives、10 个错误码、8 项 §9.1 限制、6 项 §5.1 schema |
| [`contracts/host/README.md`](../../../contracts/host/README.md) | 消费说明与格式扩展 |
| `test/fixtures/host-parity/` | 5 组、28 个 case + `manifest.json`（每个 case 一个 sha256） |
| `scripts/rust/extract-host-contracts.js` | 清单提取（vm 桩执行真实 preload） |
| `scripts/rust/generate-host-fixtures.js` | 夹具生成/校验 |
| `test/host-contracts.test.js` | 19 个断言测试 |

复现（本分支实测，2026-11-10）：

```text
$ node scripts/rust/extract-host-contracts.js --check
contracts/host/host-contracts.json is up to date (13 roles, 257 methods, 110493 bytes)   # exit 0

$ node scripts/rust/generate-host-fixtures.js --check
test/fixtures/host-parity/manifest.json and 28 case files are up to date                # exit 0

$ node --test test/host-contracts.test.js
ℹ tests 19   ℹ pass 19   ℹ fail 0

$ npm run check
Syntax check passed for 489 JavaScript files. / architecture-check: ok / i18n TOTAL 595  # exit 0
```

确定性：两个生成器只读源码、`require` 现有模块或以 `vm` 桩执行 preload；无时间戳、随机数、
绝对路径、主机名、网络和 Electron。`--check` 逐字节比较并在不一致时打印首个差异行与 sha256。

## 2. 13 角色：计划 §4.1 声称 vs 实际暴露

计划 §4.1 的表格把以下角色两两合并成一行：`toolbar / action`、`long-capture / long-overlay`、
`record / record-frame`，因此表格是 10 行、实际 13 个角色。**"13 个角色/API" 的说法与实际一致**；
计划列出的全局对象名与 `contextBridge.exposeInMainWorld(...)` 实测结果逐个相同。

`methods` = 执行 preload 后真实观测到的暴露方法数（已解析）；`knownGaps` 见 §4。

| 角色 | 页面 | preload | 全局对象 | methods | invoke | send | subscribe | handles | listeners | receives | knownGaps |
|---|---|---|---|---|---|---|---|---|---|---|---|
| action | `action/action.html` | `preload-action.js` | `actionAPI` | 15 | 2 | 4 | 9 | 2 | 4 | 9 | 0 |
| capture | `capture/capture.html` | `preload-capture.js` | `captureAPI` | 33 | 25 | 5 | 3 | 21 | 5 | 3 | 0 |
| clipboard | `clipboard/clipboard.html` | `preload-clipboard.js` | `clipboardAPI` | 20 | 11 | 3 | 6 | 11 | 3 | 6 | 0 |
| long-capture | `long-capture/long-capture.html` | `preload-long-capture.js` | `longCaptureAPI` | 10 | 4 | 3 | 3 | 4 | 3 | 3 | 0 |
| long-overlay | `long-capture/overlay.html` | `preload-long-overlay.js` | `longOverlayAPI` | 6 | 0 | 2 | 4 | 0 | 2 | 4 | 0 |
| main | `config/config.html` | `preload.js` | `electronAPI` | 73 | 63 | 3 | 7 | 62 | 3 | 7 | 0 |
| pin | `pin/pin.html` | `preload-pin.js` | `pinAPI` | 21 | 1 | 13 | 7 | 1 | 13 | 7 | 0 |
| recognition | `recognition/recognition.html` | `preload-recognition.js` | `recognitionAPI` | 10 | 6 | 2 | 2 | 6 | 2 | 2 | 0 |
| record | `record/record.html` | `preload-record.js` | `recordAPI` | 29 | 16 | 5 | 8 | 16 | 5 | 8 | 0 |
| record-editor | `record/editor.html` | `preload-record-editor.js` | `recordEditorAPI` | 17 | 11 | 3 | 3 | 11 | 3 | 3 | 0 |
| record-frame | `record/frame.html` | `preload-record-frame.js` | `recordFrameAPI` | 5 | 0 | 2 | 3 | 0 | 2 | 3 | 0 |
| search | `search/search.html` | `preload-search.js` | `searchAPI` | 15 | 8 | 3 | 4 | 8 | 3 | 4 | 0 |
| toolbar | `toolbar/toolbar.html` | `preload-toolbar.js` | `toolbarAPI` | 3 | 0 | 1 | 2 | 0 | 1 | 3 | 2 |

合计：257 个已解析方法（invoke 147、send 49、subscribe 61），另 1 个暴露方法无法解析（`toolbar.onSelection`，见 §4）。
`main` 有 63 个 invoke 方法但只有 62 个 handle channel：`testConnection` 与 `fetchProviderModels`
共用 `config:test-connection`（预载有意如此），所以按 channel 去重后权限一致。

### 计划 §4.1 "现有外部接口应保持兼容" 逐项核对

| 计划接口 | 实测 | 调用方式 / channel | 源码 |
|---|---|---|---|
| `captureAPI.commitDocument(payload)` | 存在 | invoke `capture:commit-document` | `preload-capture.js:46` |
| `captureAPI.commitStatus(payload)` | 存在 | invoke `capture:commit-status` | `preload-capture.js:48` |
| `captureAPI.loadDocument(payload)` | 存在 | invoke `capture:load-document` | `preload-capture.js:50` |
| `recordEditorAPI.saveDraft(projectId, expectedRevision, edit)` | 存在 | invoke `record-editor:save-draft` | `preload-record-editor.js:30` |
| `recordEditorAPI.exportProject(projectId, requestId, request)` | 存在 | invoke `record-editor:export` | `preload-record-editor.js:31` |
| `recordEditorAPI.exportStatus(query)` | 存在 | invoke `record-editor:export-status` | `preload-record-editor.js:32` |
| `recordEditorAPI.cancelExport(query)` | 存在 | invoke `record-editor:cancel-export` | `preload-record-editor.js:33` |

（`cancelExport` 的 channel 为 `record-editor:cancel-export`，与计划只给方法名一致。）7 个兼容接口
全部以 invoke/Promise 形式存在；`send`/订阅型方法分别登记在各自角色的 `methods[].kind` 中，
没有被强行改成 Promise。

## 3. `IPC_SURFACES` 之外的窗口 / preload

根目录 13 个 `preload*.js` 与 `IPC_SURFACES` 的 13 个角色一一对应，没有多余的已暴露 preload。
但存在一个**不在 `IPC_SURFACES` 注册**的辅助窗口：

| 窗口 | 页面 | preload | 证据 | 结论 |
|---|---|---|---|---|
| 离屏 PDF 打印窗口 | `capture/print.html` | `preload-capture.js`（默认 `preloadPath`） | `main/services/pdf-export.js:381`（页面默认值）、`:382`（preload 默认值）、`:383` 起 `openPrintWindow`；`main/domains/capture/index.js:869` 传入 `createLocalWindow` | 页面不在 `IPC_SURFACES`，`buildIpcPolicies` 不为它生成策略；该窗口即使暴露 `captureAPI`，任何 invoke/send 都会在 `page-not-allowed` 处被拒绝。Rust 侧不应对打印窗口开放任何角色能力。 |

已登记为 `host-contracts.json` 顶层 `knownGaps`（`kind: "auxiliary-window-not-in-ipc-surfaces"`）。
其它窗口（主窗、clipboard、toolbar、action、capture、long-capture/overlay、pin、recognition、
search、record/record-frame/record-editor）全部来自 `createSecureWindow` 且页面已注册；
`clipboard` 域建窗时传入的 `role: 'clipboard-panel'` 只是窗口注册表/内存快照的元数据
（`window-security.js:103-119` 会把它从 BrowserWindow 选项中剥离），不是 IPC 角色。

## 4. `knownGaps` 登记（无法自动解析 / 与权限面不一致）

| 位置 | 种类 | 项 | 源码 | 原因 |
|---|---|---|---|---|
| 其余 12 个角色 | — | 无 | — | 除下表外，所有暴露方法都能观测到唯一 IPC 通道，且 invoke⊆handles、send⊆listeners 成立 |
| role=toolbar | `method-not-resolved` | `toolbarAPI.onSelection(callback)` | `preload-toolbar.js:21` | 该方法只把回调存进模块变量，真正的 `ipcRenderer.on('selection:text', …)` 在 preload 模块顶层注册（下一行）；用合成参数调用不会产生可归属的 IPC 调用 |
| role=toolbar | `module-level-subscription` | channel `selection:text` | `preload-toolbar.js:6` | 订阅发生在模块求值阶段，无法归到某一个暴露方法；只能登记，不能猜归属 |
| top-level | `auxiliary-window-not-in-ipc-surfaces` | 页面 `capture/print.html`，roles `["capture"]` | `main/services/pdf-export.js:381` | 见 §3；页面未在 `IPC_SURFACES` 注册，任何 IPC 都会被 `page-not-allowed` 拒绝 |

`toolbar.onSelection` 是唯一未能解析的暴露方法（1/258）；它不出现在 `methods[]`，只出现在
`knownGaps`，测试会强制"方法 ∪ knownGaps = 实际暴露方法集"，防止静默遗漏。
此外未发现 invoke/send 通道与 `IPC_SURFACES` 权限面不一致的项。

## 5. 夹具清单

`test/fixtures/host-parity/manifest.json` 记录 5 组 28 个 case 的 sha256：

| 组 | 格式 | case 数 | 覆盖 |
|---|---|---|---|
| `capture-document` | `capture-document.v3` | 5 | v3 有效（普通输出 800×600）、v3 有效（`card-light`：留白/阴影后成品 992×804，符合 §5.1 几何规则）、v2→v3 载入升级、未知 schemaVersion（invalid）、缺 `baseImage`（invalid） |
| `clipboard-protocol` | `clipboard-protocol.v1` | 12 | 单帧无/带 payload、跨 chunk 分片、一次 feed 多帧、`finish()` 截断；非法 `kind`、`headerBytes > MAX_HEADER`、`payloadBytes > MAX_CHUNK`、`size < 5`、`size > MAX_FRAME`、header 非 JSON 对象（`null`）、header 非法 JSON |
| `recording-export-options` | `recording-export-options.v1` | 5 | §9.1 限制回显（queue/gif/segments）、GIF 长边裁剪到 1280、小源不放大、多段导出归一化、GIF 超 60 s（invalid） |
| `recording-project` | `recording-project.v1` | 4 | 正常项目（两段 keepRanges）、空 keepRanges=整段、区间重叠（invalid）、schemaVersion+fileName 损坏（invalid） |
| `settings` | `settings.normalize.v1` | 2 | 默认配置 + 覆盖（语言/主色/非法颜色与宽度的规范化、空 historyDirectory 回落到固定合成数据根）、legacy `fixedContent.autoSaveDirectory` 被丢弃 |

未生成/暂缺的组：**无**。§4.5 的可选 `settings` 组已生成——`main/services/settings-normalize.js`
与其依赖在无 Electron 的 Node 下可直接加载，且输出确定（同输入两次运行逐字节相同）。
夹具全部为合成数据：固定 ID（`fixture-doc-001` 等）、固定时间戳 `1731000000000`、固定尺寸；
无本机绝对路径、无用户数据、无真实凭据（测试会扫描每个 case 的 JSON 并断言不存在盘符路径、
用户目录路径、file URL、非空 `apiKey`）。

## 6. 计划 §9.1 硬限制（8 项，全部登记）

| id | 值 | 源码 | 符号 | 提取方式 |
|---|---|---|---|---|
| `capture.commit-receipts` | `{"maxReceiptsPerDocument":32}` | `main/services/capture-document-service.js` | `MAX_RECEIPTS_PER_DOCUMENT` | module |
| `clipboard.protocol` | `{"maxFrameBytes":1048576,"maxHeaderBytes":524288,"maxPayloadChunkBytes":262144}` | `shared/clipboard-protocol.js` | `MAX_FRAME`/`MAX_HEADER`/`MAX_CHUNK` | module |
| `clipboard.thumbnail-cache` | `{"maxBytes":8388608,"maxEntries":128}` | `main/services/clipboard-thumbnail-cache.js` | `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_ENTRIES` | module |
| `long-capture` | `{"maxLongEdgePx":200000,"maxPixels":200000000}` | `main/services/long-capture-session.js` | `MAX_LONG_EDGE`/`MAX_PIXELS` | module |
| `recording.event-track` | `{"maxPointerEvents":20000,"maxClickEvents":2000}` | `shared/recording-demo.js` | `POINTER_LIMIT`/`CLICKS_LIMIT` | module |
| `recording.export-queue` | `{"maxConcurrentEncodes":1,"maxPending":2}` | `shared/recording-export-options.js` | `LIMITS.MAX_ACTIVE_TASKS`/`LIMITS.MAX_QUEUED_TASKS` | module |
| `recording.gif` | `{"maxDurationMs":60000,"maxLongEdgePx":1280,"maxFrames":1200,"fps":[10,15,20]}` | `shared/recording-export-options.js` | `LIMITS.GIF_*`/`GIF_FRAME_RATES` | module |
| `recording.segments` | `{"maxSegments":20,"maxSegmentMs":100}` | `shared/recording-export-options.js` | `LIMITS.MAX_SEGMENTS`/`LIMITS.MIN_SEGMENT_MS` | module |

`test/host-contracts.test.js` 会重新 `require` 这些模块并逐值比较，JS 改上限而清单没改会失败。

## 7. 计划 §5.1 存储 schema（6 项，全部登记）

| 对象 | 版本 | 源码证据 | 说明 |
|---|---|---|---|
| 截图文档 | v3 | `shared/capture-document.js` `SCHEMA_VERSION` | 旧版本经 `MIGRATIONS` 链升级，夹具含 v2→v3 用例 |
| 录屏项目 | v1 | `shared/recording-project-schema.js` `SCHEMA_VERSION` | `keepRanges` 为媒体毫秒半开区间，空数组=整段 |
| 剪贴板 DB | `user_version=2` | `native/clipboard/src/storage.rs`（`PRAGMA user_version=2`，schema 见 `schema-v2.sql`） | 该 DB 已由现有 native Rust 剪贴板实现持有；注意 v2 的 `kind` 白名单新增 `files` |
| 用量 DB | `user_version=1` | `main/services/usage-store.js` `SCHEMA_VERSION`，落盘写 `PRAGMA user_version = ${SCHEMA_VERSION}` | 只有聚合桶/扫描游标，不含对话内容 |
| 数据根 marker | v3 | `main/services/data-root-migration.js` `MARKER_VERSION` | 兼容 v1/v2 marker；`MARKER_VERSION` 未从模块导出，清单用静态常量提取并标注 `extraction: "static"` |
| settings 规范化 | 无版本号 | `main/services/settings-normalize.js` `createSettingsNormalizer` | 该对象没有 schemaVersion；清单登记 `version: null` + `normalizeSymbol`，不编造版本 |

## 8. 错误码（10 项）

| code | 方向 | 源码 | 含义 |
|---|---|---|---|
| `missing-or-destroyed-sender` | deny | `main/services/ipc-security.js:346` | sender 缺失/已销毁 |
| `non-top-level-frame` | deny | `main/services/ipc-security.js:350` | 非主 frame |
| `unregistered-window` | deny | `main/services/ipc-security.js:353` | 窗口未注册 |
| `invalid-window-owner` | deny | `main/services/ipc-security.js:357` | sender 不属于注册的 BrowserWindow |
| `sender-url-mismatch` | deny | `main/services/ipc-security.js:361` | sender URL 不是注册页面 |
| `page-not-allowed` | deny | `main/services/ipc-security.js:365` | 页面路径没有该 channel 策略 |
| `window-owner-mismatch` | deny | `main/services/ipc-security.js:369` | `authorizeRole` 拒绝该窗口 |
| `blocked-navigation` | block | `main/services/window-security.js:87` | 导航到非允许 URL |
| `blocked-webview` | block | `main/services/window-security.js:94` | webview 挂载被拒绝 |
| `blocked-window-open` | block | `main/services/window-security.js:97` | `window.open` 被拒绝 |

## 9. 测试映射方法与局限

- `methods[].tests` 的取值规则：扫描 `test/*.test.js`，若文件文本包含该 channel 的带引号字面量
  （`'channel'` / `"channel"` / 反引号）就登记。它只表示"这些测试提到过该 channel"，**不是覆盖率
  承诺**，也不代表测试真的断言了返回结构；真正冻结参数/返回结构仍需在 R1/R2 的合同测试中补齐。
- 订阅型方法（`kind=subscribe`）的 `tests` 同样按 channel 匹配；主→渲染推送 channel 不在
  `IPC_SURFACES` 中，因此没有 permissions 校验，只登记在 `surface.receives`。
- `baseline.node` / `baseline.electron` / `baseline.gitCommit` 是计划声明值，不是本机现测值：
  `gitCommit` 取计划 §1 的 `3df712976fdeeef1f1dce47a81995cfabdee8ee9`（保证 `--check` 在提交后
  仍稳定），`node` 取格式草案 `24.22.1`。提取脚本会把实际 `git rev-parse HEAD` 打到 stderr 提示。
- 清单只覆盖**外部表面**；计划 §4.2 的 `WindowHost`/`CaptureBackend` 等新内部接口、TypeScript
  类型生成、资源二进制通道均不在本清单范围内（见 `contract-format.md` §1 非目标）。
- 夹具每组的输入/期望都由现有 JS 实现在生成时实际计算并断言，但 Rust 侧仍需在 R1/R4/R5 中
  用同一批夹具做双端对照；本轮没有 Rust 断言（`rust-app/` 由并行任务提供）。

## 10. 与计划/格式草案的差异汇总

1. **§4.1 表格是 10 行、角色是 13 个**：合并单元格（toolbar/action、long-capture/long-overlay、
   record/record-frame）造成，实际角色数与计划文字一致；清单按 13 个角色分别登记。
2. **`main` 的 handle 数 < invoke 方法数**：`config:test-connection` 被两个方法复用，按 channel
   去重后一致，不构成权限差异。
3. **`toolbar.onSelection`** 无法用运行时调用归因到 channel（模块级订阅），已列 `knownGaps`；
   同文件的 `selection:text` 订阅也因此登记为模块级项。
4. **`capture/print.html` 离屏打印窗口**暴露 `preload-capture.js` 但没有 `IPC_SURFACES` 角色，
   已登记；它不是"第 14 个角色"，不应获得任何 IPC 权限。
5. **settings 没有 schemaVersion**，`sharedSchemas` 中该项 `version: null`；格式草案要求登记版本，
   这里用 `normalizeSymbol` + 夹具补证据，不编造版本号。
6. **`data-root-marker` 的常量未导出**：`MARKER_VERSION` 只在模块内部使用，提取脚本改用静态
   `const MARKER_VERSION = 3` 提取并标注 `extraction: "static"`。
7. **§9.1 事件轨两个上限**（pointer 20,000 / click 2,000）来自 `shared/recording-demo.js` 的
   `POINTER_LIMIT`/`CLICKS_LIMIT`，不是单独文档；已在资源限制中登记。
