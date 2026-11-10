# R0 基线记录（r0-baseline）

日期：2026-11-10（Asia/Hong_Kong）。状态：**R0 证据文档（草案）**。
上位文档：[Rust 改造方案与开发计划](../2026-11-10-rust-migration-development-plan.md)（下称"计划"）§1/§4.1/§5/§6/§7/§9.1/§11/§12、[可行性调研](../../research/2026-11-10-rust-migration-feasibility.md)、[R0 合同格式](contract-format.md)。配套功能矩阵：[feature-parity.md](feature-parity.md)。

**门禁声明：本文件不构成任何 gate 已通过的证据。G0～G4 全部未通过。R0 只登记本分支实际完成的部分（截至本文件写作时：R0-01 文档、R0-02 合同/夹具的并行产物在途），真机/性能/安装包验证一律"未执行"。**

## 1. 基线版本与环境（本轮实测）

### 1.1 源码与版本

| 项 | 实测值 | 获取方式 |
|---|---|---|
| 产品源码基线 | `3df712976fdeeef1f1dce47a81995cfabdee8ee9`（存在且为 commit；与计划声明一致，是 4.2.0 之后最后一个产品提交） | `git rev-parse 3df7129` / `git cat-file -t` / `git log --oneline` |
| 本分支 HEAD | `82c0b414b8ad310467335fa0a768efd33891d9fd`，分支 `codex/rust-r0-baseline-contracts` | `git rev-parse HEAD`、`git branch --show-current` |
| HEAD 相对产品源码 | 4 files changed, 1185 insertions(+), 30 deletions(-)，仅 3 份文档 + `.gitignore` 行尾变化 | `git diff --stat 3df7129..HEAD` |
| 应用版本 | `highlighter-snowshot` `4.2.0` | `package.json:3`、`node -p "require('./package.json').version"` |
| Electron | `43.8.3`（devDependency 与 `node_modules/electron/package.json` 一致） | `node -p "require('./node_modules/electron/package.json').version"`、`package.json:183` |
| Node / npm | `v24.22.1` / `12.1.0` | `node --version`、`npm --version` |
| git | `2.56.0.windows.4.niugit` | `git --version` |
| rustc | `1.97.1 (8bab26f4f 2026-07-14)` | `rustc --version` |
| cargo | `1.97.1 (c980f4866 2026-06-30)` | `cargo --version` |
| WebView2 Runtime | `157.0.4341.42`（名称 `Microsoft Edge WebView2 Runtime`） | `HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv`/`name` |
| 实测时间 | 2026-11-10 约 22:00–22:20（Asia/Hong_Kong） | 本节各命令执行时间 |

### 1.2 操作系统与硬件

| 项 | 实测值 | 获取方式 |
|---|---|---|
| OS 标识 | `Microsoft Windows 11 专业版`，Version `10.0.26300`，Build `26300`，`64-bit` | `Get-CimInstance Win32_OperatingSystem` |
| OS build（含 UBR） | `26300.9711`；注册表 `DisplayVersion=26H2`、`ProductName=Windows 10 Pro`（Windows 11 上保留的兼容字符串，不能据此判为 Win10） | `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion` 的 `CurrentBuild.UBR`/`DisplayVersion`/`ProductName` |
| CPU | `AMD Ryzen 7 9850X3D 8-Core Processor`，8 核 / 16 逻辑核，MaxClockSpeed 4700 MHz | `Get-CimInstance Win32_Processor` |
| 内存 | `50,627,760,128` B（约 47.2 GiB）；采样时可用 `32,184,373,248` B（约 30.0 GiB） | `Win32_OperatingSystem.TotalVisibleMemorySize/FreePhysicalMemory × 1024` |
| GPU | ① `NVIDIA GeForce RTX 5070 Ti`，驱动 `32.0.16.1742`，模式 `3840 x 2160 @ 160 Hz`；② `AMD Radeon(TM) Graphics`（核显），驱动 `32.0.21042.62`，模式 `2560 x 1440 @ 144 Hz`；③ `GameViewer Virtual Display Adapter`，驱动 `15.6.5.199`，无当前模式 | `Get-CimInstance Win32_VideoController` |
| 电源方案 | `平衡`（`381b4222-f694-41f0-9685-ff5bb260df2e`）——**未固定**，R0-07 性能对照前必须冻结 | `powercfg /getactivescheme` |
| 磁盘 | C: 已用 166.8 / 剩余 32.2 GB；D: 345 / 407.5 GB；E: 590.9 / 3135.1 GB；**F:（仓库所在）40.9 / 913 GB** | `Get-PSDrive -PSProvider FileSystem` |

### 1.3 显示器与 DPI（本轮实测，含方法说明）

方法：PowerShell 先 `SetProcessDPIAware()`，再用 `EnumDisplayMonitors` + `GetMonitorInfoW` + `GetDpiForMonitor`（user32/shcore）读取物理像素与 DPI；另用 `[System.Windows.Forms.Screen]`（非 DPI-aware，读逻辑像素）交叉核对。

| 显示器 | 主屏 | 物理桌面坐标/尺寸 | 工作区 | DPI |
|---|---|---|---|---|
| `\\.\DISPLAY1` | 是 | `(0,0)-(3840,2160)`，3840×2160 | 3840×2112 | 144 dpi（150%） |
| `\\.\DISPLAY2` | 否 | `(4608,-204)-(6336,2868)`，1728×3072（竖屏） | 1728×3024 | 144 dpi（150%） |

交叉核对与结论：

1. 非 DPI-aware 进程读到的逻辑值：主屏 2560×1440、副屏 1152×2048 @ 坐标 `(3072,-136)`，正好是物理值 ÷1.5，说明该进程被 DPI 虚拟化。**记录基线时必须同时写清取数方式，否则会把 150% 缩放误读成 100%。**
2. 本机有 **2 块活动显示器**，均为 150% 缩放；副屏为竖屏且 **Y 坐标为负（-204）**。**本机不构成"混合 DPI"矩阵**（没有两块不同缩放比例的屏），R0-03/R4 的混合 DPI 结论不能只用本机证明。
3. `Win32_DesktopMonitor` 列出 3 个监视器条目（其中 2 个 `Default Monitor`，与物理屏不一一对应），不能作为显示器数量依据；以 `EnumDisplayMonitors` 为准。
4. 按仓库 `AGENTS.md:3-4`，所有可见测试窗口默认放副屏（`\\.\DISPLAY2`，竖屏 1728×3072）；本文件涉及的真机验证本轮均未执行。

### 1.4 会话/构建/依赖状态（影响测试与 R0 复现）

| 项 | 实测值 | 说明 |
|---|---|---|
| `ELECTRON_RUN_AS_NODE` | **`1`（已设置）** | AGENTS.md 陷阱 1：必须 `env -u ELECTRON_RUN_AS_NODE` 才能启动 Electron 探针 |
| `NODE_OPTIONS` | 未设置 | 直接跑 `test/*-runtime.test.js` 时需要自备 `--require` spawn hook（AGENTS.md 陷阱 2） |
| `TMP` / `TEMP` | `C:\Users\MSN\AppData\Local\Temp`（仓库外） | AGENTS.md 陷阱 3：spawned Electron 子进程写该目录会 EPERM，需改到 `.tmp*/` |
| npm registry | `https://registry.npmjs.org`；`.npmrc` 为 0 字节 | **与 AGENTS.md:42-47 记录的 npmmirror 不一致**（该记录已过时/环境已改）。本机 `npm audit` 是否仍复现空结果需在 R0-07/CI 验证，不得沿用旧结论 |
| Electron 安装 | `node_modules/electron` 43.8.3 已安装 | `npm test` 前置 |
| 原生组件 | `vendor/selection-hook/build/Release/selection-hook.node` 316,416 B；`native/clipboard/bin/HighlighterClipboard.exe` 2,868,736 B；`native/ocr/HighlighterOcrSidecar.exe` 2,673,152 B + `onnxruntime.dll`；`native/everything-search/bin/HighlighterEverything.exe` 343,552 B；`native/smart-select/SmartSelect.exe` 13,312 B | `ls -la`。SmartSelect 由系统 .NET Framework 4.0 `csc.exe` 编译（`native/smart-select/build.ps1:3-19`），依赖 Windows 自带 .NET Framework，无需 .NET 自包含运行时 |
| OCR 模型 | `ocr/models/ppocr-v4-ch/`：`ch_PP-OCRv4_det_mobile.onnx`、`ch_PP-OCRv4_rec_mobile.onnx`、`ch_ppocr_mobile_v2.0_cls_mobile.onnx` + `model.json` | `find . -name "*.onnx"`；与 `native/ocr` 的 sidecar 配合 |
| ffmpeg | `node_modules/ffmpeg-static/ffmpeg.exe` 82,797,568 B 已安装 | 录屏导出测试中"真实 ffmpeg"用例的前提（否则 skip） |
| 打包产物 | `dist/` 下有历史打包目录（含 `win-unpacked`） | **本轮未重新构建**；不得作为本次基线或发布证据 |
| 工作区状态 | 有未跟踪的并行 R0 产出：`contracts/`、`rust-app/`、`scripts/rust/extract-host-contracts.js`、`scripts/rust/generate-host-fixtures.js`、`scripts/rust/check-rust-app.ps1`、`test/fixtures/host-parity/`、`test/host-contracts.test.js`、`docs/plans/rust-migration/host-contract-inventory.md`、本文件与 `feature-parity.md` | `git status --porcelain`。Lead 统一提交；本文件不执行 git 写操作 |

### 1.5 功能开关默认值（R0-01 "功能开关"证据）

| 开关 | 默认 | 证据 |
|---|---|---|
| OCR / 翻译 / AI / 录制模块 | 全部 `true` | `main/services/settings-defaults.js:38` `plugins:{ocr:true,translation:true,ai:true,video:true}` |
| 用量统计 | `false`（首次访问需显式同意） | `main/services/settings-defaults.js:22` |
| 剪贴板历史 | `false`（默认关闭） | `main/services/clipboard-settings.js:2` |
| 开机自启 | `true`（直接进托盘，README:133） | `settings-defaults.js:163` |
| 游戏模式 | `false` | `settings-defaults.js:166` |
| 翻译代理（本地 relay） | `autoStart:false`（不自动开端口） | `settings-defaults.js:175-176` |
| 划词工具栏 | `enabled:true` | `toolbar/toolbar-utils.js:46` |
| 划词会话持久化 | `enabled:true, persist:false`（不默认写盘） | `toolbar/toolbar-utils.js:30` |
| 全局快捷键默认值 | `F1`=截图、`Alt+F`=本地搜索、`Ctrl+Alt+E`=解释剪贴板；其余为空 | `settings-defaults.js:185-232` |

### 1.6 候选数据集/夹具（R0-01 "数据集"）

| 数据集 | 内容 | 状态 |
|---|---|---|
| `test/fixtures/host-parity/` | R0-02 合成跨语言夹具：`manifest.json` + 分组 `capture-document`、`clipboard-protocol`、`recording-export-options`、`recording-project`、`settings`（本轮实测 29 个文件；具体 case 数以最终 manifest 为准） | 写作时已出现（并行产出），生成/校验命令尚未在本会话运行 |
| `test/fixtures/usage/` | 用量扫描 golden/home/ipc 夹具（20 个文件） | 已有 |
| `ocr/models/ppocr-v4-ch/` | 3 个 ONNX 模型 + `model.json` | 已有 |
| `docs/performance/2026-09-09-long-capture-corpus.md` | 长截图语料/匹配样本记录 | 已有（历史） |
| 录屏 | E2E 使用主进程合成采集源（`CHANGELOG.md:67`），无固定真实媒体语料 | 仅供功能链路，不是真机媒体数据集 |
| 真实用户数据 | **禁止**作为夹具/迁移测试输入（可行性调研 §7） | — |

## 2. 本轮实测命令与输出（可复核）

| # | 命令（摘要） | 输出/结论 |
|---:|---|---|
| 1 | `git rev-parse HEAD` | `82c0b414b8ad310467335fa0a768efd33891d9fd` |
| 2 | `git cat-file -t 3df712976fdeeef1f1dce47a81995cfabdee8ee9` | `commit`；`git diff --stat 3df7129..HEAD` = 4 files, +1185/−30 |
| 3 | `node -p require('./package.json').version` | `4.2.0` |
| 4 | `node -p require('./node_modules/electron/package.json').version` | `43.8.3` |
| 5 | `node --version` / `npm --version` | `v24.22.1` / `12.1.0` |
| 6 | `rustc --version` / `cargo --version` | `1.97.1 (8bab26f4f 2026-07-14)` / `1.97.1 (c980f4866 2026-06-30)` |
| 7 | 读 WebView2 注册表 `pv` | `157.0.4341.42` |
| 8 | `Get-CimInstance Win32_OperatingSystem` | Win11 专业版 / 10.0.26300 / build 26300 / 64-bit |
| 9 | 读 `CurrentVersion` 注册表 | `DisplayVersion=26H2`、`CurrentBuild+UBR=26300.9711`、`ProductName=Windows 10 Pro` |
| 10 | `Get-CimInstance Win32_Processor` | AMD Ryzen 7 9850X3D，8C/16T，4700 MHz |
| 11 | `Win32_OperatingSystem` 内存字段 ×1024 | 50,627,760,128 B（可用 32,184,373,248 B） |
| 12 | `Get-CimInstance Win32_VideoController` | 3 个适配器（RTX 5070 Ti / AMD 核显 / GameViewer 虚拟显示），见 §1.2 |
| 13 | DPI-aware `EnumDisplayMonitors`+`GetDpiForMonitor` | 2 块屏，均 150%，副屏负 Y 坐标，见 §1.3 |
| 14 | `powercfg /getactivescheme` | 平衡（未冻结） |
| 15 | `Get-PSDrive` | F: 剩余 913 GB，见 §1.2 |
| 16 | `npm config get registry` | `https://registry.npmjs.org`（`.npmrc` 0 字节） |
| 17 | `git status --porcelain` | 并行 R0-02/R0-03 产出未跟踪，见 §1.4 |
| 18 | `node -e "require('./main/services/ipc-security').IPC_SURFACES"` | 13 个角色，role/page/handles/listeners 见 `feature-parity.md` §1 |
| 19 | `ls -la` 原生组件；`find . -name "*.onnx"`；`ls test/fixtures/host-parity` | 见 §1.4/§1.6 |

**未运行的基线命令**（不得写成通过）：`npm test`、`npm run test:e2e`、`npm run test:coverage`、`npm run test:long-capture`、`npm run check`、`npm run check:version`、`npm run verify:fuses`、`npm run verify:package`、`npm run verify:hardware`、`npm run audit:dependencies`、`bench:performance`、`memory-snapshot.js`、任何 Rust/Tauri 构建或探针。

## 3. R0-01～R0-07 任务状态（截至本文件写作时）

| 任务 | 状态 | 证据路径（实际存在性已核对） | 缺口 |
|---|---|---|---|
| R0-01 基线、功能开关/数据集/硬件、入口盘点 | **部分完成**（本文件 + 功能矩阵为唯一交付） | `docs/plans/rust-migration/feature-parity.md`、`docs/plans/rust-migration/r0-baseline.md` | 本轮未跑全量测试/性能；§9.2 的性能目标阈值未冻结（计划要求第一次对照运行前冻结）；真机矩阵未执行 |
| R0-02 13 preload/API、IPC 角色、schema、服务协议、资源限制提取 | **部分完成（并行产出，写作时基本在途）** | 规格：`docs/plans/rust-migration/contract-format.md`；已落地（写作时逐项 `ls` 核对）：`contracts/host/host-contracts.json`（110,493 B）、`test/fixtures/host-parity/`（`manifest.json` + 5 组，29 个文件）、`scripts/rust/extract-host-contracts.js`、`scripts/rust/generate-host-fixtures.js`、`test/host-contracts.test.js`、`docs/plans/rust-migration/host-contract-inventory.md`（201 行） | 差异清单已登记 `capture/print.html` 离屏打印窗口（`knownGaps: auxiliary-window-not-in-ipc-surfaces`）与 `toolbar.onSelection` 聚合通道；**未登记** `capture:record-history` 死通道（见 `feature-parity.md` §3 补充）；`node scripts/rust/*.js --check`、`node --test test/host-contracts.test.js`、`cargo test --manifest-path rust-app/Cargo.toml --locked`、`npm run check` 均未在本会话运行；**以最终提交与验收命令结果核对，不得以"文件存在"代替通过** |
| R0-03 Tauri 托盘/无窗口启动、副屏截图浮层、Canvas 最小编辑保存 | **未开始**（仅有 `rust-app/` workspace 骨架与 `scripts/rust/check-rust-app.ps1` 作为前置，**无 `src-tauri` 原型**） | `rust-app/Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`、`rust-app/README.md`、`scripts/rust/check-rust-app.ps1`（均为并行产出）；无原型文档 | 100/150/200% DPI、负坐标、首帧/焦点/退出、整个 WebView2 进程组均未验证；未启动过任何 Tauri 窗口 |
| R0-04 去 N-API 钩子小样 + 既有 Rust 剪贴板联调 | **未开始** | 现有源码：`vendor/selection-hook/src/windows/selection_hook.cc`、`main/services/selection-hook-host.js:1`、`native/clipboard/` | 选词/回退复制/lease/前台授权/错误目标拒绝/崩溃恢复均未演示 |
| R0-05 WebView 媒体路径验证（失败则原生采集最小闭环） | **未开始** | 现有链路源码：`main/domains/record/index.js:1367`、`record/record.js:803`、`record/audio-mixer.js` | 全屏/区域/窗口、双音源、暂停/继续、可播放原片、源目标变化、30 分钟时钟样例均未验证 |
| R0-06 v3 文档/v1 项目/合成凭据导入、图片/视频资源桥、PDF 样例 | **未开始**（只有合同格式与部分夹具） | 规格：`contract-format.md`；夹具雏形：`test/fixtures/host-parity/` | 每项"成功/失败/恢复"用例、输出安全边界、后端选型 ADR 均未产出 |
| R0-07 NSIS 测试包、WebView2 有/无/离线、首轮性能对照 | **未开始** | 仅现有脚本：`scripts/verify-release.ps1`、`scripts/collect-hardware-evidence.ps1`、`scripts/verify-hardware-matrix.js`；`docs/releases/evidence/` **不存在** | 未构建测试包；未做 WebView2 环境矩阵；未做性能对照；工具链/Runtime/驱动未固定；不能以 Debug 数据下性能结论 |
| **G0 架构可行** | **未通过（未提交 G0 报告）** | 见 §4 决策登记（全部"待验证"） | 三条高风险链路（窗口/钩子/媒体）+ 数据/凭据/PDF/资源通道小样 + 版本矩阵 + 修正估算均缺 |

## 4. G0 决策登记（七项）

> 规则（计划 §2/§7）：每项记录备选、当前证据、失败分支、建议、未解决限制；**没有实测的标"待验证"，本文件不代结论**。七项当前状态全部为 **待验证**。

### 4.1 媒体后端（决定 R5 采集与导出）

- **备选**：A. 保留 WebView（WebView2 + 现有 Canvas/MediaRecorder，宿主提供等价"指定源 + loopback"绑定）；B. Rust 原生媒体后端（WGC/DXGI 视频 + WASAPI 系统回环/麦克风 + 混音/时钟/编码，Media Foundation 或 FFmpeg）；C. 混合（WebView 采集 + 原生音频）。
- **当前证据**：现有链路 `main/domains/record/index.js:1367` 用 `session.setDisplayMediaRequestHandler` 绑定指定源与 `loopback`；`record/record.js:803`/`:820` 调 `getDisplayMedia`；`record/audio-mixer.js:1` 用 Web Audio 混音 `canvas.captureStream()` 与麦克风。可行性调研 §6.2 明确：WebView2 的 `ScreenCaptureStarting` 只描述权限/取消，**不能证明**指定源、无二次选择框、系统声音 loopback 等价。计划 D05 要求 R0 决定，R0-05 未执行。
- **失败分支**：WebView 分支出现二次选源/目标漂移、无 loopback、时间漂移、编码或分辨率不兼容 → 转原生采集并重估 R5（计划风险台账首行；媒体后端若必须重写，工时可超出 38～63 人周区间）。
- **建议**：**待验证**。R0-05 先做 A 的最小闭环（全屏/区域/窗口、系统声+麦克风、暂停/继续、可播放原片、源目标变化、30 分钟时钟样例）与 B 的可行性 spike；在此之前不冻结后端、不承诺 Tauri/WebView2 录屏能力。
- **未解决限制**：目标设备音频设备/驱动矩阵；WebView2 Runtime 版本差异；同一媒体时钟与暂停语义；真实长录写入背压；E2E 合成采集源不能替代。

### 4.2 钩子提取边界（划词/回贴，决定 R3）

- **备选**：① 从现有 C++ 核心提取独立 EXE 或稳定 C ABI（保留 COM/UIA 进程隔离）；② 以行为夹具为依据改写为 Rust Windows 服务；③ Node sidecar 短期兼容（不满足"运行环境去 Node"终态，需独立退出计划）。
- **当前证据**：`vendor/selection-hook/src/windows/selection_hook.cc:151`（`SelectionHook` N-API 包装；UIA/钩子核心在 `core/`）；`main/services/selection-hook-host.js:1`（utility process 承载，卡死可回收）；`main/services/pointer-hook-host.js:1`（鼠标事件轨独立 host，不订阅文本/剪贴板/键盘）；`test/selection-hook-host.test.js`、`test/selection-hook-service.test.js`、`test/selection-native-build.test.js`、`scripts/verify-selection-source-build.js`；调研 §6.3 明确 Rust 不能把现有 `.node` 当普通 DLL 直接调用；计划 D04 要求 R0-04 小样。
- **失败分支**：提取成本高于重写且跨应用行为夹具不完备 → 选 ②；若改写后出现 COM 卡死/焦点回归/错误目标注入 → 保留隔离 helper 且不牺牲正确性（计划 §12 风险台账）。
- **建议**：**待验证**。先做 ① 的提取边界小样（选词、回退复制、lease、前台授权、错误目标拒绝、崩溃恢复），同时用现有单测和真机记录量化行为面；未实测前不选"提取"或"重写"。
- **未解决限制**：没有登记浏览器/编辑器/Office/资源管理器具体版本的行为夹具库；UIAutomation 的 COM 线程模型与 Tauri 事件循环/窗口线程交互未验证；回贴的"结果未知"边界仍存在（`docs/performance/2026-10-17-clipboard-active-paste.md:37`：SendInput 与前台切换之间存在极短竞态，不能声称彻底消除）。

### 4.3 最低系统 / WebView2 Runtime 下限（决定安装与发布，R1/R8）

- **备选**：Windows 10 1809/1903/20H2/22H2 与 Windows 11 的取舍；WebView2 Evergreen Runtime / Fixed Version / 离线安装包；对旧系统保留替代后端。
- **当前证据**：README 只声明"Windows 10 或 Windows 11 / x64"（`README.md:145-146`）；`config/release-hardware-matrix.json` 要求 `windows-10-22h2-nsis-lifecycle`、`windows-11-current-full-smoke`、100/125/150/200% DPI、混合 DPI 负坐标、休眠/锁屏、RDP、NSIS/portable；`docs/releases/HARDWARE_ACCEPTANCE.md:52-55` 明确 GitHub hosted runner 不提供这些证据；本机 WebView2 157.0.4341.42、OS build 26300。调研 §6.1 指出 WGC `CreateForWindow` 最低要求 Windows 10 1903，若选该路径必须冻结最低 build 或保留替代后端。
- **失败分支**：若 WGC/WebView2 无法覆盖旧系统 → 提高最低系统版本（必须显式兼容决策，计划 §1 禁止未经决策默默提高 README 要求），或保留替代采集/渲染后端并计入成本。
- **建议**：**待验证**。R0-07 用真实测试机 + WebView2 有/无/离线矩阵冻结最低 Windows build 与 Runtime 下限；在此之前 README 现状保持不变。
- **未解决限制**：目标用户 Windows 10 占比与升级路径未知；WebView2 Fixed Version 的体积、更新责任与 EOL 风险未评估；Windows 10 22H2 的官方支持状态与产品声明之间的兼容决策未在仓库记录。

### 4.4 二进制资源传输（图片/视频/大对象，决定 R1/R4/R5 资源通道）

- **备选**：A. command 返回 JSON/base64（实现简单，但大图/视频膨胀内存并重复过 JSON）；B. 自定义协议/asset protocol（需处理 CSP、Range/seek、取消、路径遍历）；C. 后端分配不可猜测的资源 ID + 二进制响应/受限 URI（计划 §4.3 倾向）；D. 每窗口独立通道 + 归属校验。
- **当前证据**：计划 §4.3 要求：控制消息与大二进制分离、资源 ID 限定生命周期/尺寸/类型/归属/释放、图片不重复 Base64、视频不走全局 JSON 事件；若自定义协议无法可靠识别调用窗口，不能伪造"已按窗口鉴权"，敏感内容改走 command 二进制响应。现有实现：`main/services/image-buffer.js`（PNG data URL）、`main/services/clipboard-thumbnail-cache.js`（8 MiB/128 条双阈值）、`shared/clipboard-protocol.js:5-7`（1 MiB/512 KiB/256 KiB）、历史缩略图 token 机制（`docs/plans/2026-10-22-clipboard-image-thumbnail-grid-design.md` §5/§8）、`main/services/window-security.js`（CSP/导航限制）。
- **失败分支**：自定义协议无法做窗口归属鉴权或 Range/seek 不可靠 → 敏感内容走 command 二进制响应（计划 §4.3 明确允许，但要记录能力/性能代价）；不得退回"任意路径/任意 URL"的通用加载器（计划 §4.3 禁止）。
- **建议**：**待验证**。R0-06 做小样对比 command 二进制响应 vs 自定义协议（含 Range/seek/CSP/路径遍历/取消/窗口归属），选定后写 ADR；不在 R0 前预设。
- **未解决限制**：Tauri 2 的 response/asset 能力与 WebView2 版本关系未实测；长视频 seek 性能未测；窗口归属鉴权在自定义协议下的可行边界未验证；大资源释放时机（窗口销毁/重建）未验证。

### 4.5 PDF 后端（决定 R4-07）

- **备选**：A. WebView2 打印（`PrintToPDF`/WebView2 print API）；B. 原生 Rust PDF 生成（需自行处理分页、纸型、中文字体嵌入、透明度/表格）；C. 保留 Chromium/Electron 临时 sidecar（违反 D08 终态，仅应急）；D. 系统打印/第三方（不满足自动保存与批量导出）。
- **当前证据**：现有实现 `main/services/pdf-export.js:5-14`（单图/多页走离屏 `capture/print.html` + `printToPDF`）、`:381-402`（隐藏打印窗口复用 `preload-capture.js`，不在 IPC_SURFACES）、`:23`/`:55`（注释记录实测：`pageSize` 单位为英寸、`scale` 值域 [0.1,2]）；多页用一次 `printToPDF` 分页（`:483+`）；`test/pdf-export.test.js`/`pdf-export-multipage.test.js` 用注入 fake 窗口，不启动真实 Electron；调研 §6.5 要求适配而非假定 Rust 图像库可替代全部打印。
- **失败分支**：WebView2 打印不支持自定义纸张/多页/无头打印，或字体/分页与现有产物不一致 → 转原生 PDF 并重估 R4-07（中文字体嵌入与许可是主要成本）；不得只用图片库拼 PDF 冒充文字可搜索/表格输出。
- **建议**：**待验证**。R0-06 做单图 + 多页 PDF 样例（中文、纸张、分页、透明度、表格），与当前 Electron 产物对照尺寸/分页/文字；未实测前不选。
- **未解决限制**：中文字体嵌入与许可/体积；PDF 文字与表格的可搜索性；与现有 `print.html` 几何规则的逐像素等价；打印窗口与主应用资源隔离。

### 4.6 凭据迁移格式（决定 R2/R8）

- **备选**：A. 由旧版 Electron 一次性受控转存到新加密格式（计划 §5.3 倾向）；B. 直接读取 Electron `safeStorage` 密文并用 Rust DPAPI 解密；C. 放弃解密，保留原密文与数据，要求用户重新填写（不静默清空）。
- **当前证据**：`main/services/credential-store.js`：`credentials.apiKey`/`credentials.providerApiKeys` 存 `safeStorage` 密文的 Base64（`:43-48`、`:72-85`）；`isEncryptionAvailable()` 决定读写（`:12-19`），加密不可用时写入返回 `false`、读取回退 legacy 明文配置（`:26-29`、`:58-67`）。可行性调研 §7（`docs/research/2026-11-10-rust-migration-feasibility.md:240`、`:248`）明确：不能假定换成任意 Rust DPAPI 库就能直接解密 Electron 密文；转存须在同一用户安全上下文，禁止明文写迁移 JSON/日志/命令行；计划 §5.3 第 5 条使用合成凭据先验证。
- **失败分支**：B 解密失败或格式变化 → 保留密文 + 要求重填（C），迁移报告列出未迁移凭据；**不得静默清空**，不得把明文落到磁盘中间件/日志/命令行。
- **建议**：**待验证**。R0-06 用合成凭据验证 A（旧版受控转存）与 B（同用户上下文）可行性；夹具只允许合成密钥。
- **未解决限制**：无真实密钥可测；多用户/漫游配置文件/权限提升场景；Electron `safeStorage` 的 app-scope 是否使跨程序解密不可行；迁移中断后的凭据一致性。

### 4.7 测试驱动与版本（决定 R1/R5/R8 的桌面 E2E）

- **备选**：A. WebdriverIO + `tauri-driver`（Tauri 官方 WebDriver 路径）；B. Playwright/CDP 驱动 WebView2 + 宿主侧探针；C. 自研 harness（spawn 宿主 + IPC 探针）；D. 只做单测/契约测试 + 真机清单（无桌面自动化）。
- **当前证据**：现有 E2E 是 Playwright Electron 适配（`e2e/electron-app.js`、`playwright.config.js`），无法直接启动 Tauri；调研 §12/计划 §10 要求 R0 从官方 WebDriver 路径选定并锁版本，渲染器 mock 不能替代真实 Tauri 启动；`main/services/e2e-bootstrap.js` 已有 E2E 环境变量/隔离数据根约定；本机 Windows 11 + WebView2 157.0.4341.42，Chromium sandbox 在受限宿主下无法启动（AGENTS.md §1-2）。
- **失败分支**：`tauri-driver` 在 Windows/WebView2 下不稳定或不支持多窗口/透明窗口 → 退回 B/C，但必须保留"真实 Tauri 启动"证据；测试端点/驱动只进测试构建，生产包必须证明不含（计划 §10）。
- **建议**：**待验证**。R0-03 同时做 `tauri-driver` 最小 probe（启动/窗口/ready-init 顺序/关闭/崩溃恢复）与现有 Playwright 方案的能力对照，锁定版本并写入工具链/CI；不预设。
- **未解决限制**：`tauri-driver` 对 WebView2 版本、透明窗口、多窗口、托盘、文件对话框的支持边界；CI runner 无 GPU 的渲染差异（AGENTS.md:95-101 已有先例）；真机矩阵仍需人工证据（`docs/releases/HARDWARE_ACCEPTANCE.md`）。

## 5. 基线已知缺陷摘要

完整清单与证据见 [feature-parity.md §3](feature-parity.md)（D-01～D-20）。G0 判断最相关的五类：

1. **CI 从未通过的渲染测试**（D-01）：`test/capture-brush-render.test.js` §6.3 网格相位用例自引入起 6 次 CI 全红，本地因硬件光栅通过（`AGENTS.md:95-101`）。
2. **真实桌面链路没有被自动化证明**（D-02/D-03/D-09/D-10/D-15）：截图浮层、贴图、剪贴板、划词、OCR、AI 无桌面 E2E；真实抓屏断言默认关闭；真实剪贴板受私有 Window Station 限制；真实录屏/音频/长录未验证；硬件证据目录为空。
3. **录屏是最高风险域**（D-15）：开发机无 DXGI、E2E 用合成采集源；窗口录制无录中标注、最小化尽力暂停；30 分钟/双音源/音画漂移未验证；崩溃恢复不承诺；事件轨 20Hz、±1 帧对齐。
4. **数据/格式语义只到规格层**（D-07/D-08/D-17）：v3 文档/录屏项目/剪贴板 v2/用量 v1 的 Rust 对齐需要 R0-02 夹具 + 逐字段双端对照（夹具已落地但尚未运行对照）；electron-store 在 EXDEV 回退非原子写；PDF 由 Chromium 打印决定。
5. **发布链未验证**（D-20）：无签名产物、`verify:package` 需真实桌面、安装/升级/回退/WebView2 有/无均未执行。

## 6. 下一轮建议（R1 候选切片 + R0 补证优先级）

### 6.1 前置约束

- **R1 正式放行必须以 G0 通过为前提**（计划 §7 R1 前置 = G0）。G0 未通过前，允许做"不依赖产品行为、不接真实数据"的合同/工具链/测试驱动准备（R0 范围内），但不得开始业务迁移，也不得创建"看起来完成"的空入口。
- R0-03～R0-07 中至少 R0-03（窗口/DPI）、R0-05（媒体）、R0-04（钩子）三项高风险链路必须先有实测结论，G0 才有讨论基础。
- 本文件写作时并行任务（R0-02 合同/夹具、Rust workspace 骨架）尚未收口；R1 切片以其最终提交结果为准。

### 6.2 G0 通过前可做的准备切片（不改变产品行为）

| 切片 | 内容 | 依赖 | 边界 |
|---|---|---|---|
| S0-1 合同收口 | 完成 `contracts/host/host-contracts.json` + 夹具生成/校验；登记 `capture/print.html` 隐藏窗口、`capture:record-history` 死通道、历史双索引；把 `feature-parity.md` §1 与合同逐项对齐 | R0-02 | 只读现有源码，不改生产代码 |
| S0-2 Rust 工具链/CI 骨架 | 固定 rust 1.97.1（`rust-toolchain.toml`）、workspace 锁文件、`cargo fmt/clippy/test`、依赖方向检查、资源白名单审计；不触碰现有 Electron 构建 | R0-02 合同存在 | 只加 `rust-app/` 与 `scripts/rust/` |
| S0-3 测试驱动探针 | `tauri-driver` 最小启动/窗口/关闭 probe + 版本冻结；与 Playwright 方案做能力对照；生产包不含测试端点 | rust-app 可编译 | 只编入测试构建 |
| S0-4 数据/凭据/PDF/资源通道小样（R0-06） | 合成数据上的"成功/失败/恢复"各一例；输出安全边界与选型 ADR | S0-1 | 只读/隔离根，不碰真实用户数据 |
| S0-5 安装适配性探针（R0-07 部分） | WebView2 有/无/离线环境清单、NSIS 测试包、首轮进程树/Private Bytes 对照（固定电源方案与 Release 构建） | R0-03/R0-05 | 未签候选包必须标注 `NotSigned`；不以 Debug 数据下性能结论 |

### 6.3 G0 通过后的 R1 首批切片（建议顺序）

1. **R1-a 宿主编排最小化**：Tauri 2 应用壳 + 单实例 + 托盘按需启动 + 窗口角色注册（实例 generation）+ ready/init 握手 + 日志脱敏；只接 `main` 角色的只读命令（如 `settings:get`、`app:get-info`、`update:status`），在隔离数据根下运行。
2. **R1-b 权限映射**：把 13 个角色在 `IPC_SURFACES` 的 handles/listeners 映射为 Tauri 应用命令权限 + capability；`capture/print.html` 是非角色窗口，显式排除、不开放任何角色能力；在命令入口二次校验窗口角色/资源归属（计划 §4.3：不能只加 capability 文件就宣称隔离）。
3. **R1-c bridge facade 双宿主对照**：先挑 2 个低风险角色（`main` 只读、`record-frame` 事件/订阅型），按现有 preload 的 `invoke`/`send`/`subscribe` 三种调用模式建 facade fixture，对比两个宿主返回结构；不迁移业务。
4. **R1-d 任务/生命周期基座**：OperationRef/registry（窗口实例 + generation + 取消 + 清理）、关窗/隐藏/退出区分、资源回收与日志脱敏；对应 G1 的"初始化/回收/取消"证据。
5. **R1-e 桌面 E2E 接入**：按 R0 选定的驱动把"启动→窗口→ready/init→关闭"纳入 CI；测试端点仅测试构建。
6. **依赖顺序**：R1-a → R1-b → R1-c；R1-d/e 可与 c 并行。每片独立提交，接口变化由单一责任人汇总（计划 §11）。

### 6.4 R0 收尾优先级（G0 前）

1. R0-03 浮层/截图/DPI（同时服务 R4 与 G0 第一条链路）。
2. R0-05 媒体采集（最高风险，结论直接决定路线与估算）。
3. R0-04 钩子提取小样（决定 R3 成本）。
4. R0-06 数据/凭据/PDF/资源通道（决定 R2/R4 合同与安全边界）。
5. R0-07 安装/性能（决定 G0 的版本矩阵与收益判断）。

## 7. 本轮未执行 / 未验证（不得当作已通过）

- **未执行**：产品单测/E2E/覆盖率/长截图/静态门禁/fuses/打包/硬件矩阵/性能对照（完整命令清单见 §2 末尾）。
- **未执行**：任何真机或可见窗口验证（本机副屏、多 DPI、RDP、休眠、真实音频设备）。
- **未执行**：Rust/Tauri 构建、运行、探针（本分支只有 `rust-app/` 骨架与合同/夹具并行产物）。
- **未验证**：§4 七项决策全部为"待验证"；§5 五类缺陷/缺口未关闭；G0～G4 全部未通过。
- **版本一致性提醒**：本文所有数值是 2026-11-10 本机一次采样的结果；换机器/换 Runtime/换电源方案后不能直接复用为性能基线。性能对照还要求固定 Release 构建、GPU 驱动、数据集、功能开关与回收等待时间（计划 §9.2），这些本轮均未固定。

## 8. 维护约定

1. 任何新的 R0 实测结论（真机、性能、安装、方案选型）必须回写本文件对应栏目，并在 `feature-parity.md` 更新相关功能行的"基线缺陷/未验证"证据。
2. 决策登记从"待验证"变为"已选定"时，必须同时写清：实测条件、失败分支验证结果、剩余限制、责任批次与退出验收（计划 §2 要求）。不得只写结论。
3. 本文件不修改生产代码、不执行 git 写操作；提交由 Lead 统一处理。
