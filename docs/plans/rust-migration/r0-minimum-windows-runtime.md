# R0-07 最低 Windows / WebView2 Runtime 下限调研（候选）

- 日期：2026-11-11（Asia/Hong_Kong）
- 状态：**候选，未冻结；G0 未通过**。本文件只提供调研事实、备选与候选建议，不构成架构冻结、不是 README 变更批准。
- 对应 ADR：[ADR-0007](adr/0007-minimum-windows-runtime.md)
- 上级文档：[Rust 改造方案与开发计划](../2026-11-10-rust-migration-development-plan.md) §1/§7 R0-07、R8-02/§8 G0；[r0-baseline.md](r0-baseline.md) §4.3；[r0-g0-report.md](r0-g0-report.md) §1/§2；[handoff.md](handoff.md) §5 第 7 项
- 关联仓库事实：[README.md](../../../README.md#L141-L156)、[config/release-hardware-matrix.json](../../../config/release-hardware-matrix.json)、[docs/releases/HARDWARE_ACCEPTANCE.md](../../releases/HARDWARE_ACCEPTANCE.md)
- 分支/基线：`codex/rust-r0-baseline-contracts`，HEAD `7c45a7b`（写作时）；本任务**纯文档**，未改代码、构建配置、README 或发布矩阵，未提交 git。
- 证据目录：`.tmp-r07/runtime-researcher/`（gitignore，不提交），文件哈希见 §11。

## 0. 结论摘要（TL;DR）

1. **技术事实**：Electron 43 官方平台下限是 **Windows 10 及以上**（Win7/8/8.1 自 Electron 23 移除）；Tauri 2 自身不另设更高的 Windows 下限，但**强依赖系统 WebView2 Runtime**。Microsoft 目前仍支持 **Windows 10 22H2 上的 Edge/WebView2 更新至至少 2028-10**；同时 Windows 10 22H2 的**操作系统支持已于 2025-10-14 结束**（商业 ESU 最晚至 2028-10-10）。
2. **产品现状与缺口**：README 只写"Windows 10 或 Windows 11"（不写 build/edition），而发布硬件矩阵已经要求 **Windows 10 22H2** 的安装/升级/卸载证据；迁移后 WebView2 从"不存在的外部依赖"变成**产品运行前提**（Electron 版自带 Chromium，Tauri 版不带浏览器）。
3. **建议候选（明确"候选，未冻结"）**：**候选 A + 安装策略 D**——最低 **Windows 10 22H2 x64 / Windows 11 x64**；WebView2 用 **Evergreen** 为默认（NSIS 默认 `downloadBootstrapper`，另提供离线 Standalone 制品）；**Fixed Version 只作为离线/受管/应急渠道，不作为默认**。该候选把 README 的"Windows 10"明确收紧为"Windows 10 22H2"，**必须由产品决策批准**（计划 §1 禁止未经兼容决策默默提高 README 要求）；本轮不改 README。
4. **候选 B（提升到 Windows 11）不是技术必需**：WebView2 在 Win10 22H2 上至少支持到 2028-10，当前发布矩阵也以 Win10 22H2 为硬性 claim；是否放弃 Win10 是用户面/支持成本决策，且本仓库没有 Win10 用户占比数据。
5. **候选 C（内置 Fixed Version）不解决 Win10 EOL**：它把 Chromium 版本固定、可离线，但**更新责任转移到产品**（不自动更新、不能用安装器安装、体积约 +180MB 级），只在"必须锁定渲染版本/无法依赖系统 Runtime"时成立。
6. **全部真机矩阵未做**：本机只有 Windows 11、单屏 150%、已装 WebView2 157.0.4341.46，**不能替代** Win10 22H2 / WebView2 缺失 / 旧版 Runtime / 离线安装 / portable 的验证。G0 前必须补真实测试机矩阵。

## 1. 问题与边界

### 1.1 要回答的问题

1. Electron 43 与 Tauri 2 的 Windows 平台下限分别是什么？两者之间是否存在"迁移后技术下限被迫变化"的硬约束？
2. WebView2 Runtime 支持哪些 Windows 版本、Evergreen 如何更新、Fixed Version 的更新责任与 EOL 风险是什么？离线安装器与 Bootstrapper 的差异、体积如何？
3. Windows 10 已于 2025-10-14 EOL 后，WebView2 是否仍支持 Win10？这对"继续支持 Win10"意味着什么？
4. 产品当前声明（README/发布矩阵/硬件验收）与迁移后技术事实之间有哪些差异，哪些必须由产品决策而不是工程默认？
5. 为冻结最低系统/运行时下限，需要哪些**真实测试机**证据？R8-02 安装策略与 README 应得到什么输入？

### 1.2 边界与不做的事

- 本任务只做调研与文档，不改 `main/`、`preload*.js`、`shared/`、`native/*`、`package.json`、现有 Electron 构建入口/CI，不接原型进产品入口，不 npm install 进仓库，不提交 git。
- **不写"已冻结/已选定"**：G0 未通过；所有建议是候选。
- **不臆造实测**：没有真实测试机证据的项一律标"未验证（需真实测试机）"。本机单点事实不作为矩阵结论。
- 不审阅 WebView2 每个稳定版发布说明，不对具体 Chromium 回归下结论；只记录与本决策相关的最小事实。

### 1.3 事实核查口径

- 官方事实：2026-11-11 当天用本会话 web_fetch 抓取官方页面正文后摘录，URL 与摘录见 `.tmp-r07/runtime-researcher/official-sources.md`；网页可能更新，引用时保留抓取日期。
- 本机事实：2026-11-11 在本机（SHERUNLOCK02）执行命令得到的输出，命令与输出见 `.tmp-r07/runtime-researcher/local-facts.txt` 与 §2.3。
- 体积观测：只发 HTTP HEAD（不下载、不运行安装器），结果见 `.tmp-r07/runtime-researcher/webview2-installer-head.txt`。
- 正文用 M1/T3/W3 等编号引用官方来源（编号与 `.tmp-r07/runtime-researcher/official-sources.md` 的表格一致）；对应 URL 在 §2.2 各表中给出。

## 2. 现状

### 2.1 产品当前声明与发布门禁（仓库事实）

| 项 | 当前内容 | 位置/证据 | 与迁移的关系 |
|---|---|---|---|
| 使用安装包系统要求 | "Windows 10 或 Windows 11"、"x64 处理器" | [README.md:145-146](../../../README.md#L145-L146) | **不写 build/edition**；无法据此判断是否承诺 Win10 22H2 之前的版本 |
| 安装包运行时说明 | "OCR 模型、Electron 运行时和所需原生组件会随正式安装包一起提供。" | [README.md:148](../../../README.md#L148) | 迁移到 Tauri 后该句不再成立：**WebView2 默认不随包**（Tauri 默认 downloadBootstrapper），且 Electron 运行时被移除 |
| 本地开发要求 | "Windows 10 或 Windows 11 x64" | [README.md:152](../../../README.md#L152) | 开发机要求与运行要求需分开表述（Rust/MSVC/WebView2） |
| 发布硬件矩阵 | 硬性 claim：`windows-10-22h2-nsis-lifecycle`（osFamily=`windows-10`, osVersion=`22H2`）、`windows-11-current-full-smoke`；另有 DPI 100/125/150/200%、混合 DPI 负坐标、休眠/锁屏、RDP、NSIS/portable 数据与更新路径 | [config/release-hardware-matrix.json:4-15](../../../config/release-hardware-matrix.json#L4-L15)（其余 claim 在文件内） | 发布门禁**已经假设** Win10 22H2 必须通过安装/升级/卸载验证；提高最低系统会牵动矩阵与验收流程 |
| 硬件验收约束 | "任何人都不能用一次本机 smoke 代替 Windows 10、DPI、RDP 或休眠恢复矩阵"；"矩阵要求 Windows 10 22H2、当前稳定 Windows 11、100%/125%/150%/200% DPI、混合 DPI 负坐标双屏、睡眠/唤醒/锁屏、RDP、NSIS 和 portable。GitHub hosted runner 只执行自动化测试，不提供这些真实硬件证据。" | [HARDWARE_ACCEPTANCE.md:5](../../releases/HARDWARE_ACCEPTANCE.md#L5)、[:52-55](../../releases/HARDWARE_ACCEPTANCE.md#L52-L55) | 最低系统结论必须有真机证据；当前 `docs/releases/evidence/` 不存在（r0-baseline §4.3/§5） |
| R0 §4.3 决策登记 | 备选、当前证据、失败分支、建议、未解决限制均登记；明确"README 现状保持不变，待 R0-07 真机矩阵冻结" | [r0-baseline.md §4.3](r0-baseline.md) | 本文件是该节的展开，不改变其"待验证"状态 |
| 计划 §1 约束 | "最低 Windows build、WebView2 Runtime 下限及媒体后端在 R0 验证后冻结；**不能未经兼容决策默默提高 README 中的系统要求**。" | [计划 §1:21](../2026-11-10-rust-migration-development-plan.md) | 候选 A 也属于"明确收紧 README 下限"，必须产品决策 |
| R8-02 验收 | "正式 NSIS/便携制品、WebView2 离线/在线策略、资源清单和 DLL/模型加载"；验收"无开发环境依赖；**不只验证本机已安装 Runtime 的情况**" | [计划 §7 R8-02:381](../2026-11-10-rust-migration-development-plan.md) | 安装策略必须覆盖 Runtime 缺失/离线/旧版，见 §7 |
| G0 门禁 | 必备证据含"版本矩阵（Windows/WebView2 有/无/离线）"；当前登记"**未做**（R0-07）" | [r0-g0-report.md §1](r0-g0-report.md)、[handoff.md](handoff.md)（历史快照 §5） | 本文件不补实测，只定义矩阵计划与候选；G0 仍缺该项 |

### 2.2 技术事实（官方来源；抓取日期 2026-11-11）

#### 2.2.1 Electron 43

| 事实 | 官方来源 | 对本决策的含义 |
|---|---|---|
| Electron 当前 README：**"Windows (Windows 10 and up)"**，提供 x64/arm64 二进制 | https://github.com/electron/electron#platform-support（抓取 2026-11-11） | 当前产品（Electron 43.8.3）平台族下限是 Windows 10；官方未再细分 Win10 build |
| Electron 23 起移除 Windows 7/8/8.1："Windows 10 or later will be required to run Electron v23.0.0 and higher." | https://www.electronjs.org/docs/latest/breaking-changes | 与 README"Windows 10 或 Windows 11"一致；Electron 不提供比 Win10 更低的兼容 |
| Electron 43 = Chromium 150.0.7871.46 / Node v24.17.0 | https://www.electronjs.org/blog/electron-43-0 | Electron 版自带 Chromium，**不依赖系统 WebView2**；迁移后这一形态改变 |
| 官方支持策略：最新 3 个稳定大版本；节奏 8 周 | https://www.electronjs.org/docs/latest/tutorial/electron-timelines | 抓取时最新稳定为 Electron 45（Chromium 156，见 https://www.electronjs.org/blog/electron-45-0 ）；按"45/44/43"规则，43 是**最老的在支持线**，46 发布后将 EOL。当前产品基线升级/迁移的紧迫性增加，但不改变最低系统事实 |
| Electron 23 同时放弃 Windows Server 2012/2012 R2（Chromium 109 计划） | https://www.electronjs.org/blog/electron-23-0 | 产品未声明 Server 支持，本 ADR 不扩展到 Windows Server |

> 注意：Electron README 的 "Windows 10 and up" 没有给出 Win10 具体 build 下限，也没有单独承诺"Win10 22H2 之后仍支持"；不能据此把产品要求写成"任意 Windows 10 版本都保证可用"。Electron 43 在 Win10 22H2 上能否长期获得 Chromium 安全修复取决于 Electron 版本支持窗口（43 即将 EOL），这是迁移紧迫性而非本 ADR 的最低系统下限。

#### 2.2.2 Tauri 2

| 事实 | 官方来源 | 对本决策的含义 |
|---|---|---|
| Tauri 2 Windows 前提：MSVC Build Tools + **Microsoft Edge WebView2**；平台列表仍写 "Windows 7 and later" | https://v2.tauri.app/start/prerequisites/（抓取 2026-11-11） | Tauri 自身不把下限抬到 Win11；但"Windows 7+（开发前提）"不等于产品可承诺 Win7/8.1（见 WebView2 生命周期） |
| "WebView2 is supported on Windows 7 and newer and comes preinstalled on Windows 11. On versions older than Windows 11 the installer generated by Tauri takes care of ensuring WebView2 is installed on the system." | https://v2.tauri.app/reference/webview-versions/（抓取 2026-11-11） | Tauri 文档把"WebView2 支持面"当作自身支持面；该句需与 Microsoft 当前生命周期（Edge 109 起不再支持 Win7/8.1）分开判断，不能直接当产品下限 |
| Windows 安装器提供 WebView2 安装模式：默认 `downloadBootstrapper`；`embedBootstrapper`；`offlineInstaller`；`fixedVersion`；`skip` | https://v2.tauri.app/distribute/windows-installer/（抓取 2026-11-11） | R8-02 的选项语义与体积见 §7 |
| `minimumWebview2Version`：安装器会尝试要求 Runtime ≥ 指定版本，旧则触发更新 | https://v2.tauri.app/reference/config/（抓取 2026-11-11） | R8-02 可用的"最低 Runtime 版本"闸门，需要按功能所需的 WebView2 API 冻结具体版本 |
| Tauri 仍保留 `windows7-compat` 等 Windows 7 说明（历史兼容） | 同上安装器页 | 说明 Tauri 文档没有按 Microsoft 生命周期清理旧平台表述；产品不能照抄 |

**结论**：Tauri 2 不构成比 WebView2/Windows 生命周期更严格的技术下限；迁移后真正的绑定约束是"**目标 Windows 版本是否仍能获得受支持的 WebView2 Runtime**"以及"产品是否接受在没有系统 Runtime 的机器上分发"。

#### 2.2.3 Microsoft WebView2 Runtime

| 事实 | 官方来源 | 对本决策的含义 |
|---|---|---|
| Microsoft Edge 与 WebView2 Runtime **在 Windows 10 22H2 上继续获得更新，至少到 2028 年 10 月**（与 ESU 结束一致；**不要求**购买 ESU 才能获得 Edge/WebView2 更新） | https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems（页面 "Last updated on 2026-08-31"，抓取 2026-11-11） | 候选 A 的**最关键依据**：Win10 22H2 上 WebView2 有明确更新窗口 |
| Edge 支持的 Windows Client 列表：Windows 10 SAC **1709 及以后**、Windows 11；并注明"对已不在支持期的 Win10 SAC 版本，Edge 支持只是升级到受支持 OS 的临时桥" | 同上 | "技术上能跑"≠"应作为产品最低支持版本"；把下限定为 22H2 比"任意 Win10"更可解释 |
| Edge 支持列表还包括 Windows Server 2016/2019/2022/2025/SAC | 同上 | 产品 README 未声明 Windows Server 支持；本 ADR 不扩展到 Server（如需支持需单独立项） |
| Edge 对 Windows 7/8/8.1/Server 2008R2/2012/2012R2 的支持在 **Edge 109** 结束 | 同上（recent changes） | Tauri 文档 "Windows 7+" 不能作为产品下限依据 |
| WebView2 Runtime **预装在 Windows 11**；Windows 10 1803+（带 2022-11 更新）通常预装；**干净安装的 Windows 10、Windows Server、LTSC 可能缺失**；官方要求启动时检查 | https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/webview2（抓取 2026-11-11） | 候选 A 必须处理"Runtime 缺失"；不能假设 Win10 一定有 |
| Evergreen：Runtime 随 Edge 自动更新，所有 Evergreen 应用共享一份；应用**不能要求固定版本**；运行中的 App 会继续使用旧版本直到释放对象/重启；可用 `NewBrowserVersionAvailable` 提示重启 | https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution、https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/developer-guide（抓取 2026-11-11） | 默认策略的安全性与"更新后需重启/行为可能变化"的产品行为输入 |
| Bootstrapper 是"tiny（约 2MB）"安装器，联网下载匹配架构的 Evergreen Runtime；Standalone Installer 是离线完整安装器 | 同 distribution 页 | 与 §2.2.4 的体积观测一致 |
| Fixed Version：随应用打包、**不自动更新**、需自行周期性更新应用+Runtime、**不能用安装器安装**（cab 解压后随包） | https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version（抓取 2026-11-11） | 候选 C 的更新责任/EOL 风险 |
| 官方建议：**Evergreen 用于大多数应用**；Fixed Version 仅用于有严格兼容要求的场景（kiosk/air-gapped/compliance） | developer-guide、https://learn.microsoft.com/en-us/deployedge/webview2-enterprise（抓取 2026-11-11） | 默认选 Evergreen 的官方依据 |
| Fixed Version 磁盘占用（WinUI 3 文档口径）：**约 100–250 MB 随应用打包**；Tauri 口径：安装包增量约 **180MB** | https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/webview2 ；https://v2.tauri.app/distribute/windows-installer/ | 候选 C 的体积成本区间 |
| WebView2 遵循 Microsoft Modern Lifecycle Policy | https://learn.microsoft.com/en-us/deployedge/webview2-enterprise（抓取 2026-11-11） | 生命周期口径统一到 Microsoft |

> **关于 Fixed Version 的 EOL**：本轮检索到的官方文档只说明它不自动更新、需随应用一起更新，**未给出单个 Fixed Version 的 EOL 日期**，也没有按版本列出的支持截止表。因此 Fixed Version 不能当作“永久锁定版本”：其安全寿命由产品自己的更新节奏承担（见 §4.3 与 §9），不能把“锁了版本”误当成“锁了支持期”。

#### 2.2.4 安装器体积观测（本机 HEAD，2026-11-11 13:03 HKT）

| 对象 | 官方链接 | 观测结果 | 说明 |
|---|---|---|---|
| Evergreen Bootstrapper | https://go.microsoft.com/fwlink/p/?LinkId=2124703 | `MicrosoftEdgeWebview2Setup.exe`，**1,897,688 B（约 1.8 MiB）**，Last-Modified 2026-11-03 | 与官方"约 2MB"一致；Tauri `downloadBootstrapper` 默认使用 |
| Evergreen Standalone Installer x64 | https://go.microsoft.com/fwlink/?linkid=2124701 | `MicrosoftEdgeWebView2RuntimeInstallerX64.exe`，**214,990,032 B（约 205 MiB）**，Last-Modified 2026-11-10 | 离线安装载荷的原始体积；Tauri 文档的 `offlineInstaller` "约 +127MB"是 NSIS/LZMA 压缩后的**安装包增量**，两者不能混用 |
| 异常观测 | https://go.microsoft.com/fwlink/?linkid=2124700 | 当天解析为 `MicrosoftWebView2Runtime_158.0.4370.16_Beta.msix`（398,355,619 B） | 不能确认是 Bootstrapper；**不**作为体积证据，保留以免误用 |

命令（可复现，只取响应头）：

```powershell
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -Method Head -MaximumRedirection 10 -UseBasicParsing
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/?linkid=2124701' -Method Head -MaximumRedirection 10 -UseBasicParsing
```

#### 2.2.5 其他系统约束

| 事实 | 官方来源 | 对本决策的含义 |
|---|---|---|
| Windows 10 Home/Pro 支持于 **2025-10-14** 结束；22H2 是最后一个版本 | https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro | 候选 A 要**显式承认**"支持一个已过 OS 支持期的系统"，不能写成"Windows 10 仍在支持期" |
| Windows 10 ESU：2025-10-14 开始；Year 1 至 2026-10-13；Year 2 至 2027-10-12；Year 3 至 2028-10-10；商业版（Enterprise/Education/Pro in Commercial use）资格 | https://learn.microsoft.com/en-us/lifecycle/faq/extended-security-updates | Win10 继续获得 **OS 安全更新**需要 ESU；但 WebView2 更新不要求 ESU（见 2.2.3）。消费级 ESU 条款本轮未在该页确认，列为未解决限制 |
| Windows 11 最低硬件：TPM 2.0、UEFI Secure Boot、4GB RAM、64GB 存储、DX12/WDDM 2.0 | https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements | 候选 B 会排除不满足 Win11 硬件要求但可跑 Win10 的旧机器；用户影响需产品评估 |
| `IGraphicsCaptureItemInterop::CreateForMonitor` 最低客户端：Windows 10 Version 1903（Build 18362） | https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createformonitor | 若 R5 媒体走 WGC（ADR-0001 候选 C），最低 build=1903；若最低系统定为 22H2 则自动覆盖，但**不能**用"WGC 1903"倒推产品支持 1903 |
| 本仓库调研已记录：WGC `CreateForWindow` 最低 Win10 1903；README 只写 Windows 10 时需冻结最低 build | [可行性调研 §6.1](../../research/2026-11-10-rust-migration-feasibility.md)、[r0-baseline §4.3](r0-baseline.md) | 与本 ADR 的候选 A（22H2）一致；若未来降低下限会与 ADR-0001 冲突 |

### 2.3 本机实测事实（SHERUNLOCK02；单点，不是矩阵结论）

采集命令与完整输出：`.tmp-r07/runtime-researcher/local-facts.txt`（sha256 见 §11，2026-11-11 13:01 HKT）。

| 项 | 实测值 | 获取方式 |
|---|---|---|
| Host | `SHERUNLOCK02`（HONOR FRI-GXXX） | `$env:COMPUTERNAME`、`Win32_ComputerSystem` |
| OS | Microsoft Windows 11 家庭版 中文版，Version `10.0.26300`，Build `26300`，**UBR 9974**，DisplayVersion `26H2` | `Win32_OperatingSystem` + `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion` |
| CPU / RAM | Intel i5-13500H，12C/16T；RAM `16,907,100,160 B`（约 15.74 GiB） | `Win32_Processor`、`Win32_OperatingSystem` |
| 磁盘 | C: 剩余约 15 GB；D: 剩余约 199 GB（仓库在 D:） | `Get-PSDrive` |
| 显示 | **1 块屏**（`\\.\DISPLAY1`，主屏），DPI `144`（150%）；逻辑边界 `1493x933` | `System.Windows.Forms.Screen` + `GetDeviceCaps(LOGPIXELSX)` |
| WebView2 Runtime | **157.0.4341.46**，**per-machine（HKLM）已装**；HKCU 键**不存在**（无 per-user 安装） | 读 `HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-...}` 的 `name/pv` |
| 工具链 | node `v24.15.0` / npm `11.17.0` / rustc `1.97.1` / cargo `1.97.1`；仓库内 electron `43.8.3` | `node --version` 等；`node -p require('./node_modules/electron/package.json').version` |
| git | branch `codex/rust-r0-baseline-contracts`，HEAD `7c45a7bf4c33de69a50a2d6b6c0dbb2413f04794` | `git rev-parse HEAD` |

**与旧文档的差异（必须注意）**：handoff/r0-baseline 记录的是**另一台机器**（Ryzen 7 9850X3D、47.2 GiB、F: 仓库、WebView2 157.0.4341.42）。用户已确认以当前机器为准。本文件引用本机事实时**只用今天在本机测得的值**；旧文档中的硬件/WebView2 版本仅作历史参考，不得混用为同一台机器的数据。

**本机能力的边界**：

- 只有 Windows 11（无法在本机复现 Win10 22H2 行为）；
- WebView2 已安装（不能为了测试卸载系统 Runtime 影响用户机器；也没有干净快照）；
- 无离线环境（不能模拟目标机断网安装）；
- 无旧版 WebView2（不能回退系统 Runtime）；
- **单屏 150%**（AGENTS.md 要求可见窗口默认副屏；本机无副屏，只能在必要时经用户同意短暂开窗，且不能替代多 DPI/多屏/混合 DPI 矩阵）；
- 因此**本机只能证明"在 Windows 11 + WebView2 157 上某条命令/行为成立"**，不能用于 Win10/缺失/离线/旧版/portable 的任何结论。

## 3. 差异与必须由产品决策的兼容问题

### 3.1 产品声明 vs 技术事实

| # | 当前声明/默认 | 技术事实 | 差异与风险 | 需要谁决策 |
|---|---|---|---|---|
| C1 | README："Windows 10 或 Windows 11"（无 build） | Microsoft 对 Win10 各 SAC 版本的支持状态不同：只有 22H2 是"最终版本"且有 ESU/WebView2 更新窗口；更早的 1709–21H2 已过支持期，Edge 明确称其为"临时桥" | 若产品继续写"Windows 10"，等于对 1709–21H2 也作兼容承诺，**无法自洽**；若改成"Windows 10 22H2 或更新"，是**收紧**（提高下限），计划 §1 要求显式兼容决策 | **产品决策**（工程只给候选与证据） |
| C2 | README:148："Electron 运行时…随正式安装包一起提供" | Tauri 迁移后不带浏览器；WebView2 默认不随包（downloadBootstrapper），Win10 干净安装/Server/LTSC 可能缺失 | 用户可能在"安装成功但启动失败/白屏"之间遇到新失败模式；安装器与支持文档必须处理 | 产品 + R8-02 工程 |
| C3 | 发布矩阵要求 Win10 22H2 硬性 claim | 若最低系统提高到 Win11（候选 B），该 claim 与 `HARDWARE_ACCEPTANCE.md` 必须同步删除/替换 | 只改 README 会造成"文档说 Win11，发布门禁仍要 Win10 证据"的自相矛盾；矩阵、证据 schema、发布参数、README 必须同批修改 | 产品决策后，R8-04/R8-02 执行 |
| C4 | Windows 10 OS 已 EOL（2025-10-14） | WebView2 在 Win10 22H2 上仍更新到至少 2028-10；OS 自身安全更新需 ESU（商业版最多到 2028-10-10） | 产品可以继续支持 Win10 22H2（技术可行），但这是**有意识的兼容决策**，不是"技术没障碍所以默认继续"；需要评估用户占比、支持成本与安全口径 | **产品决策** |
| C5 | 迁移后默认 Evergreen | Evergreen 自动更新、不可锁版本；运行中 App 更新后需重启；企业策略可能暂停更新 | 旧 Runtime 可能导致新 API 不可用/行为差异；需要 `minimumWebview2Version` 与启动检测 | R8-02 + 产品（错误 UX） |
| C6 | 迁移后可选 Fixed Version | 不自动更新、不能用安装器安装、体积约 +180MB/100–250MB、更新责任在自身 | 若没有固定的安全更新节奏，Fixed Version 会变成"自带旧 Chromium"，风险高于 Evergreen；只在特定渠道成立 | 产品安全评审 + R8-02 |
| C7 | 媒体候选 C 依赖 WGC（ADR-0001） | WGC `CreateForMonitor` 最低 Win10 1903 | 若最低系统定为 22H2，WGC 天然满足；若未来降低下限，需保留 GDI 回退并重新评估 | R5/ADR-0001；本 ADR 只需保持一致 |
| C8 | 发布矩阵含 RDP/睡眠/多 DPI 等 claim | WebView2 在 RDP/无 GPU 环境的渲染与进程行为未在本轮验证（R0-06 已有 Electron 侧部分证据，Tauri 侧未做） | WebView2 渲染差异可能影响截图/录屏/DPI；属 R8-04 矩阵，不应并入本 ADR 冒充"Runtime 下限证据" | R8-04 |

### 3.2 一句话总结

**迁移不会因为 Tauri 2 而"技术上强制"提高 Windows 下限；真正的决策点是"是否继续承诺 Windows 10 22H2"以及"如何处理 WebView2 这个新的系统依赖"。** 两者都需要产品显式决策并补齐真机矩阵，不能由工程默认或文档静默改变。

## 4. 候选选项

> 说明：所有选项的"证据"目前只到**官方文档 + 本机单点**级别；"Win10 22H2 真机/无 Runtime/离线/旧版"一律未验证。体积为官方文档口径与本机 HEAD 观测，不是最终安装包实测。

### 4.1 候选 A：维持 Windows 10 22H2 + Windows 11，WebView2 Evergreen 为默认

**描述**：最低系统 = Windows 10 22H2 x64 或 Windows 11 x64；WebView2 使用 Evergreen（NSIS 默认 `downloadBootstrapper`，启动前/安装时检测 Runtime）；离线用户提供 Evergreen Standalone 离线安装器制品（`offlineInstaller` 或独立下载说明）。**不默认内置 Fixed Version。**

| 维度 | 内容 |
|---|---|
| 证据 | Edge/WebView2 在 Win10 22H2 至少更新到 2028-10（官方，M1）；Win11 预装、Win10 1803+ 多数预装但可能缺失（M8）；Bootstrapper 约 1.8MiB / Standalone 约 205MiB（本机 HEAD）；现有发布矩阵已要求 Win10 22H2（仓库事实） |
| 优点 | 保留 Win10 22H2 用户；安全更新跟随 Edge；安装包默认体积最小；与现有发布矩阵/验收文档冲突最小（只需明确 build 下限与 Runtime 检测，不需删除 Win10 claim） |
| 成本/代价 | 必须维护 Win10 22H2 真机/VM 矩阵；必须实现 Runtime 检测与错误 UX；在线安装依赖网络，需额外离线制品；要接受"支持已过 OS 支持期的系统"这一产品口径并写清楚 |
| 失败分支 | ① 目标机无 Runtime 且无网络 → NSIS 在线安装无法完成；必须回退到离线安装器或明确失败提示（不能白屏/静默失败）。② Win10 22H2 上 WebView2 更新引入渲染回归 → 需要回滚/兼容策略与旧版矩阵。③ 用户机器被企业策略冻结旧 Runtime → 需要 `minimumWebview2Version` 闸门与可诊断错误。 |
| 风险 | Win10 用户占比未知；Win10 EOL 后的安全支持成本；Evergreen 自动更新导致行为漂移（需前瞻兼容测试，官方建议用 Edge preview 通道）；旧版 Runtime 失败面未测 |
| 需要验证 | §6 矩阵全部；尤其 W10-1/2/3/4 与 W11-2/4；安装器检测/错误 UX；portable 行为 |

### 4.2 候选 B：提升最低系统到 Windows 11（当前受支持版本）

**描述**：只支持 Windows 11 x64（当前稳定版本，如 25H2/26H2），WebView2 Evergreen。

| 维度 | 内容 |
|---|---|
| 证据 | Win11 预装 WebView2（M8）；Win11 仍受 OS 支持；Win11 硬件要求明确（TPM 2.0/Secure Boot/4GB/64GB，W3）；可去掉 Win10 真机矩阵与 ESU 讨论 |
| 优点 | OS 与 Runtime 都有明确支持窗口；测试矩阵更小；避免"支持已 EOL 的 Win10"的安全/支持争议；与 WebView2 预装面一致 |
| 成本/代价 | **放弃 Win10 用户**（占比未知）；必须同步修改 README、`config/release-hardware-matrix.json`（删除/替换 `windows-10-22h2-nsis-lifecycle`）、`HARDWARE_ACCEPTANCE.md`、证据 schema 与发布流程；需要产品/运营决策与用户沟通；计划 §1 明确禁止未经兼容决策提高要求 |
| 失败分支 | ① 改动只到 README、矩阵/验收未同步 → 发布门禁与文档自相矛盾；② Win10 用户升级意愿低 → 用户流失/负面反馈；③ 旧设备不满足 Win11 硬件（TPM/Secure Boot）→ 即使愿意升级也无法使用 |
| 风险 | 无 Win10 用户占比数据（未验证）；若后续发现 Win10 用户占比高，回退成本高（重新加回矩阵/测试）；Win11 版本节奏（25H2/26H2）也需定义"当前稳定版"口径 |
| 需要验证 | 产品/数据分析（用户 OS 占比）；若选择 B，需重做发布矩阵与验收文档；仍需 Win11 无 Runtime/离线矩阵 |

### 4.3 候选 C：维持 Windows 10 22H2 + Windows 11，但内置 Fixed Version WebView2

**描述**：随安装包携带固定版本的 WebView2 Runtime（Tauri `fixedRuntime`，cab 解压目录随包），不依赖系统 Evergreen。

| 维度 | 内容 |
|---|---|
| 证据 | Fixed Version 可锁 Chromium 版本、可离线、不依赖系统 Runtime（M5/M8）；Tauri 安装包增量约 +180MB（T3），WinUI3 口径磁盘约 100–250MB（M8）；不能用安装器安装、需随包分发（M5） |
| 优点 | 渲染行为可复现（对 Canvas/PDF/媒体等价性验证友好）；离线/受管环境不依赖系统更新策略；不受目标机 Evergreen 版本差异影响 |
| 成本/代价 | 安装包显著变大（约 +180MB 级）；每个 Runtime 版本都要随产品更新并重新签名/发布；无法用安装器静默升级 Runtime；多份 Runtime 占用磁盘；需要长期跟踪 Chromium 安全修复并**主动**发布更新 |
| 失败分支 | ① 更新节奏跟不上 → 自带旧 Chromium 的已知漏洞（安全风险高于 Evergreen）；② 应用使用的新 API 与固定版本不匹配 → 需要版本闸门/功能降级；③ 安装包体积影响下载/安装成功率（未测）；④ Tauri `fixedRuntime` 需 cab 解压目录与路径配置，打包/签名/资源清单都要改（R8-02 未验证） |
| 风险 | **不解决 Win10 EOL**（只是换一种 Runtime 分发方式）；安全责任显著上升；与官方"Evergreen 推荐"方向相反，需要充分理由（受管/离线/严格兼容） |
| 需要验证 | 固定版本打包/安装/卸载/升级；固定版本安全更新流程；体积与下载转化；与 Evergreen 行为差异矩阵；目标机是否需要（很多 Win10/11 已预装） |

### 4.4 候选 D：A + 分渠道安装策略（默认 Evergreen，离线/受管另发制品；Fixed Version 仅应急）

**描述**：系统下限与候选 A 相同（Win10 22H2 / Win11）；默认 NSIS 在线 `downloadBootstrapper`；另提供**离线 Standalone 制品**（`offlineInstaller` 或独立离线安装器）与**受管环境说明**；Fixed Version 只作为"必须锁定 Runtime/无法使用 Evergreen"的例外渠道（默认不发）。

| 维度 | 内容 |
|---|---|
| 证据 | 同 A；Tauri 安装模式与 `minimumWebview2Version` 配置（T3/T4）；官方建议 Evergreen 为默认、Fixed Version 仅严格兼容场景（M6/M7） |
| 优点 | 兼顾默认安全更新与离线可用性；不把 +180MB 强加给所有用户；给企业/受管用户明确路径；与 R8-02"WebView2 离线/在线策略"验收直接对齐 |
| 成本/代价 | 需要维护两种（或三种）制品与对应验收；离线制品与在线制品的更新说明、SHA-256、签名都要独立管理；需要决定 Fixed Version 渠道是否真的存在（否则不做） |
| 失败分支 | ① 离线制品长期不更新/无签名 → 与在线包行为不一致；② portable 版无法在安装阶段装 Runtime → 必须启动时检测/引导（见 §7）；③ 渠道过多导致测试矩阵膨胀 |
| 风险 | 与 A 相同的 Win10 EOL/用户占比风险；额外制品增加发布复杂度（R8-02 成本） |
| 需要验证 | 同 A，并加离线制品安装/卸载/升级；Fixed Version 渠道的触发条件与安全更新 SLA（若保留） |

### 4.5 候选对比

| 维度 | A（Evergreen，Win10 22H2） | B（Win11 only） | C（Fixed Version，Win10 22H2） | D（A + 分渠道） |
|---|---|---|---|---|
| 最低系统 | Win10 22H2 / Win11 | Win11 | Win10 22H2 / Win11 | Win10 22H2 / Win11 |
| 默认 Runtime | Evergreen | Evergreen | Fixed Version | Evergreen + 离线/例外渠道 |
| 默认安装包增量 | ~0（Bootstrapper 约 1.8MiB 可选内嵌） | ~0 | **约 +180MB 级** | ~0（离线制品另发） |
| 安全更新责任 | Microsoft（Edge/WebView2） | Microsoft | **产品自身**（必须定期发版） | Microsoft（主渠道） |
| 离线可用 | 需另发离线制品（Standalone 约 205MiB 原始） | 同 A | 天然离线 | 离线制品 |
| 与现有发布矩阵冲突 | 最小（已要求 Win10 22H2） | **大**（要删 Win10 claim） | 中（保留 Win10；新增固定版本打包验收） | 最小 + 离线制品 |
| 主要未验证风险 | Win10 真机/无 Runtime/旧版/离线 | 用户占比未知；矩阵重写 | Runtime 更新节奏/漏洞/体积 | A 的风险 + 制品管理 |
| 当前建议 | **候选（推荐组合 D 的安装策略）** | 不推荐现在选 | 仅特定渠道 | **推荐并入 A** |

## 5. 建议候选（候选，未冻结）

### 5.1 建议

**建议候选 A + D（安装策略）**：

> 最低支持 **Windows 10 22H2 x64 或 Windows 11 x64**；WebView2 默认使用 **Evergreen**（NSIS 默认 `downloadBootstrapper`；安装前/启动前检测 Runtime，缺失时给出可操作错误或引导安装）；为离线场景提供 **Evergreen Standalone 离线制品/说明**；**Fixed Version 不作为默认**，仅在"必须锁定 Runtime 或无法依赖系统 Evergreen"的受管/离线渠道单独评估。

同时建议产品**显式批准** README 文案从"Windows 10 或 Windows 11"收紧为"**Windows 10 22H2 或更新（含 Windows 11）**"或等价表述（见 §8），不得由工程静默修改。

### 5.2 置信度与理由

- **技术事实置信度：高**。官方来源明确（Edge/WebView2 支持到 2028-10、Win10 EOL 2025-10-14、Tauri 依赖 WebView2、Evergreen/Fixed 差异），本机可复核体积/注册表事实。
- **产品决策置信度：中低**。没有 Win10 用户占比、支持成本、安全口径数据；"继续支持 Win10 22H2"是业务取舍，不是技术必然。
- **工程可行性置信度：中**。WebView2 检测/安装/离线/portable 的完整链路**未在本仓库验证**（R8-02 未开始）；Tauri 侧无 portable 打包方案（Tauri 文档只覆盖 NSIS/MSI；§7）。
- **建议强度**：候选 A/D 是"**证据支持、成本可控、与现有矩阵冲突最小**"的选项；不是在产品批准前的最终结论。若产品给出 Win10 用户占比与安全口径并决定放弃 Win10，候选 B 也可以成为合理选择；若目标用户大量处于离线/受管环境，候选 C 的 Fixed Version 需要单独评审而非默认。

### 5.3 建议依赖的未验证前提

1. Win10 22H2 目标机在真实安装/升级/卸载中行为可接受（需 §6 矩阵）。
2. 无 Runtime 的 Win10/Win11 机器上，NSIS 在线安装的失败/引导体验可接受，且离线制品可完成安装（需 W10-2/W10-4/W11-2/W11-4）。
3. 旧版 Runtime（例如被企业策略冻结）不会导致关键功能不可用，或 `minimumWebview2Version` 能给出可诊断结果（需 W10-3/W11-3）。
4. Win10 22H2 上的 WebView2 在 2026-2028 期间的更新不会破坏本产品（需定期前瞻兼容测试，官方建议用 Edge preview 通道；本轮未做）。
5. 产品批准"支持已过 OS 支持期的 Windows 10 22H2"这一兼容口径；README/支持文档/发布矩阵同步修改（R8-04/G4 前）。
6. portable 分发能在没有安装器阶段的情况下处理 Runtime 缺失（需 P-1 验证与 R8-02 设计）。

## 6. 真实测试机矩阵（计划，未执行）

> 状态：**全部未执行**。本机不能替代（见 §2.3）。执行后证据写入 R0-07 统一证据目录（本任务建议 `.tmp-r07/runtime-researcher/`，或 R0-07 约定的 `.tmp-r0-07/`，均为 gitignore），关键输出/哈希回写本文件与 G0 报告；不得提交大日志与真实用户数据。

### 6.1 为什么必须用真实测试机/干净 VM

| 本机限制 | 不能证明的项 |
|---|---|
| 只有 Windows 11（本机 26H2 / build 26300.9974） | Win10 22H2 的 NSIS 安装/升级/卸载、启动行为、WebView2 版本与更新路径 |
| WebView2 已安装（157.0.4341.46，per-machine） | Runtime 缺失时的安装/启动体验；per-user Runtime 安装；`minimumWebview2Version` 触发更新 |
| 无离线环境 | `downloadBootstrapper` 在断网时失败/回退；`offlineInstaller` 制品可用性；离线升级 |
| 无法回退/冻结 Runtime | 旧版 Runtime 的 API 可用性、白屏/崩溃、策略冻结更新 |
| 单屏 150%、无副屏 | 多屏/混合 DPI/负坐标下的 Runtime 渲染差异（属 R8-04 矩阵，不由本 ADR 冒充） |
| 用户机器 | 不能为测试卸载系统 Runtime 或改企业策略；不得写真实用户数据/凭据 |

### 6.2 矩阵

| ID | 环境 | WebView2 状态 | 网络/制品 | 验证项 | 通过判据 | 载体 |
|---|---|---|---|---|---|---|
| W10-1 | Win10 22H2 x64（最新补丁） | 最新 Evergreen（系统已装） | 在线；NSIS 默认包 + portable | 安装/覆盖升级/卸载保留数据；启动；截图/OCR/贴图基础烟测；Runtime 版本记录；进程组 | 安装与升级成功；功能烟测通过；无孤儿进程；数据保留；记录 Runtime 版本 | 真机优先（VM 可补充） |
| W10-2 | Win10 22H2 x64 **干净**（无 WebView2：新装系统未更新或专用快照） | **无** | 在线；NSIS 默认包 | 安装时 Runtime 检测/下载/安装；失败时的错误文案与退出码；安装后能启动 | 缺 Runtime 时有明确提示或自动安装成功；不出现白屏/静默失败；失败可诊断 | VM 快照（必须干净） |
| W10-3 | Win10 22H2 x64 | **旧版 Evergreen（如 109/120/128；或策略冻结在旧版）** | 在线；NSIS 默认包 | 启动检测；`minimumWebview2Version` 行为；关键功能（截图/PDF/录屏 UI）是否可用；升级提示 | 低于最低版本时给出可操作提示/触发更新；不低于最低版本时功能可用；失败可诊断 | VM（固定 Runtime 版本） |
| W10-4 | Win10 22H2 x64 | 无/旧（按制品设计） | **离线**（断网）；offline 制品 | 离线安装（offlineInstaller/Standalone）；离线升级；安装后 Runtime 版本；应用启动 | 断网安装成功；应用可启动；Runtime 版本符合预期；失败有明确错误 | VM（断网） |
| W11-1 | Windows 11 当前稳定版 x64 | 最新 Evergreen（预装/已装） | 在线；NSIS 默认包 + portable | 安装/升级/卸载；全功能烟测（功能范围按 R8 验收） | 同 W10-1；记录 OS build 与 Runtime 版本 | 真机（本机可做部分，但不能代表"当前稳定版"矩阵） |
| W11-2 | Windows 11 当前稳定版 x64 **干净** | **无**（少见，但 Server/LTSC 经验说明可能） | 在线；NSIS 默认包 | 同 W10-2 | 同 W10-2 判据 | VM 快照 |
| W11-3 | Windows 11 当前稳定版 x64 | 旧版/策略冻结 | 在线 | 同 W10-3 | 同 W10-3 判据 | VM |
| W11-4 | Windows 11 当前稳定版 x64 | 无/旧 | 离线；offline 制品 | 同 W10-4 | 同 W10-4 判据 | VM |
| U-1 | Win10 22H2 / Win11 各一台 | per-user Runtime（非管理员安装） | 在线 | 非管理员安装 NSIS；Runtime 安装为 per-user/被提升为 per-machine 的行为；卸载 | 安装成功；Runtime 检测正确；卸载不误删共享 Runtime | VM（非管理员账号） |
| U-2 | 同上 | per-machine Runtime | 在线 | 管理员安装；卸载；升级 | 同 U-1 判据；不破坏其他 Evergreen 应用 | VM |
| P-1 | Win10 22H2（无 Runtime）/ Win11 | 无/有 | 在线+离线 | portable exe 启动：无 Runtime 时的错误/引导；有 Runtime 时启动；数据根/更新通道行为 | 无 Runtime 时明确错误并可操作（或按 R8-02 设计自带方案）；有 Runtime 时正常；不误用 NSIS 更新器 | VM（干净快照） |
| R-1 | Win11 + Win10 22H2 | 最新 Evergreen，观察自动更新 | 在线 | Runtime 自动更新后 App 的重启提示/行为；旧 Runtime 兼容性；`NewBrowserVersionAvailable` 是否按设计处理 | 更新可被感知；需要重启时提示；旧版本仍可工作（或按最低版本策略失败） | VM（可控更新） |
| S-1 | 签名/升级/回退 | 任意 | 在线/离线 | 参考 `HARDWARE_ACCEPTANCE.md` 的签名、升级、回退流程；本 ADR 只要求记录 WebView2 版本与安装模式 | 与发布矩阵一致；`webview2Version`/安装模式可追溯 | 真机/VM |

### 6.3 通过/失败判据与证据要求

- **通过**：安装/升级/卸载成功；应用能启动并完成该环境定义的烟测；Runtime 缺失/旧版有**明确、可操作**的错误或自动处理；无白屏/静默失败/孤儿进程；数据保留（升级/卸载）；Runtime 版本与安装模式被记录。
- **失败**：任何 "安装成功但启动失败"、"缺 Runtime 时无提示"、"旧 Runtime 下核心功能不可用且无诊断"、"升级后数据丢失"、"卸载影响其他 Evergreen 应用" 都算失败，必须记录复现步骤与 Runtime 版本。
- **证据格式**：沿用 `scripts/collect-hardware-evidence.ps1` 的环境字段（OS/GPU/DPI 等）；**建议 R8-04 评估给证据 schema 增加 `webview2Version` 与 `webviewInstallMode` 字段**（本轮不改代码/配置，仅作为 R8-04 输入）。证据 JSON 放 `docs/releases/evidence/<version>/`；运行证据放 `.tmp-r0-07/`（不提交）。
- **VM 与真机边界**：VM/快照可用于"OS 版本 × WebView2 存在性/版本 × 安装类型 × 网络"矩阵；**GPU/DPI/多屏/媒体/真实音频必须真机**，不能用 VM 结果代替 `HARDWARE_ACCEPTANCE.md` 的硬件矩阵。
- **许可与合规**：Win10 ISO/VM 许可、测试机隔离、不得在真实用户机器上卸载 Runtime 或修改策略；不得记录机器名/用户名/序列号/凭据。
- **可见窗口**：按仓库 `AGENTS.md`，可见测试窗口默认放副屏；本机无副屏时先征得用户同意，且只用于必要的人工步骤；能无窗口验证的优先无窗口。

### 6.4 矩阵执行顺序（建议）

1. W11-1（本机可先做安装/升级/烟测，作为对照，不替代其它行）；
2. W10-1 + W10-2（Win10 真机/VM；验证"能装 + 缺 Runtime"两个最基本问题）；
3. W10-4 / W11-2 / W11-4（离线与干净环境，R8-02 的前提）；
4. W10-3 / W11-3 / U-1 / U-2 / P-1 / R-1（旧版、非管理员、portable、自动更新）；
5. 汇总到 G0 报告与 ADR-0007 的变更记录；G0 通过后才讨论冻结。

## 7. 对 R8-02 安装策略的输入

### 7.1 建议策略

1. **默认在线 NSIS**：`webviewInstallMode = downloadBootstrapper`（Tauri 默认，0MB 增量，安装时按需联网下载 Runtime）；安装器在缺 Runtime 时给出可诊断错误/下载失败处理。
2. **离线制品**：为无网络环境单独提供 `offlineInstaller` 包或官方 Standalone 安装器 + 明确说明（官方 Standalone x64 当前约 205MiB 原始；Tauri 文档口径安装包增量约 +127MB，需用最终 NSIS 实测确认）。
3. **不默认 Fixed Version**：仅对"必须锁 Runtime / 无法依赖 Evergreen"的受管/离线渠道单独评估；若保留该渠道，必须定义 Runtime 安全更新 SLA（谁在多长时间内跟版）。
4. **`minimumWebview2Version`**：按功能所需的 WebView2 API（自定义协议、PrintToPdfStream、ScreenCaptureStarting 等）冻结一个最低 Runtime 版本；安装器版本不足时触发更新，运行时再做能力检测，**不得只依赖安装器检查**。
5. **启动检测与失败 UX**：读 HKLM/HKCU `pv` 或 `GetAvailableCoreWebView2BrowserVersionString`；缺失/过旧时显示可操作错误（含下载链接/离线安装说明），不能白屏或静默退出。
6. **portable 版**：没有安装器阶段，**无法在安装时补 Runtime**；需要明确"portable 要求系统已装 WebView2"或提供启动检测/引导（若产品要求便携版也可离线自足，则必须评估 Fixed Version，成本见 §4.3）。
7. **卸载/升级**：卸载只移除本应用依赖，不删除其他 Evergreen 应用共享的 Runtime；升级/回退时记录 Runtime 版本，避免"升级后运行时变化导致回退不可用"。
8. **诊断与证据**：支持包/日志记录 WebView2 版本与安装模式（不含用户内容）；发布证据 JSON 建议加 `webview2Version`/`webviewInstallMode`（R8-04 评估）。

### 7.2 体积/网络 trade-off（供 R8-02 决策）

| 模式 | 需要网络 | 安装包增量（Tauri 文档口径） | 本机 HEAD 观测（原始载荷） | 适用 |
|---|---|---|---|---|
| `downloadBootstrapper`（默认） | 是 | 0MB | Bootstrapper 1,897,688 B | 大多数在线用户 |
| `embedBootstrapper` | 是 | 约 +1.8MB | 同上（内嵌引导器） | 需要离线获取引导器但安装时可联网 |
| `offlineInstaller` | 否 | 约 +127MB | Standalone x64 214,990,032 B（约 205MiB） | 离线/企业/无法联网 |
| `fixedVersion` | 否 | 约 +180MB | 未测（cab 路径需 R8-02 验证） | 必须锁版本/受管/air-gapped |
| `skip` | 否 | 0MB | — | **不推荐**：应用在无 Runtime 时无法工作且不尝试安装 |

> 说明：Tauri 的增量是 NSIS/LZMA 压缩后的经验值；Standalone 原始体积与最终安装包增量不同，R8-02 必须以实际构建的 NSIS 产物测量体积与安装时间。

### 7.3 R8-02 验收要点（与计划 §7 R8-02 对齐）

- 制品：NSIS（在线默认）+ 离线制品 + portable；签名/Authenticode 与 SHA-256 齐全；未签名候选包标 `NotSigned`。
- 环境：**至少一台干净 Win10 22H2 无 Runtime + 一台 Win11 无 Runtime + 一台离线机**（不能只测本机已装 Runtime）。
- 行为：缺 Runtime 时安装成功但启动要有明确错误或引导；离线制品安装后能启动；旧 Runtime 触发 `minimumWebview2Version`；卸载不影响共享 Runtime。
- 证据：安装日志/退出码/Runtime 版本/安装模式/体积/时间；写入发布证据与 G0 报告。

## 8. 对 README / 发布文档的输入（需产品批准；本轮未改）

> 计划 §1 要求"不能未经兼容决策默默提高 README 中的系统要求"。下面只是**建议文案草案**，在候选 A 被产品批准前不得改 README。

| 位置 | 当前 | 建议（候选 A 获批后） |
|---|---|---|
| [README.md:145-146](../../../README.md#L145-L146) | "Windows 10 或 Windows 11"、"x64 处理器" | "Windows 10 22H2（build 19045）或更新版本 / Windows 11；x64 处理器"（或等价表述：Windows 10 22H2 及以上） |
| [README.md:148](../../../README.md#L148) | "OCR 模型、Electron 运行时和所需原生组件会随正式安装包一起提供。" | 改为："OCR 模型与所需原生组件随安装包提供；界面渲染依赖系统的 Microsoft Edge WebView2 Runtime（Windows 11 与已更新的 Windows 10 通常已预装；安装包会在缺失时引导安装，离线环境请使用离线安装包）" |
| [README.md:152](../../../README.md#L152) | "Windows 10 或 Windows 11 x64" | 开发机要求与运行要求分开：开发 = Windows 10 22H2/11 x64 + Rust 工具链；运行 = 最低系统 + WebView2 |
| [HARDWARE_ACCEPTANCE.md:52-55](../../releases/HARDWARE_ACCEPTANCE.md#L52-L55) | 要求 Win10 22H2 | 候选 A 下保留；若候选 B 则删除/替换，并同步验收流程与 `config/release-hardware-matrix.json` |
| 发布说明/支持文档 | 无 WebView2 说明 | 增加"WebView2 缺失/过旧/离线"的排障说明（与 §7 一致）；安装包类型与离线制品区分 |

**决策建议**：

- 若产品接受候选 A：README 的措辞变化是"明确 build 下限（收紧）"，需要在变更说明中写清"**不支持 Windows 10 1709–21H2**"（相对旧文案的缩减），避免用户误解。
- 若产品选择候选 B：README、矩阵、验收文档、发布说明必须**同一批**修改（见 C3），并给 Win10 用户明确的升级/支持期限说明。
- 无论 A/B，`README.md:148` 的"Electron 运行时随包"句在 Rust 正式替代版必须改，不能保留（属 R8 文档收口，不在本任务）。

## 9. 未解决限制

1. **没有任何真实测试机证据**：Win10 22H2、无 Runtime、离线、旧 Runtime、portable、per-user 安装全部未验证；本机只是 Win11 + WebView2 157 单点。
2. **Win10 用户占比/升级意愿未知**：没有遥测或发行数据；无法量化候选 B 的用户影响，也无法证明候选 A 的"继续支持"价值。
3. **Windows 10 消费级 ESU 条款未在本轮官方页面确认**：ESU FAQ 表格覆盖的是商业版（Enterprise/Education/Pro in Commercial use）；消费级 ESU 的结束日期另有官方页面，本轮未核实，报告不引用。
4. **Win11 "当前稳定版"口径未冻结**：本机为 26H2/build 26300.9974；发布矩阵只写 `windows-11-current-full-smoke`，未定义具体 version/build 与更新窗口。
5. **WebView2 稳定版发布说明未审阅**：无法承诺"某版本起无回归"；官方建议用 Edge preview 通道做前瞻兼容测试，本仓库尚未建立该流程。
6. **Fixed Version 的 cab 体积/版本未实测**：只引用 Tauri ~180MB 与 WinUI3 ~100–250MB 口径；固定版本的安全更新 SLA、下载源、签名验证未设计。
7. **Tauri portable 打包方案未定**：Tauri 文档只覆盖 NSIS/MSI；便携版是否继续支持、如何定位数据根/更新通道、如何处理 WebView2 依赖，属 R8-02 未决。
8. **Runtime 检测与错误 UX 未实现**：`minimumWebview2Version` 只是安装器配置；运行时能力检测/白屏防护尚未设计（R8-02/R1）。
9. **发布证据 schema 未包含 WebView2 字段**：`config/release-hardware-matrix.json` 与 `scripts/verify-hardware-matrix.js` 当前没有 webview2Version/webviewInstallMode；R8-04 需评估。
10. **WGC/Win10 build 的联动**：ADR-0001 候选 C 依赖 WGC（最低 1903），与候选 A（22H2）一致；若未来下调最低系统，需要重开媒体 ADR。

## 10. 责任批次与退出验收

| 事项 | 责任批次 | 退出验收 |
|---|---|---|
| 本 ADR 调研/候选（本文件 + ADR-0007） | R0-07 | 官方事实齐全且有 URL/抓取日期；候选/失败分支/未解决限制登记；明确"未冻结" |
| 真实测试机矩阵执行（§6） | R0-07（G0 前） | W10-1/2/3/4、W11-1/2/3/4、U-1/2、P-1、R-1 有真实证据；本机不能替代；结果回写 G0 报告 |
| 最低系统/README 兼容决策 | 产品（G0/G4 前） | 产品书面批准 A 或 B；README/支持文档/发布矩阵同批修改；变更说明写清与旧文案的差异 |
| R8-02 安装策略 | R8-02 | 在线 NSIS + 离线制品 + portable 策略冻结；WebView2 检测/`minimumWebview2Version`/失败 UX 实现；干净 Win10 22H2 无 Runtime + Win11 无 Runtime + 离线机实测通过 |
| 发布矩阵/验收更新 | R8-04 / G4 | `config/release-hardware-matrix.json`、`HARDWARE_ACCEPTANCE.md`、证据 schema 与最终支持口径一致；Win10 22H2 真机证据补齐 |
| WebView2 更新回归流程 | R8-04 之后 | 固定周期用 Edge preview 通道做前瞻兼容测试；回归有记录 |

**回退方式**：本 ADR 只改变文档/决策记录，不改变产品行为；若产品否决候选 A，可改选 B（按 C3 同批改矩阵与文档）或 C（单独评审）；任何 README/矩阵修改必须可回退并保留变更说明。

## 11. 证据与复现

### 11.1 证据文件（`.tmp-r07/runtime-researcher/`，gitignore）

| 文件 | 内容 | SHA-256 |
|---|---|---|
| `local-facts.txt`（1,399 B） | 本机 OS/CPU/RAM/磁盘/显示/WebView2/工具链/git 实测输出（2026-11-11 13:01 HKT） | `cd55446e9f90fe28b0445065497540f85ef9f8dae40c5a014ebc0390cd047286` |
| `official-sources.md`（11,299 B） | 官方来源摘录（Electron/Tauri/WebView2/Windows 生命周期/WGC），含 URL 与抓取日期 | `1fcfd736d7b769eee71b8e8b0970b8d5b3af0121bbf4934fa0a773e1a27e898f` |
| `webview2-installer-head.txt`（1,965 B） | Bootstrapper/Standalone HEAD 观测（Content-Length/final URL/Last-Modified） | `964776aabf1d540fe9fa67d57f474281d4563547133a16d8103a65e8a8166fe4` |

### 11.2 关键复现命令

```powershell
# 本机 OS / WebView2 / 显示
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber
Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' | Select-Object name,pv

# 官方安装器体积（只取响应头）
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -Method Head -MaximumRedirection 10 -UseBasicParsing
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/?linkid=2124701' -Method Head -MaximumRedirection 10 -UseBasicParsing
```

### 11.3 证据文件哈希复算

```powershell
Get-ChildItem -LiteralPath '.tmp-r07/runtime-researcher' -File |
  Sort-Object Name |
  ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower() + '  ' + $_.Name }
```

## 12. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-11 | 初稿：官方事实核查（Electron 43 / Tauri 2 / WebView2 Evergreen+Fixed / Win10 EOL+WebView2 至 2028-10）、仓库现状核对、候选 A/B/C/D、建议候选 A+D（未冻结）、真机矩阵计划、R8-02 与 README 输入、未解决限制 | 本文件 §2、§11；`.tmp-r07/runtime-researcher/`（哈希见 §11.1） |


