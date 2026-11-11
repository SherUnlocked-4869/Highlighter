# R0-01 功能对齐基线矩阵（feature parity）

日期：2026-11-10（Asia/Hong_Kong）。状态：**R0 证据文档（草案）**。
上位文档：[Rust 改造方案与开发计划](../2026-11-10-rust-migration-development-plan.md)（下称"计划"）§4.1/§6/§7/§9.1/§12、[可行性调研](../../research/2026-11-10-rust-migration-feasibility.md)、[R0 合同格式](contract-format.md)。配套基线记录：[r0-baseline.md](r0-baseline.md)。

**门禁声明：本文件不构成任何 gate 已通过的证据。G0～G4 全部未通过。R0 只登记本分支实际完成的部分（截至本文件写作时：R0-01 文档本身），真机/性能/安装包验证一律为"未执行"或"未验证"，不以单测或静态推断替代。**

## 0. 证据口径

| 项 | 值 | 证据 |
|---|---|---|
| 产品源码基线 | `3df712976fdeeef1f1dce47a81995cfabdee8ee9`（与计划声明一致，是 4.2.0 之后最后一个产品提交） | `git rev-parse 3df7129`；`git log --oneline` |
| 本分支 HEAD | `82c0b414b8ad310467335fa0a768efd33891d9fd`（`codex/rust-r0-baseline-contracts`） | `git rev-parse HEAD` |
| HEAD 相对产品源码的差异 | 仅文档 + `.gitignore` 行尾变化：4 files changed, 1185 insertions(+), 30 deletions(-) | `git diff --stat 3df7129..HEAD` |
| 应用版本 / Electron | Highlighter `4.2.0` / Electron `43.8.3` | `package.json:3`、`node_modules/electron/package.json`（本轮实测） |
| 运行时版本 | Node `v24.22.1`、rustc/cargo `1.97.1` | 本轮实测，见 r0-baseline.md §1 |

口径约定：

1. **"现有测试"只表示仓库里存在该测试文件/探针，不等于本轮运行通过。** 本轮未执行 `npm test`、`npm run test:e2e`、覆盖率、打包（见 §8）。
2. 缺陷/未验证项必须给出源码、测试或文档证据（`文件:行`）。没有找到缺陷记录的项写"无已记录缺陷"，不臆测。
3. 行号取本分支 HEAD 的实际行号；后续提交改动后以文件内容为准。
4. 本文件不修改 `main/`、`preload*.js`、`shared/` 的任何生产行为；发现实现与计划不一致时只登记（R0-02 的 `host-contract-inventory.md` 负责更细的清单）。

## 1. 13 个页面角色 → 页面 → preload → globalObject 核对表

来源：`main/services/ipc-security.js:8` 的 `IPC_SURFACES`（`node -e "require('./main/services/ipc-security').IPC_SURFACES"` 实测，13 项，按数组顺序）；preload 暴露对象来自各 `preload*.js` 的 `contextBridge.exposeInMainWorld`；窗口创建位置来自主进程实际代码（不是按文件名猜测）。`handles`/`listeners` 是该角色在 `IPC_SURFACES` 里登记的 IPC 通道数。

| # | role | page | preload（暴露行） | globalObject | handles / listeners | 窗口创建位置 | 计划迁移批次（计划 §4.1） |
|---:|---|---|---|---|---:|---|---|
| 1 | main | `config/config.html` | `preload.js:3` | `electronAPI` | 62 / 3 | `main.js:825`（page `:839`，preload `:853`） | R1 基础，R2/R6/R7 补齐业务 |
| 2 | clipboard | `clipboard/clipboard.html` | `preload-clipboard.js:7` | `clipboardAPI` | 11 / 3 | `main/domains/clipboard/index.js:195`（preload `:198`） | R3 |
| 3 | toolbar | `toolbar/toolbar.html` | `preload-toolbar.js:14` | `toolbarAPI` | 0 / 1 | `main/services/selection-window-manager.js:137` | R3 + R6 |
| 4 | action | `action/action.html` | `preload-action.js:66` | `actionAPI` | 2 / 4 | `main/services/selection-window-manager.js:241` | R3 + R6 |
| 5 | capture | `capture/capture.html` | `preload-capture.js:3` | `captureAPI` | 21 / 5 | `main/domains/capture/index.js:431`（preload `:507`） | R0 验证，R4 完整迁移 |
| 6 | long-capture | `long-capture/long-capture.html` | `preload-long-capture.js:3` | `longCaptureAPI` | 4 / 3 | `main/domains/long-capture/index.js:149`（preload `:162`） | R4 |
| 7 | long-overlay | `long-capture/overlay.html` | `preload-long-overlay.js:3` | `longOverlayAPI` | 0 / 2 | `main/domains/long-capture/index.js:131`（preload `:144`） | R4 |
| 8 | pin | `pin/pin.html` | `preload-pin.js:3` | `pinAPI` | 1 / 13 | `main/domains/pin/index.js:268`（preload `:285`） | R4 |
| 9 | recognition | `recognition/recognition.html` | `preload-recognition.js:3` | `recognitionAPI` | 6 / 2 | `main/domains/recognition/index.js:132`（preload `:144`） | R2 + R4 + R6 |
| 10 | search | `search/search.html` | `preload-search.js:3` | `searchAPI` | 8 / 3 | `main/domains/search/index.js:198`（preload `:211`） | R2 |
| 11 | record | `record/record.html` | `preload-record.js:13` | `recordAPI` | 16 / 5 | `main/domains/record/index.js:1288`（preload `:1298`） | R0 验证，R5 |
| 12 | record-editor | `record/editor.html` | `preload-record-editor.js:16` | `recordEditorAPI` | 11 / 3 | `main/domains/record/index.js:1674`（preload `:1683`） | R5 |
| 13 | record-frame | `record/frame.html` | `preload-record-frame.js:3` | `recordFrameAPI` | 0 / 2 | `main/domains/record/index.js:1270`（preload `:1284`） | R0 验证，R5 |

核对结论：

1. **13 个 preload 与 13 个 IPC 角色一一对应，没有多余或缺失的 preload 文件**（根目录 `preload*.js` 共 13 个，`grep exposeInMainWorld` 命中 13 处；`IPC_SURFACES` 13 项）。计划 §4.1 的表格把 toolbar/action、long-capture/long-overlay、record/record-frame 各合并为一行，合计仍是 13 个角色，不矛盾。
2. **角色数 ≠ 窗口/页面数：存在第 14 个被加载的页面。** `capture/print.html` 是 PDF 导出的隐藏离屏打印窗口，由 `main/services/pdf-export.js:381` 加载，复用 `preload-capture.js`（`:382` 默认 `preloadPath`），但不在 `IPC_SURFACES`。本轮已核对：`buildIpcPolicies` 只为 `IPC_SURFACES` 生成页面策略（`main/services/ipc-security.js:294-315`），不在清单的页面任何 invoke/send 会被 `page-not-allowed` 拒绝（`:365`）。因此 R1 不应对打印窗口开放任何角色能力，但**必须在 capability/命令映射中显式处理这个非角色窗口**，不能按 13 个角色生成后把它误当漏项或误开放。该窗口已由并行的 R0-02 产物登记为 `host-contracts.json` 的 `knownGaps`（`docs/plans/rust-migration/host-contract-inventory.md` §3/§4：`kind: "auxiliary-window-not-in-ipc-surfaces"`）。
3. **没有发现这 14 个页面之外的其他窗口/页面类型。** 全仓 `BrowserWindow.loadFile` 调用点与 `IPC_SURFACES` 的页面集合核对后，多出的只有 `capture/print.html`（`grep -rn "loadFile(" main main.js`）。e2e 自动化窗口复用正常窗口，不新增页面。
4. 窗口安全策略统一走 `main/services/window-security.js`（`createSecureWindow` / `createLocalWindowFactory`，`contextIsolation`、`sandbox`、CSP 与导航限制见 `:19-:122`）；selection 的 toolbar/action 窗口由 `selection-window-manager.js` 自行创建（`:137`、`:241`），R1 迁移时需单独覆盖。

## 2. 功能矩阵（用户功能域）

风险分级沿用调研 §5：**高**=平台能力/数据正确性/媒体链路可能阻断；**中**=服务移植与兼容验证；**低**=主要适配。所有"基线缺陷"编号在 §3 给出证据。

| ID | 功能域 | 用户入口 | 源码（文件:行） | 现有测试（e2e/test） | 目标批次 | 迁移风险 | 基线缺陷/未验证（证据见 §3） |
|---|---|---|---|---|---|---|---|
| F-01 | 截图与浮层（框选/全屏/焦点窗口/延迟/复制/光标/首次绘制） | 托盘`截图`/`全屏截图`/`焦点窗口截图`（`tray-menu.js:94-96`）；默认快捷键 `F1`（`settings-defaults.js:186`）；主窗口首页卡片+托盘唤起；`captureAPI` | `main/domains/capture/index.js:30`（域装配）、`:431`（浮层窗口）；`main/services/capture-geometry.js:1`；`main/services/native-display-list.js:1`（原生抓屏 helper）；`capture/capture.js:1` | `test/capture-*.test.js`（34 个，含 `capture-domain`/`capture-interaction`/`capture-first-paint`/`capture-floating-placement`/`capture-init-handshake`/`capture-renderer-runtime`）；`scripts/probe-capture-width.js`、`scripts/probe-electron-runtime.js`；**e2e 无截图用例** | R0 验证（R0-03），R4 | **高**：screenshot-desktop 原生辅助 + `desktopCapturer` 双路径、DIP/源像素、透明浮层、首帧/焦点 | D-01、D-02、D-03、D-04 |
| F-02 | 标注与编辑（矩形/椭圆/箭头/直线/画笔/高亮/马赛克/文字/序号/水印/放大镜，撤销重做，样式记忆，成品外观几何） | 截图浮层工具栏（`capture/capture.html:101-115`）；截图完成后复制/保存/贴图/识别/历史 | `capture/capture.js:153-161`（标注与撤销状态）；`capture/annotation-geometry.js`；`capture/annotation-style.js:79`（9 个可持久化样式工具）；`capture/output-compositor.js`；`capture/output-style-panel.js`；`capture/magnifier-sampler.js`；`shared/capture-document.js:78`（文档 schema v3） | `test/capture-annotation-*.test.js`、`capture-brush-*.test.js`、`capture-tool-*.test.js`、`capture-output-style*.test.js`、`capture-magnifier-ui`/`magnifier-*.test.js`、`capture-toolbar-*.test.js` | R4 | **中～高**：Canvas 工具链可复用，但标注投影/样式持久化与 v3 文档绑定；像素级行为需夹具对照 | D-01、D-04 |
| F-03 | 长截图（纵向/横向滚动采集与拼接、条带预算） | 托盘菜单无独立项；主窗口首页/`截图Long` 功能入口（快捷键默认空，`settings-defaults.js:196` `screenshotLong:''`）；设置→截图与录制选择默认方向 | `main/domains/long-capture/index.js:131`/`:149`（浮层+控制器双窗）；`main/services/long-capture-session.js:5-6`（`MAX_LONG_EDGE=200000`、`MAX_PIXELS=200000000`）；`long-capture/long-capture.js:14-27`；`long-capture/matcher.js` + `matcher-worker.js` | `tests/long-capture.test.js`；`test/long-capture-domain.test.js`；`long-capture/matcher.js` 有独立 worker 测试覆盖（同测试） | R4（R4-05） | **高**：滚动控制/IPC 采集在渲染层，拼接与像素预算在 Node（`sharp`），需逐段验证与条带落盘 | D-05 |
| F-04 | 贴图/白板（置顶、穿透、多图显隐、再次编辑、白板绘制） | 托盘`贴图/白板`（`tray-menu.js:97`）；默认快捷键空（`screenshotFixed:''`）；主窗口首页；`pinAPI` | `main/domains/pin/index.js:23`（域）、`:243`（建窗）、`:369`（alwaysOnTop）；`main/domains/pin/geometry.js`；`pin/pin.js` | `test/pin-domain.test.js`（域用例）、`test/pin-geometry.test.js`；截图侧 `capture-ocr-pin-ui`/`capture-domain` 有接线断言 | R4（R4-06） | **高**：置顶/穿透/焦点/跨屏缩放是 Win32 行为，Rust 侧无等价 API 承诺 | D-06 |
| F-05 | 截图历史与再编辑（v3 文档/修订、提交回执、冲突/幂等/CAS、索引发布、版本保留、清理） | 主窗口路由 `history`（`config/config.html:20` → `config/config.js` `routes.history`）；托盘`截图历史`（`tray-menu.js:135`）；历史页支持搜索/筛选/批量导出/批量删除/继续编辑 | `main/services/history-service.js:1`；`main/services/capture-document-service.js:1087`；`shared/capture-document.js:78`；`main/ipc/history-ipc.js`；`config/routes/history.js` | `test/capture-document.test.js`、`capture-document-service.test.js`（2026-10-25 记录为 25 例，见 `docs/plans/2026-10-25-feature-r0-baseline.md:56-60`；当前数量以文件为准）、`capture-document-editor-runtime.test.js`（真实 Electron）、`capture-document-editor-ui.test.js`、`history-service`/`history-ipc`/`history-management-ui`/`history-reedit-ui`、`export-result-service.test.js` | R2（数据根/存储）+ R4（R4-03/R4-04） | **高**：v3 文档、内容指纹、提交状态机必须逐字节/逐语义对齐，否则"无修改也增版"或丢 revision | D-07 |
| F-06 | 导出（图片保存、单图/多图 PDF、表格 xlsx/TSV/CSV/Markdown、导出结果条） | 截图完成工具条（复制/保存）、历史页批量导出、PDF 导出（`capture/export-result-bar.js` 结果条）、识别页表格导出、托盘"最近导出"（`tray-menu.js:131`） | `main/services/pdf-export.js:5-14`（单图/多页，离屏 `capture/print.html` + `printToPDF`）、`:381-402`（打印窗口）；`main/services/table-workbook.js:1`（SpreadsheetML + adm-zip）；`main/services/image-buffer.js:1`；`main/services/export-result-service.js:1` | `test/pdf-export.test.js`、`pdf-export-multipage.test.js`、`table-workbook.test.js`、`image-file-save.test.js`、`export-result-service.test.js`、`capture-export-pdf-ui.test.js` | R4（R4-07） | **中～高**：`printToPDF` 是 Electron/Chromium 能力，单位/分页/字体无 Rust 等价；sharp 用于图像/表格/PDF 素材 | D-08 |
| F-07 | 多显示器与 DPI（100/125/150/200%、负坐标、副屏、显示器拔插、光标合成几何） | 全部可见窗口；设置→截图与录制；硬件验收矩阵 | `main/services/capture-geometry.js:1`；`main/services/native-display-list.js:1`；`shared/cursor-geometry.js:1`；`main/domains/selection/anchor.js:27`；`main/domains/pin/geometry.js`；`config/release-hardware-matrix.json`；`scripts/collect-hardware-evidence.ps1`；`scripts/verify-hardware-matrix.js` | `test/capture-geometry.test.js`、`capture-floating-placement.test.js`、`selection-anchor.test.js`、`cursor-geometry.test.js`、`magnifier-geometry.test.js`、`magnifier-sampler.test.js`、`region-presets.test.js`、`hardware-matrix.test.js`（验证矩阵 JSON 结构，不产生证据） | R0（R0-03）、R4、R8 | **高**：三种坐标（桌面 DIP/源像素/CSS 像素）与负坐标、混合 DPI 是 Tauri/Win32 必须逐项验证的链路 | D-09 |
| F-08 | 剪贴板窗口与回贴（文本/链接/图片/文件路径记录、置顶、搜索筛选、回贴、排除应用、容量与 GC、lease/epoch） | 托盘`剪贴板历史`（`tray-menu.js:107`）；默认快捷键空（`openClipboardHistory:''`）；主窗口路由 `clipboard-history`（`config/config.html:25`）；设置项 | `main/domains/clipboard/index.js:49`；`main/services/clipboard-service.js:1`（父进程协作、前台授权）；`main/services/clipboard-thumbnail-cache.js:1`（8 MiB/128 条）；`shared/clipboard-protocol.js:5-7`（1 MiB/512 KiB/256 KiB）；`native/clipboard/src/storage.rs:163`（`PRAGMA user_version=2`，schema v2 于 `:241` 应用） | `test/clipboard-*.test.js`（10 个：coordination/grid-layout/grid-runtime/layout-trim/paste-renderer/paste/preview-batch/protocol/resource-series/ui-contract）；`native/clipboard/tests/*.rs`（7 个文件）；`scripts/probe-clipboard-native.js`、`probe-clipboard-paste-runtime.js`；**e2e 不覆盖剪贴板面板**（`docs/plans/2026-10-23-clipboard-image-grid-handoff.md:123`） | R3 | **高**：Rust 服务可复用，但父进程授权、钩子协作、焦点/回贴原目标、私有 Window Station 依赖都是平台行为 | D-10 |
| F-09 | 划词工具栏/结果窗口/自定义动作/AI 动作（选中即显、复制/搜索/翻译/解释、多轮会话、拖拽/固定/恢复） | 系统级划词触发（`selection-hook`）；结果窗口走 `toolbarAPI`/`actionAPI`；设置→划词工具栏；主窗口路由 `selection-toolbar`（`config/config.html:23`） | `main/domains/selection/index.js:45`（`:428` 显示工具栏）；`main/services/selection-window-manager.js:137`/`:241`；`main/services/selection-hook-host.js:1`（utility process 隔离 COM/UIA）；`vendor/selection-hook/src/windows/selection_hook.cc:151`（`SelectionHook` N-API 包装）；`main/services/selection-hook-service.js`；`toolbar/toolbar.js`、`action/action.js` | `test/selection-*.test.js`（13 个，含 hook-host/service/native-build/anchor/window-manager/toolbar-*）；`test/action-*.test.js`（3 个，含安全与流式）；`test/clipboard-paste.test.js`（前台授权协作）；真机验证记录：`docs/plans/2026-09-26-selection-toolbar-conversation-verification.md`、`-v2/v3-design.md` | R3（R3-01/R3-04），AI 动作 R6 | **高**：C++ N-API addon 不能直接给 Rust 用；钩子卡死/回退复制/权限不足降级必须保持 | D-11 |
| F-10 | 智能选区（SmartSelect）/光标合成 | 截图框选前智能吸附（截图流程内）；设置项；`capture:smart-select` 通道（`main/ipc/capture-ipc.js:10`） | `main/domains/capture/smart-select.js`；`native/smart-select/Program.cs:1`（C# UIA EXE）；`main/services/cursor-provider.js:1`（`:13` 说明 helper 失败一律降级）；`shared/cursor-geometry.js:1` | `test/capture-domain.test.js`（`:9`/`:32-39` 对 `smart-select.js` 做源码契约断言）；`test/cursor-geometry.test.js`；**C# EXE 的 UIA 行为无自动化测试** | R3（R3-05） | **中**：第一阶段保留 C# EXE 即可；若要求纯 Rust 需重写 UIA/光标逻辑 | D-12 |
| F-11 | OCR/表格/二维码/识别遮挡与放大镜（本地 ONNX、表格恢复 TSV/CSV/Markdown、QR 链接打开、隐私遮罩） | `captureAPI` 的 OCR/表格/二维码入口；截图工具条与贴图菜单；主窗口路由 `settings-function` 的 OCR 项；`recognitionAPI` 窗口 | `main/domains/recognition/index.js:30`/`:127`；`main/services/ocr-service.js:102`/`:112`（空闲回收）；`native/ocr/src/main.rs` + `HighlighterOcrSidecar.exe` + `onnxruntime.dll`；`recognition/recognition.js:174-190`（jsQR）；`main/services/table-workbook.js:1` | `test/ocr-service.test.js`、`ocr-ipc.test.js`、`recognition-ui-contract.test.js`、`occlusion-recognition-runtime.test.js`、`occlusion-recognition-wiring.test.js`、`capture-ocr-pin-ui.test.js`；`native/ocr` 为独立 Cargo 工程（`cargo test --manifest-path native/ocr/Cargo.toml`） | R2（R2-04）、R4、R6（OCR 翻译） | **中**：sidecar 协议/进程管理可复用；真实模型端到端与 DPI 遮挡投影未验证 | D-13 |
| F-12 | 本地搜索（Everything） | 默认快捷键 `Alt+F`（`settings-defaults.js:205`）；托盘`本地搜索`（`tray-menu.js:106`）；主窗口路由 `local-search`（`config/config.html:24`）；`searchAPI` 独立窗口 | `main/domains/search/index.js:198`（窗口）；`main/services/everything-service.js:42`（服务）；`native/everything-search/src/main.rs`（v2 自研 WM_COPYDATA 协议，`HighlighterEverything.exe`）；`search/search.js` | `test/everything-service.test.js`、`search-domain.test.js`、`search-utils.test.js`、`e2e-fake-everything.test.js`、`e2e-bootstrap.test.js`；`e2e/local-search.spec.js`（1 例，CI 用假 sidecar）；`native/everything-search` 独立 Cargo 工程 | R2（R2-04） | **中**：Rust 桥接与子进程生命周期可复用；外部 Everything 实例/UIPI/索引波动是宿主环境依赖 | D-14 |
| F-13 | 录屏采集（区域/全屏/窗口、系统声音+麦克风、Canvas 合成、MediaRecorder、暂停/继续、分片写入） | 主窗口首页"录屏"卡片 → 工作台路由 `recording`（`config/config.html:21`）；托盘`录屏工作台`（`tray-menu.js:101`）；`recordAPI` 控制条；`recordFrameAPI` 帧窗；设置→快捷键 | `main/domains/record/index.js:1367`（`setDisplayMediaRequestHandler` 绑定目标+loopback）、`:1270`/`:1288`（帧窗+控制条）；`record/record.js:803`/`:820`（`getDisplayMedia`）；`record/audio-mixer.js:1`（Web Audio 混音）；`main/services/recording-service.js:1`（源会话 lease） | `test/record-domain.test.js`、`recording-service.test.js`、`recording-utils.test.js`、`record-control-bar.test.js`、`audio-mixer.test.js`、`region-recording-entry.test.js`、`recording-preview-runtime.test.js`；`e2e/recording-workbench.spec.js`（真实 Electron + 合成采集源） | R0 验证（R0-05/R0-04 相关），R5（R5-01/R5-02） | **最高**：`setDisplayMediaRequestHandler` 指定源+loopback 无 WebView2 等价承诺；Windows Graphics Capture/WASAPI 原生替代成本未评估 | D-15 |
| F-14 | 录屏项目/工作台/编辑器/时间线/事件轨（项目 v1、草稿 CAS、恢复、多段裁剪、撤销、鼠标事件轨） | 主窗口路由 `recording`；`recordEditorAPI`；托盘录制中状态（暂停/继续/完成）；`record:workbench-*` 通道 | `main/services/recording-project-service.js:1`；`shared/recording-project-schema.js:35`（`SCHEMA_VERSION=1`，`:27-28` keepRanges 半开区间）；`record/editor.js`、`record/editor-timeline.js`、`record/trim-controller.js`；`main/services/pointer-track-service.js:1`；`shared/recording-demo.js:60-61`（pointer 20,000/click 2,000 上限） | `test/recording-project-schema.test.js`、`recording-project-service.test.js`、`recording-project-integration.test.js`、`recording-editor-ui.test.js`、`recording-trim-ui.test.js`、`recording-workbench-ui.test.js`、`editor-layout.test.js`、`pointer-track-service.test.js`、`shared-recording-demo.test.js`、`e2e/recording-workbench.spec.js` | R5（R5-03/R5-04/R5-06） | **高**：项目/草稿/租约/恢复状态机与媒体时间基准必须一致；事件轨依赖原生鼠标 hook | D-15 |
| F-15 | 录屏导出（MP4/WebM/GIF、多段裁剪、分辨率/质量/帧率、演示增强、队列/取消/重试/校验后发布） | 编辑器唯一导出入口（`recordEditorAPI.exportProject`）；导出状态 `exportStatus`/`cancelExport`；结果条/最近导出 | `main/services/recording-export-service.js:111`（任务服务）；`shared/recording-export-options.js:1`（v2 请求/argv 白名单；队列 1+2、GIF 60s/1280/1200 帧、多段 20×100ms）；`main/ipc/recording-export-ipc.js`；`main/services/ffmpeg-path.js`；`main/services/recording-probe.js` | `test/recording-export.test.js`（真实 ffmpeg 的用例在 `ffmpeg-static` 可用时执行，见 `:158` 起 skip 条件）、`shared-recording-export-options.test.js`、`recording-project-integration.test.js`、`scripts/probe-cde-export-performance.js`、`e2e/recording-workbench.spec.js`（导出产物抽帧校验） | R5（R5-05/R5-07） | **高**：FFmpeg 可继续打包，但 argv 白名单/队列/取消/原片 lease/发布原子性必须逐项对齐；GIF 体积无上限 | D-15 |
| F-16 | AI 对话/翻译/本地翻译代理/划词动作/图像转换（多供应商、chat/responses 协议、SSE、代理端口、会话持久化） | 主窗口路由 `chat`/`translation`（`config/config.html:18-19`）；`settings-system`/`models` 配置供应商；划词动作；截图 OCR 翻译；tray 翻译代理开关（`tray-menu.js:62`） | `main/services/ai/client.js:1`；`main/services/ai-protocol-adapters.js`；`main/services/ai-providers.js`；`main/services/ai-feature-router.js`；`main/services/translation-proxy-service.js:357`（in-process relay）；`main/services/conversation-store.js:1`；`config/routes/models-*.js`、`translation.js`、`chat.js` | `test/ai-*.test.js`（6 个）、`translation-proxy-service.test.js`、`conversation-store.test.js`、`conversation-text.test.js`、`action-conversation*.test.js`（3 个）、`config-model-helpers`/`model-config-runtime`/`model-config-ui-contract`、`coding-plan-*.test.js`；**无在线供应商 e2e** | R6 | **中～高**：OpenAI JS SDK/Node HTTP 必须换成 Rust HTTP/SSE；协议差异、代理、取消、凭据不进 UI | D-16 |
| F-17 | AI 用量统计（TokenTracker，只读本地 CLI 日志、SQLite 只存计数、扫描游标/去重） | 主窗口路由 `usage`（`config/config.html:26`）；设置→通用用量开关；首次访问同意卡 | `main/services/usage-feature.js:41`（装配根）；`main/services/usage-store.js:19`（`SCHEMA_VERSION=1`，`:195-206` `PRAGMA user_version`）；`main/usage-scan-worker.js:1`（utilityProcess 纯解析）；`main/vendor/tokentracker/rollout.js:1`（vendored，可行性调研 §2.2 记录 25,039 行）；`config/routes/usage.js:1` | `test/usage-*.test.js`（14 个）；`scripts/usage-oracle-check.js`、`usage-p0-spike.js`、`usage-p0-worker.js`、`usage-scan-smoke.js`、`usage-vendor-smoke.js`、`usage-visual-preview.js`；`e2e/highlighter.spec.js:134`/`:169`（用量端到端，覆盖 fixture home） | R7 | **高**：解析闭包可搬（20 文件/29,690 行），但扫描编排/聚合/游标需重写；口径一致性需 oracle | D-17 |
| F-18 | 设置与凭据（settings 默认值/normalize/validate、原子写、API Key safeStorage、快捷键迁移、外观迁移、i18n） | 主窗口路由 `settings-general`/`settings-function`/`settings-system`/`about`/`models`（`config.html:28-32`）；托盘设置入口；`settings:get/update/reset` | `main/services/settings-defaults.js:1`；`settings-normalize.js`；`settings-validation.js`；`settings-service.js:1`（`:6` 禁止原型键）；`main/services/credential-store.js:4`（`isEncryptionAvailable`/DPAPI 密文 base64 存取 `:12-48`、provider 密文 `:50-85`）；`main/ipc/settings-ipc.js`；`config/routes/settings.js` | `test/settings-*.test.js`（6 个）、`credential-store.test.js`、`config-routes.test.js`、`config-model-helpers.test.js`、`model-config-*.test.js`、`shortcut-*.test.js`（5 个）、`appearance-migration.test.js`、`i18n*.test.js` | R2（R2-01），R6（供应商配置） | **中**：默认值/规范化/校验可移植；safeStorage 密文格式不能假定任何 Rust DPAPI 库可直接解密 | D-18 |
| F-19 | 数据根与迁移（locator、便携模式、marker v1/v2/v3、停写协调、迁移/回滚/清理） | 设置→系统与数据（打开/更改数据目录、诊断导出）；启动时数据根解析；托盘/主窗口无独立入口 | `main/services/data-root.js:5-6`（`Highlighter.location.json` / pending）；`main/services/data-root-migration.js:31-54`（`MANAGED_DIRECTORIES` 含 history；v3 追加 `recordings` 持久组，`:39-54` marker v3，兼容 v1/v2）；`main/services/data-root-bootstrap.js`；`main/domains/data-root/index.js`；`main/services/managed-writer-coordinator.js` | `test/data-root.test.js`、`data-root-migration.test.js`（含 junction/符号链接拒绝与 EPERM 跳过分支）、`data-root-ui-contract.test.js`、`usage-data-root-migration.test.js`、`managed-writer-coordinator.test.js` | R2（R2-02）、R8（R8-01） | **高**：所有写入者必须参与 quiesce；旧 Electron 不认识新根锁（计划 §5.3），双写风险不可由新 mutex 单独解决 | D-19 |
| F-20 | 托盘/快捷键/自启/单实例/更新/诊断/发布门禁 | 托盘全部菜单项（`tray-menu.js:7-:138`）；快捷键默认：`screenshot=F1`、`localSearch=Alt+F`、`explainClipboard=Ctrl+Alt+E`，其余空（`settings-defaults.js:185-232`）；设置→通用（自启/托盘/游戏模式/软件更新）；`about` 路由 | `main.js:875`（tray）、`:954`（快捷键注册）、`:1238`（`setLoginItemSettings` 自启）、`:1253`（`requestSingleInstanceLock`）；`main/services/tray-menu.js:7`；`shortcut-service.js`；`shortcut-migration.js`；`main/services/update-service.js:1`/`:329`（`updater.checkForUpdates`）；`main/ipc/update-ipc.js`；`electron-builder.release.cjs:12`（`forceCodeSigning: true`）；`scripts/verify-release.ps1`；`scripts/verify-hardware-matrix.js` | `test/tray-menu.test.js`、`tray-only-launch.test.js`、`shortcut-service.test.js`、`shortcut-ipc.test.js`、`shortcut-ui-contract.test.js`、`shortcut-keys.test.js`、`update-service.test.js`、`update-ipc.test.js`、`update-rehearsal.test.js`、`update-ui-contract.test.js`、`release-gates.test.js`、`version-consistency.test.js`、`hardware-matrix.test.js`、`dependency-security.test.js`；**安装包/升级/回退未在本轮验证** | R1（托盘/快捷键/单实例）、R8（更新/安装/发布） | **高**：electron-updater/fuses/ASAR/NSIS 全部是 Electron 专属；签名与 updater 签名是两套机制 | D-20 |

## 3. 基线缺陷与覆盖缺口明细（证据）

> 类型：**缺陷**=已记录的行为/测试问题；**限制**=产品明示取舍（不一定是 bug）；**未验证**=仓库文档或测试明确标注没验证；**环境跳过**=测试在特定环境自动跳过。所有条目可在当前 HEAD 的对应文件行核对。

| ID | 类型 | 内容 | 证据（文件:行） |
|---|---|---|---|
| D-01 | 缺陷（CI 覆盖） | 截图马赛克/画笔的 §6.3 网格相位用例 **自引入以来在 CI 从未通过**（6 次运行全红），本地通过只因硬件光栅差异；不能作为"渲染已回归验证"的依据 | `AGENTS.md:95-101`（"failed in every one of its six CI runs since … d9ad364"）；测试文件 `test/capture-brush-render.test.js` |
| D-02 | 未验证（e2e 覆盖） | Playwright E2E 只有 3 个 spec、12 条用例：主窗口启动/设置/用量、本地搜索、录屏工作台；**截图浮层、贴图、剪贴板面板、划词工具栏、OCR、AI 页面没有桌面 E2E** | `ls e2e/*.spec.js`（`highlighter.spec.js`/`local-search.spec.js`/`recording-workbench.spec.js`）；`CHANGELOG.md:58`（E2E 12/12）；`docs/plans/2026-10-23-clipboard-image-grid-handoff.md:123`（"test:e2e 未跑（且它本就不覆盖剪贴板面板）"） |
| D-03 | 未验证（截图运行时） | 真实抓屏断言默认不执行：只有 `HIGHLIGHTER_REQUIRE_CAPTURE_RUNTIME=1` 时才断言 `captureRuntime.nonBlank`/尺寸；默认 `npm test` 不断言真实屏幕采集。开发机无法初始化 DXGI 桌面复制 | `test/electron-runtime.test.js:58-63`；`CHANGELOG.md:67`（"开发机无法初始化 DXGI 桌面复制，E2E 使用主进程合成采集源覆盖其后的产品链路"） |
| D-04 | 未验证（视觉/性能） | 成品外观（阴影/圆角/半透明背景）的真实光栅观感、4K/极小图视觉一致性、DPI 切换表现未验证；4K 预览/导出无 p50/p95 样本；渲染探针未覆盖新面板 canvas 预览绘制；旧客户端打开 v3 文档的降级提示未用真实旧版本验证 | `docs/plans/2026-10-25-feature-C-handoff.md:203-217`；`docs/plans/2026-10-25-feature-D-handoff.md:195-203` |
| D-05 | 限制/未验证 | 长截图条带落盘与 2 亿像素预算有用例，但**滚动采集的像素/滚动行为没有真机记录**；本轮也未执行真机（见 §8）。渲染层采集 + Node 拼接的迁移风险需实际夹具 | `main/services/long-capture-session.js:5-6`（预算常量）；`tests/long-capture.test.js`、`test/long-capture-domain.test.js`（存在）；未在本仓库找到长截图真机验收记录（`docs/releases/` 无对应证据） |
| D-06 | 无已记录缺陷 | 贴图域有 `pin-domain`/`pin-geometry` 单测；未找到贴图真机（多屏/穿透/焦点）验收记录。按"没有记录不写成已通过"原则记为未验证 | `test/pin-domain.test.js`、`test/pin-geometry.test.js`；`main/domains/pin/index.js:369`（alwaysOnTop） |
| D-07 | 缺陷（UI 缺口）+ 限制 | ① `historyRevisionLimit` 已进入设置默认值/校验白名单并被服务读取，但设置页**没有对应输入控件**（只有 `historyLimit`）；② 窗格/条带视觉、跨 DPI/负坐标副屏打开同一文档、关闭编辑器焦点归还未真机验证；③ 故障注入只有索引写失败回滚一条；④ `electron-store` 在 EXDEV 会回退非原子写，断电持久性不保证 | `main/services/settings-defaults.js:50` vs `config/routes/settings.js:186-187`、`:349`（只有 historyLimit 控件）；`docs/plans/2026-10-25-history-reedit-batch0-contracts.md:360-364` |
| D-08 | 未验证（PDF 等价） | PDF 单图/多页走 Electron `printToPDF` + 隐藏 `capture/print.html`；纸张单位是英寸（文件头注释称实测），分页/字体/纸型由 Chromium 决定，Rust 侧没有等价承诺；xlsx 只验证过 Excel/openpyxl，WPS/LibreOffice 未验证 | `main/services/pdf-export.js:5-14`、`:23`、`:55`、`:381-402`；`docs/plans/2026-10-18-snow-apps-update-migration-analysis.md:1137` |
| D-09 | 未验证（真机矩阵）+ 证据缺失 | 混合 DPI、负坐标副屏、显示器拔插/重排在真实窗口上未验证；**硬件验收证据目录 `docs/releases/evidence/` 不存在**，即 Windows 10/11、DPI、RDP、休眠矩阵没有任何已提交证据 | `docs/plans/2026-10-25-feature-B-handoff.md:186-189`；`docs/releases/HARDWARE_ACCEPTANCE.md:7-17`、`:42`、`:52-55`；`ls docs/releases`（无 `evidence/`） |
| D-10 | 未验证（真实剪贴板/关注册）+ 缺陷（测试稳定性）+ 环境跳过 | ① 真实剪贴板端到端未验证：受限宿主无法创建私有 Window Station（`CreateWindowStationW` 返回 `E_ACCESSDENIED`），publication 用例 `ignored`；② 文件列表回贴需人工验收；③ `clipboard-coordination` 的 100 轮 lease 用例在高负载全量跑时偶发失败（单跑稳定），需先复跑；④ 原生 exe 未构建时部分测试显式 skip | `docs/performance/2026-10-27-clipboard-file-list.md:99-112`；`docs/performance/2026-10-17-clipboard-g0.md:69`；`AGENTS.md:70-87`；`test/clipboard-coordination.test.js:12`、`test/clipboard-protocol.test.js:49,61` |
| D-11 | 未验证/限制 | ① 划词 hook 心跳设计的核心前提（卡死同步调用会挡住 pong）**未用真实卡死场景做端到端复现**；② 划词结果窗口"点托盘恢复"这一步仍未验证；③ 依赖升级后 hook 是否仍能加载要求真机确认（历史计划要求）；④ 应用黑名单只有调研文档（`docs/plans/2026-10-08-selection-toolbar-app-blacklist-research.md`），代码中只有剪贴板 `excludedApps`，无划词黑名单实现 | `docs/plans/2026-09-17-selection-hook-heartbeat-design.md:240`；`docs/plans/2026-09-26-selection-toolbar-conversation-v3-design.md:403-405`；`docs/plans/2026-10-10-p0-gap-closure-plan.md:119`；`grep blacklist`（生产代码无命中） |
| D-12 | 限制 | SmartSelect 是 C# UIA 辅助 EXE，JS 测试只对 `main/domains/capture/smart-select.js` 做源码契约断言；真实 UIA 行为、取消、DPI 无自动化覆盖；光标 helper 失败时按设计降级为不画光标 | `test/capture-domain.test.js:9`、`:32-39`；`main/services/cursor-provider.js:13`（"helper 不存在/拉不起来/超时/退出，一律降级"）；`main/domains/capture/index.js:162`（光标失败降级为 null） |
| D-13 | 未验证/缺陷（既有 flake） | ① 真实 OCR/翻译/表格/QR 模型端到端未验证（只验证送给模型的像素）；② 混合 DPI 下的识别遮挡投影未验证；③ R1-R3 交付门禁记录过一次**既有** `test/ocr-service.test.js` 空闲定时器 flake（单跑 17/17 通过，非回归） | `docs/plans/2026-10-25-feature-D-handoff.md:197-198`；`docs/plans/2026-11-03-recording-r1-r3-delivery-notes.md:153` |
| D-14 | 未验证/限制 | ① Everything 多实例/UIPI/索引未就绪会导致"搜不到"，验收时需先排除；② 内置 Everything EXE 再分发条款需核对（打包发布前）；③ CI/受限 runner 无提权索引，E2E 默认用假 sidecar（`HIGHLIGHTER_E2E_FAKE_EVERYTHING=1` 时才走真实 sidecar） | `docs/local-search-integration-progress.md:105-107`；`main/services/e2e-bootstrap.js:15-19`；`e2e/local-search.spec.js` |
| D-15 | 未验证/限制（录屏，最高风险） | ① 开发机无法初始化 DXGI 桌面复制，E2E 使用**主进程合成采集源**，真实屏幕/窗口/麦克风/系统声音未验证；② 窗口录制不支持录中标注；窗口最小化/不可见依赖 Chromium 轨道 `mute` 尽力暂停；③ 导出分辨率/质量/帧率为会话内设置，不写草稿；④ 空选择（keepRanges 空）会回退整段；⑤ WebM 流复制路径无进度事件；⑥ 30/60FPS 双音源、5–30 分钟长录、音画漂移、暂停映射、异常退出恢复未验证；跨迁移排队任务的端到端行为未实测；⑦ 事件轨 20Hz、快速移动可能漏点，±1 帧对齐误差；GIF 只限时长/边/fps/帧数、不限体积 | `CHANGELOG.md:64-67`；`docs/plans/2026-11-03-recording-r1-r3-delivery-notes.md:158-172`、`:197-209`；`docs/plans/2026-11-03-recording-r4-contracts.md:243-250`；`docs/plans/2026-11-03-recording-r5-contracts.md:187-194`；`docs/plans/2026-10-25-feature-E-handoff.md:216-235`、`:239-249` |
| D-16 | 未验证/限制 | AI 协议/流式/代理有大量 Node 单测，但没有在线供应商或本地代理的端到端门禁；预设供应商拉取失败时写兜底模型清单并标"目录未验证"（行为已实现，不是缺陷）；真实模型验证仅见划词会话专项真机记录 | `test/ai-*.test.js`、`test/translation-proxy-service.test.js`（stub/fixture）；`docs/plans/2026-09-27-coding-plan-presets-design.md:50`、`:100`；真机记录 `docs/plans/2026-09-26-selection-toolbar-conversation-verification.md` |
| D-17 | 风险/缺陷（测试稳定性） | ① TokenTracker 解析闭包 20 文件/29,690 行可移植，但扫描编排+聚合（约 12k 行，闭包 88/79 文件）与云/账号强耦合，必须拆分重写（R7 的主要工作量与风险）；② `test/usage-query.test.js` 有 100ms p95 预算用例，机器负载高时假失败（记录在剪贴板性能文档中） | `docs/plans/usage-migration-analysis/05-parser-portability.md:295`；`docs/performance/2026-10-27-clipboard-file-list.md:95-97`；`main/services/usage-store.js:19`（schema v1 冻结） |
| D-18 | 限制/迁移风险 | API Key 以 `safeStorage` 密文 base64 存在 `credentials.apiKey`/`credentials.providerApiKeys`；加密不可用时**不写明文**（`setApiKey` 返回 false）、读取回退到 legacy 明文配置；不能假定任何第三方 Rust DPAPI 封装能直接解密 Electron 密文 | `main/services/credential-store.js:12-48`、`:50-85`；可行性调研 §5/§7 凭据行（`docs/research/2026-11-10-rust-migration-feasibility.md:240`、`:248`） |
| D-19 | 限制/环境跳过 | 数据根迁移按 marker 版本复制持久组（v3 含 `recordings`），拒绝 symlink/junction；junction/链接相关测试在无权限环境显式 skip；旧 Electron 不认新根锁，"双端同根写入"只能靠停写验证，不能靠新 mutex | `main/services/data-root-migration.js:31-54`；`test/data-root-migration.test.js:658,693,1247,1294`、`test/data-root.test.js:332,352,372`（`t.EPERM` 跳过）；计划 §5.3（`docs/plans/2026-11-10-rust-migration-development-plan.md:219`） |
| D-20 | 未验证/限制 | ① 本地构建无代码签名（`electron-builder.release.cjs:12` 要求签名，实际产物 `NotSigned`）；② `verify:package`（完整 electron-builder 产物 + 静默安装）依赖真实桌面，AGENTS.md 明确不得从受限宿主声称通过；③ 硬件矩阵证据目录缺失（见 D-09）；④ AGENTS.md:42-47 记录过 npmmirror registry 使 `npm audit` 静默返回空的陷阱；本机当前 `.npmrc` 为空、有效 registry 为官方（见 r0-baseline §1.4），该陷阱是否仍存在须在 R0-07/CI 复核，不得沿用旧结论 | `AGENTS.md:60-65`；`docs/plans/2026-09-26-release-packaging-verification.md:23-26`、`:43`、`:55-63`；`docs/releases/HARDWARE_ACCEPTANCE.md:7-17`；`AGENTS.md:42-47` |

补充登记（不属于功能缺陷，但影响 R0-02/R1 合同）：

- **`capture:record-history` 无渲染层调用方**：通道在 `IPC_SURFACES`（`ipc-security.js:108`）、capture IPC（`main/ipc/capture-ipc.js:16`）与 `preload-capture.js:41` 都存在，但 `capture/capture.js` 与其它页面均未调用（全仓 `grep recordHistory` 仅命中上述三处）。历史写入现由文档提交服务负责。R0-02 的 `host-contract-inventory.md` 尚未登记该通道为差异；R1 合同冻结时应决定保留/删除，不能默认继承一个死通道。
- **`history:` 通道与 `captureHistory` 索引双写**：历史检索仍读 settings 里的 `captureHistory` 路径索引（`data-root-migration.js:rewriteConfig` 重写 `filePath`/`thumbnailPath`），与 v3 文档索引并存；R2/R4 迁移时两条索引的来源和一致性需在合同里写清。

## 4. 现有测试资产盘点（文件级，不代表本轮运行结果）

| 类别 | 数量/清单 | 说明 |
|---|---|---|
| Node 单测 | `test/*.test.js` **205 个文件**，约 58,170 行（`wc -l`）；另有 `tests/long-capture.test.js`（不在 `npm test` 通配内，由 `npm run test:long-capture` 单独跑） | `npm test = node --test test/*.test.js`（`package.json:9`） |
| 真实 Electron 探针测试 | 13 个 `test/*-runtime.test.js`：`action-security`、`capture-document-editor`、`capture-renderer`、`clipboard-grid`、`diagnostics`、`electron`、`i18n-hot-switch`、`magnifier-reedit`、`magnifier`、`model-config`、`occlusion-recognition`、`recording-preview`、`window-security` | 直接 spawn `electron.exe` 跑 `scripts/probe-*.js`；受 AGENTS.md §1-3 的宿主陷阱影响（`ELECTRON_RUN_AS_NODE`、`--no-sandbox`、`TMP/TEMP`） |
| Playwright E2E | `e2e/highlighter.spec.js` 7 条、`local-search.spec.js` 1 条、`recording-workbench.spec.js` 4 条 = **12 条** | `playwright.config.js`：1 worker、串行；`CHANGELOG.md:58` 记录 12/12 |
| 原生 Cargo 测试 | `native/clipboard/tests/*.rs` 7 个文件（files_storage/isolated_capture/listener_lifecycle/paste_receipts/publication_repair/publication_sequence/schema_migration）；`native/clipboard/examples/seed_paste_probe.rs`；`native/ocr`、`native/everything-search` 为独立 Cargo 工程（单测在各自源码内） | `npm run test:clipboard:native` 串联；`verify:selection-source-build.js` 守护 selection addon 源码构建 |
| 条件跳过/环境依赖 | 记录类测试在 `ffmpeg-static` 不可用时 skip（`test/recording-export.test.js:158` 起多例）；剪贴板原生测试在 exe 未构建时 skip（`clipboard-coordination.test.js:12`、`clipboard-protocol.test.js:49,61`）；junction/符号链接权限不足 skip（`data-root.test.js:332` 等）；`captureRuntime` 仅 env 开启时断言（`electron-runtime.test.js:58`） | 这些是"在缺少环境时静默少测"，报告里必须按实际 skip 记账 |
| 性能/基准脚本 | `scripts/benchmark-performance.js`、`probe-cde-performance.js`、`probe-cde-export-performance.js`、`memory-snapshot.js`、`collect-process-inventory.ps1`、`scripts/usage-oracle-check.js` | **本轮均未执行**；历史性能样本见 `docs/performance/`（最新为 2026-10-27，不是 4.2.0 基线全量） |
| 安全/发布门禁 | `test/ipc-security.test.js`、`window-security*.test.js`、`test/window-security-runtime.test.js`、`test/release-gates.test.js`、`test/hardware-matrix.test.js`、`test/dependency-security.test.js`、`scripts/verify-electron-fuses.js`、`scripts/verify-release.ps1`、`.github` 发布工作流（证据要求见 `docs/releases/HARDWARE_ACCEPTANCE.md`） | Electron 专属门禁在 Rust 宿主下需要替换而不是删除（计划 §10） |

覆盖缺口（与 D-02/D-03 对应）：截图浮层、贴图、剪贴板、划词、OCR、AI 页面没有桌面 E2E；真实抓屏/真实剪贴板/真实录屏/真实 OCR 模型/真实供应商都需要真机或专用环境，自动化测试以 stub/fixture/合成源替代。

## 5. 入口清单（R0-01 要求：README、托盘、快捷键、页面全部入口）

### 5.1 页面/窗口入口

主窗口 `config/config.html` 的导航路由（`config/config.html:16-32`，分发见 `config/config.js` `routes`）：

| 路由 | 页面内容 | 关联功能 |
|---|---|---|
| `home` | 首页卡片（五项核心能力入口、功能开关、最近导出） | 全部功能的启动台 |
| `translation` / `chat` | 翻译页 / AI 对话页 | F-16 |
| `history` | 截图历史与再编辑 | F-05、F-06 |
| `recording` | 录屏工作台 + 录制记录 | F-13/F-14/F-15 |
| `selection-toolbar` | 划词工具栏配置与动作编辑 | F-09、F-16 |
| `local-search` | 本地搜索设置/状态 | F-12 |
| `clipboard-history` | 剪贴板设置 | F-08 |
| `usage` | AI 用量统计面板 | F-17 |
| `settings-general` / `settings-function` / `settings-system` / `models` / `about` | 通用/功能/系统与数据/供应商与模型/关于与更新 | F-18、F-19、F-20 |

独立窗口（`IPC_SURFACES` 13 角色）见 §1；另加隐藏打印窗口 `capture/print.html`（F-06）。

### 5.2 托盘菜单入口（`main/services/tray-menu.js:7-:138`）

录屏工作台/录制中暂停·继续·完成（`:81-:104`）、截图/全屏截图/焦点窗口截图（`:94-96`）、贴图/白板（`:97`）、本地搜索（`:106`）、剪贴板历史（`:107`）、游戏模式（`:111`）、退出全部穿透（`:119`）、显示划词对话（`:123`）、最近导出（`:131`）、截图历史（`:135`）、显示主窗口（`:136`）、退出（`:138`）、翻译代理开关（`:62`）。

### 5.3 默认全局快捷键（`main/services/settings-defaults.js:185-232`）

`F1`=截图；`Alt+F`=本地搜索；`Ctrl+Alt+E`=解释剪贴板；其余（延迟截图、全屏/焦点窗口、长截图、划词翻译/对话、录屏相关、历史、贴图可见性、主窗口显隐等）默认**空**，由用户在设置里绑定。设置页对冲突有提示（README:129）。

### 5.4 启动/常驻入口

托盘常驻 + 开机自启直接进托盘（`main.js:1238` `setLoginItemSettings`，README:133）；单实例锁（`main.js:1253`）；主窗口按需创建/隐藏后回收（`main/services/main-window-reclaimer.js`、`window-leases.js`）；功能模块开关 `plugins.{ocr,translation,ai,video}`（`settings-defaults.js`）、用量默认关闭（`usage.enabled:false`）、剪贴板默认关闭（`clipboard-settings.js:2` `enabled:false`）。

## 6. 目标批次映射（与计划 §6/§7 对照）

| 批次 | 本矩阵涉及的功能域 | 说明 |
|---|---|---|
| R0 | F-01、F-13、F-07、F-05（风险原型/基线） | R0-03 浮层+截图、R0-05 媒体、R0-06 文档/凭据/PDF/资源通道小样 |
| R1 | F-20、全部宿主桥接/权限 | 13 个角色的 capability + 非角色打印窗口的显式处理（不开放角色能力）、窗口实例 generation、ready/init |
| R2 | F-05/F-06（存储侧）、F-11（OCR）、F-12（搜索）、F-18、F-19 | 数据根、设置、sidecar 接入 |
| R3 | F-08、F-09、F-10 | 划词/剪贴板/智能选区/光标 |
| R4 | F-01/F-02/F-03/F-04/F-05/F-06/F-07 | 截图、标注、历史、长截图、贴图、导出 |
| R5 | F-13/F-14/F-15 | 录屏采集/项目/编辑器/导出 |
| R6 | F-16、F-09 的 AI 动作、F-11 的 OCR 翻译 | AI/翻译/代理/会话 |
| R7 | F-17 | 用量统计与去 Node 收口 |
| R8 | F-18/F-19（升级/迁移）、F-20（安装/更新/发布） | 全量兼容、安装升级、回退、性能与发布 |

## 7. 汇总：G0 前必须补证的高风险项

按计划 §8 的 G0 必备证据，本矩阵显示以下缺口**最影响 G0 判断**（未验证，不是"已失败"）：

1. **媒体后端（F-13/F-15）**：真实屏幕/窗口采集、系统声音 loopback、暂停/时钟、30 分钟样例全部未执行；开发机无 DXGI。若 WebView 路径不达标，R5 成本与排期需重估（计划 D05/风险台账第一行）。
2. **多显示器/DPI（F-07）**：混合 DPI、负坐标副屏、显示器拔插在真实窗口上未验证；硬件证据目录为空。
3. **钩子/剪贴板（F-08/F-09）**：真实剪贴板端到端（私有 Window Station 被拒）与真实划词/回贴矩阵未验证；C++ addon → 独立 helper 的提取边界仍是选型项（D04）。
4. **数据正确性（F-05/F-06/F-19）**：v3 文档/录屏项目/剪贴板 v2/用量 v1/marker v3 的 Rust 对齐仍停留在规格层；R0-02 的合成夹具已落地（`test/fixtures/host-parity/`），但本轮未运行 `--check`/对照测试，Rust 侧逐字段双端对照测试仍在并行任务中。
5. **发布链（F-20）**：安装包、签名、WebView2 有/无、升级/回退均未验证；`docs/releases/evidence/` 不存在。

## 8. 本轮未执行 / 未验证项（不得当作已通过）

- **未执行**：`npm test`、`npm run test:e2e`、`npm run test:coverage`、`npm run test:long-capture`、`npm run check`、`npm run verify:fuses`、`npm run verify:package`、`npm run verify:hardware`、任何性能/内存对照、任何安装包构建与安装。
- **未执行**：任何真机可见窗口验收（副屏/多 DPI/负坐标/RDP/休眠/真实音频设备）。
- **未执行**：Rust/Tauri 原型（R0-03～R0-07 未开始；本分支只有 R0-01 文档与 R0-02 合同/workspace 的并行产物）。
- **未验证**：§3 中类型为"未验证"的全部条目；§7 的五类 G0 证据。
- 本文件是**范围基线**，不是功能验收记录；后续批次完成一项功能时，应更新本表对应行并补充证据路径与差异记录（计划 §11 要求重新拉取上游后增量核对）。

## 9. 后续维护约定

1. 每个功能迁移完成的定义 = 代码 + 对应测试 + 证据 + 已知差异（计划 §6），不能只以界面能打开为准。
2. 修改/新增 IPC 通道、preload 暴露对象、错误码或资源上限时，同步更新 `contracts/host/host-contracts.json`（R0-02 产物）与本文件的"源码"列。
3. 发现实现与计划不一致时，先登记在 `host-contract-inventory.md`（R0-02）与本文件 §3，不直接修改旧实现。
