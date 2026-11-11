# ADR-0007：最低 Windows / WebView2 Runtime 下限

- 状态：**候选 / 待验证（G0 未通过，未冻结）**
- 决定批次：R0-07；实施批次：R8-02、R8-04
- 日期：2026-11-11
- 关联计划：§1（最低系统/Runtime 在 R0 后冻结、不得默默提高 README 要求）、§7 R0-07 与 R8-02、§8 G0（版本矩阵）
- 证据文档：[r0-minimum-windows-runtime.md](../r0-minimum-windows-runtime.md)（调研全文与真机矩阵计划）、[r0-baseline.md §4.3](../r0-baseline.md)、[r0-g0-report.md](../r0-g0-report.md)
- 关联仓库事实：[README.md](../../../../README.md#L145-L148)、[config/release-hardware-matrix.json](../../../../config/release-hardware-matrix.json)、[docs/releases/HARDWARE_ACCEPTANCE.md](../../../releases/HARDWARE_ACCEPTANCE.md)
- 证据文件：`.tmp-r07/runtime-researcher/`（gitignore；哈希见 §3.4）

## 1. 背景与问题

Rust 迁移目标是用 Tauri 2 + 系统 WebView2 取代 Electron 自带 Chromium。迁移后：

1. **产品自带浏览器内核的形态改变**：Electron 43 自带 Chromium 150（官方 README："Windows (Windows 10 and up)"）；Tauri 版**不带浏览器**，渲染依赖目标机系统的 Microsoft Edge WebView2 Runtime。
2. **Windows 10 已 EOL**：Windows 10 22H2 是最后一个版本，OS 支持于 2025-10-14 结束；但 Microsoft 仍承诺 Edge/WebView2 在 Win10 22H2 上更新到**至少 2028-10**（与 ESU 结束一致，且不要求购买 ESU）。
3. **产品当前声明过宽且未决策**：README 只写"Windows 10 或 Windows 11"（无 build/edition）；发布硬件矩阵却已硬性要求 `windows-10-22h2-nsis-lifecycle`；计划 §1 明确"不能未经兼容决策默默提高 README 中的系统要求"。
4. **G0 缺版本矩阵**：计划 §8 G0 要求"版本矩阵（Windows/WebView2 有/无/离线）"；G0 报告登记 R0-07 **未做**。

本 ADR 要决定（候选）：**产品最低支持的 Windows 版本、WebView2 Runtime 分发模式，以及它对安装策略/README 的要求**。失败会影响 R8-02（NSIS/portable 制品、WebView2 离线/在线策略）与 G0/G4 放行。

## 2. 备选方案

| 方案 | 描述 | 优点 | 代价/风险 |
|---|---|---|---|
| **A** | 维持 **Windows 10 22H2 x64 + Windows 11 x64**；WebView2 **Evergreen**（NSIS 默认 `downloadBootstrapper`，另发离线 Standalone 制品） | 保留 Win10 22H2 用户；安全更新跟随 Edge（官方支持到至少 2028-10）；默认安装包体积最小；与现有发布矩阵冲突最小 | 需真实 Win10 矩阵；需 Runtime 检测/错误 UX；在线安装依赖网络；显式承认"支持已过 OS 支持期的系统" |
| **B** | 提升到 **Windows 11**（当前受支持版本）x64 + Evergreen | OS/Runtime 均有明确支持窗口；测试矩阵更小；不再支持已 EOL 的 Win10 | 放弃 Win10 用户（占比未知）；必须同批修改 README、发布矩阵、`HARDWARE_ACCEPTANCE.md`、证据 schema；Win11 硬件门槛（TPM 2.0/Secure Boot/4GB/64GB）排除部分旧机 |
| **C** | 维持 Win10 22H2 + Win11，但**内置 Fixed Version WebView2**（Tauri `fixedRuntime`，cab 解压随包） | 渲染版本可锁定、可离线、不受系统 Evergreen 策略影响 | 安装包约 +180MB 级；**更新责任转到产品**（不自动更新、不能用安装器安装、必须定期跟版）；自带旧 Chromium 的安全风险；不解决 Win10 EOL |
| **D** | 系统下限同 A；**分渠道**：默认在线 Evergreen，离线/受管环境另发离线制品，Fixed Version 仅作应急渠道（默认不发） | 兼顾安全更新与离线可用性；不把 +180MB 强加给所有用户；与 R8-02"WebView2 离线/在线策略"直接对齐 | 多制品维护/签名/更新说明；需要定义 Fixed Version 渠道的触发条件与安全更新 SLA（若保留） |

对比与成本明细见 [调研报告 §4](../r0-minimum-windows-runtime.md#4-候选选项)。

## 3. 实测条件与命令

### 3.1 本机环境（2026-11-11，单点事实，不是矩阵结论）

- Host **SHERUNLOCK02**；OS **Microsoft Windows 11 家庭版 中文版 10.0.26300**，Build **26300**，UBR **9974**（DisplayVersion 26H2）；CPU Intel i5-13500H 12C/16T；RAM 约 **15.74 GiB**；仓库在 D:。
- 显示：**1 块屏**，DPI 144（150%）；无副屏。
- WebView2 Runtime：**157.0.4341.46**，**per-machine（HKLM）已安装**；HKCU 键不存在（无 per-user 安装）。
- 工具链：node v24.15.0 / npm 11.17.0 / rustc 1.97.1 / cargo 1.97.1；仓库内 electron 43.8.3。
- 采集命令与输出：`.tmp-r07/runtime-researcher/local-facts.txt`。

> 注意：handoff/r0-baseline 记录的是**另一台机器**（Ryzen 7 9850X3D、47.2 GiB、F: 仓库、WebView2 157.0.4341.42）。用户已确认以当前机器为准；本 ADR 只引用 2026-11-11 在本机测得的值，旧值不作同机数据混用。

### 3.2 官方资料（抓取日期 2026-11-11）

| 主题 | 来源 URL |
|---|---|
| Electron 平台支持 | https://github.com/electron/electron#platform-support |
| Electron 23 移除 Win7/8/8.1 | https://www.electronjs.org/docs/latest/breaking-changes |
| Electron 支持策略/节奏 | https://www.electronjs.org/docs/latest/tutorial/electron-timelines |
| Electron 43（Chromium 150）/ 45（最新稳定） | https://www.electronjs.org/blog/electron-43-0 、https://www.electronjs.org/blog/electron-45-0 |
| Tauri 2 前提（WebView2） | https://v2.tauri.app/start/prerequisites/ |
| Tauri WebView2 支持面 | https://v2.tauri.app/reference/webview-versions/ |
| Tauri Windows 安装器/WebView2 安装模式 | https://v2.tauri.app/distribute/windows-installer/ |
| Tauri 配置（webviewInstallMode/minimumWebview2Version） | https://v2.tauri.app/reference/config/ |
| Edge/WebView2 支持的 OS（Win10 22H2 更新至至少 2028-10） | https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems |
| WebView2 分发（Bootstrapper/Standalone/Evergreen） | https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution |
| Evergreen vs Fixed Version | https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version |
| WebView2 开发最佳实践（Evergreen 推荐） | https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/developer-guide |
| WebView2 企业分发/生命周期 | https://learn.microsoft.com/en-us/deployedge/webview2-enterprise |
| WebView2 预装面与缺失风险 | https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/webview2 |
| Windows 10 生命周期（2025-10-14 EOL） | https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro |
| Windows 10 ESU 时间表 | https://learn.microsoft.com/en-us/lifecycle/faq/extended-security-updates |
| Windows 11 硬件要求 | https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements |
| WGC 最低 Win10 1903 | https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createformonitor |

原文摘录见 `.tmp-r07/runtime-researcher/official-sources.md`。

### 3.3 本机安装器体积观测（HEAD，不下载/不安装；2026-11-11 13:03 HKT）

```powershell
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -Method Head -MaximumRedirection 10 -UseBasicParsing
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/?linkid=2124701' -Method Head -MaximumRedirection 10 -UseBasicParsing
```

- Bootstrapper：`MicrosoftEdgeWebview2Setup.exe`，**1,897,688 B（约 1.8 MiB）**。
- Standalone x64：`MicrosoftEdgeWebView2RuntimeInstallerX64.exe`，**214,990,032 B（约 205 MiB）**。
- 异常：`linkid=2124700` 当日解析为 `MicrosoftWebView2Runtime_158.0.4370.16_Beta.msix`（398,355,619 B），**不作为** Bootstrapper 体积证据。

### 3.4 证据文件与哈希

| 文件（`.tmp-r07/runtime-researcher/`） | 内容 | SHA-256 |
|---|---|---|
| `local-facts.txt` | 本机环境实测输出 | `cd55446e9f90fe28b0445065497540f85ef9f8dae40c5a014ebc0390cd047286` |
| `official-sources.md` | 官方来源摘录 | `1fcfd736d7b769eee71b8e8b0970b8d5b3af0121bbf4934fa0a773e1a27e898f` |
| `webview2-installer-head.txt` | 安装器 HEAD 观测 | `964776aabf1d540fe9fa67d57f474281d4563547133a16d8103a65e8a8166fe4` |

### 3.5 数据/样本声明

- 全部为公开官方文档与合成/空环境观测；**不含真实用户数据、凭据或机器标识**。
- **未执行任何安装、卸载或 Runtime 变更**；未在真实 Win10 机器、干净系统、离线环境或旧版 Runtime 上测试。
- 未构建 Tauri NSIS/portable 制品（R8-02 未开始）；本 ADR 提到的体积均为官方文档口径或本机 HEAD 观测，不是最终产物实测。

## 4. 证据

| # | 验证项 | 命令/来源 | 结果 | 判定 |
|---|---|---|---|---|
| 1 | Electron 平台下限 | Electron README#platform-support | "Windows (Windows 10 and up)"；x64/arm64 | **已核实（官方）** |
| 2 | Electron 放弃 Win7/8/8.1 | Electron breaking-changes | "Windows 10 or later will be required to run Electron v23.0.0 and higher." | **已核实（官方）** |
| 3 | 当前产品 Electron 内核 | Electron 43 博客 | Chromium 150.0.7871.46 / Node v24.17.0 | **已核实（官方）** |
| 4 | Electron 支持窗口 | Electron timelines + 45 博客 | 官方支持最新 3 个稳定大版本；抓取时最新稳定为 45 → 受支持线 45/44/43，43 即将 EOL | **已核实（官方）**；不改变 OS 下限事实 |
| 5 | Tauri 2 Windows 前提 | Tauri prerequisites | Windows 需要 MSVC Build Tools + WebView2；平台列表仍写 "Windows 7 and later" | **已核实（官方）**；"Win7+"不能作为产品下限（见 #7） |
| 6 | Tauri WebView2 安装模式与体积 | Tauri windows-installer | downloadBootstrapper 0MB（默认）/ embedBootstrapper ~1.8MB / offlineInstaller ~127MB / fixedVersion ~180MB / skip 0MB（不推荐） | **已核实（官方文档口径）**；增量需 R8-02 实测 |
| 7 | WebView2 支持的 Windows 版本 | Edge supported OS 页（2026-08-31 更新） | Win10 SAC 1709+ / Win11；**Win10 22H2 上 Edge/WebView2 至少更新到 2028-10，不要求 ESU**；更旧 Win10 不在支持期，Edge 支持仅为"临时桥" | **已核实（官方）** |
| 8 | Edge 已不支持 Win7/8.1 | 同上 recent changes | Win7/8/8.1 支持在 Edge 109 结束 | **已核实（官方）**；用于否定 Tauri 的"Win7+"可作为产品承诺 |
| 9 | Windows 10 生命周期 | Windows 10 lifecycle 页 | 2025-10-14 结束支持；22H2 为最后版本 | **已核实（官方）** |
| 10 | Windows 10 ESU 时间表 | Lifecycle FAQ ESU | ESU 至 2026-10-13 / 2027-10-12 / 2028-10-10；商业版资格（Enterprise/Education/Pro in Commercial use） | **已核实（官方，商业版口径）**；消费级条款未核实 |
| 11 | WebView2 预装面 | WinUI3 WebView2 文档 | Win11 预装；Win10 1803+（带 2022-11 更新）通常预装；**干净 Win10/Server/LTSC 可能缺失**；要求启动时检查 | **已核实（官方）** |
| 12 | Evergreen 行为 | WebView2 distribution / developer-guide | 自动更新、共享、不可锁版本；运行中 App 需释放对象/重启才采用新版本；可用 NewBrowserVersionAvailable 提示 | **已核实（官方）** |
| 13 | Fixed Version 行为 | evergreen-vs-fixed-version | 不自动更新；需自行更新应用+Runtime；不能用安装器安装 | **已核实（官方）** |
| 14 | Bootstrapper / Standalone 体积 | 本机 HEAD（§3.3） | 1,897,688 B / 214,990,032 B | **已核实（本机 HEAD，2026-11-11）** |
| 15 | Fixed Version 体积 | Tauri 文档 / WinUI3 文档 | Tauri 安装包增量约 +180MB；WinUI3 磁盘约 100–250MB | **已核实（官方文档口径）**；未实测 |
| 16 | 本机 WebView2 与 OS | 注册表 / Win32_OperatingSystem | Win11 26300.9974；WebView2 157.0.4341.46 per-machine，HKCU 缺失；单屏 150% | **已核实（本机单点）** |
| 17 | 仓库当前声明 | README / matrix / HARDWARE_ACCEPTANCE | README 写"Windows 10 或 Windows 11"（无 build）；矩阵硬性要求 Win10 22H2；验收文档要求真机证据 | **已核实（仓库）** |
| 18 | Win10 22H2 真机安装/升级/卸载 | — | 未执行 | **未验证（需真实测试机）** |
| 19 | 无 WebView2 的安装与启动 | — | 未执行 | **未验证（需干净 VM/真机）** |
| 20 | 离线安装（无网络） | — | 未执行 | **未验证（需离线环境）** |
| 21 | 旧版 Runtime / minimumWebview2Version | — | 未执行 | **未验证（需固定旧 Runtime 环境）** |
| 22 | portable 无 Runtime 行为 | — | 未执行 | **未验证（需干净 VM + portable 制品）** |
| 23 | Fixed Version 打包/更新/SLA | — | 未执行 | **未验证（R8-02）** |
| 24 | Win11 安装/升级烟测（本机可做部分） | — | 本轮未构建/安装任何制品 | **未验证（本轮未做）** |

**失败分支/负样本记录**：

- `linkid=2124700` 解析为 Beta MSIX，不能当 Bootstrapper——已从体积证据中剔除（防误用）。
- Tauri 文档仍写 Windows 7+，但 Edge 已在 109 结束对 Win7/8.1 的支持——**不能**把 Tauri 文档当作产品可承诺下限。
- Electron README 只写 "Windows 10 and up"，未细分 Win10 build 与 EOL 后支持——不能据此承诺任意 Win10 版本。
- 本机无 Win10/无 Runtime/离线/旧版环境，所有相关项保持"未验证"。

## 5. 结论（建议）

**建议候选 A + D（安装策略）**：最低 **Windows 10 22H2 x64 或 Windows 11 x64**；WebView2 **Evergreen 为默认**（NSIS 默认 `downloadBootstrapper`；安装/启动时检测 Runtime，缺失时给出可操作错误或引导安装）；**离线场景另发 Evergreen Standalone 离线制品/说明**；**Fixed Version 不作为默认**，仅在"必须锁定 Runtime / 无法依赖系统 Evergreen"的受管/离线渠道单独评审。README 的"Windows 10"需在**产品书面批准**后收紧为"Windows 10 22H2 或更新（含 Windows 11）"，并写清不支持 Win10 1709–21H2；本轮不改 README。

**理由**：

1. 技术事实支持 **Win10 22H2 继续可用**：WebView2/Edge 在 Win10 22H2 上至少更新到 2028-10；Tauri 2 不另设更高下限；现有发布矩阵也以 Win10 22H2 为硬性 claim，选 A 的矩阵新增成本最小。
2. **B 不是技术必需**：Win10 22H2 的 OS EOL 是产品支持口径问题，不是 Tauri/WebView2 无法运行；没有 Win10 用户占比数据前，不应单方面放弃。
3. **C 只在特定场景成立**：Fixed Version 把安全更新责任转到产品自身，体积大，且不解决 Win10 EOL；官方也推荐 Evergreen 为默认。
4. **D 是 A 的必要安装补充**：R8-02 验收明确要求"不只验证本机已安装 Runtime 的情况"，离线/干净环境必须有制品与验证。

**置信度**：

- 技术事实：**高**（官方来源 + 可复核 HEAD）。
- 产品决策：**中低**（无 Win10 用户占比/支持成本数据）。
- 工程可行性：**中**（Runtime 检测/离线/portable 未实现，R8-02 未开始）。

**依赖的未验证前提**：Win10 22H2 真机安装/升级/卸载可接受；无 Runtime 的干净机器可被正确处理；离线制品可用；旧版/策略冻结 Runtime 有可诊断路径；产品批准"支持已过 OS 支持期的 Win10 22H2"；portable 的 Runtime 缺失方案可接受。

**状态**：本结论是**候选，未冻结**；G0 通过（含版本矩阵与产品书面决策）前不构成冻结，不得把"未验证"写成"已通过"。

## 6. 未解决限制

1. **无任何真实测试机证据**：Win10 22H2、无 Runtime、离线、旧 Runtime、portable、per-user 全部未验证；本机只是 Win11 + WebView2 157 单点。
2. **Win10 用户占比/升级意愿未知**；无法量化候选 B 的影响。
3. **Windows 10 消费级 ESU 条款未核实**（本轮只核实了商业版 ESU 时间表）。
4. **Win11 "当前稳定版"口径未冻结**（本机 26H2；发布矩阵未定义具体 version/build）。
5. **WebView2 稳定版发布说明未审阅**；前瞻兼容测试流程未建立。
6. **Fixed Version cab 体积/版本/更新 SLA 未验证**。
7. **Tauri portable 方案未定**（Tauri 文档只覆盖 NSIS/MSI 安装器）。
8. **Runtime 检测/错误 UX 未实现**（minimumWebview2Version 仅为安装器配置）。
9. **发布证据 schema 未含 webview2Version / webviewInstallMode**（R8-04 需评估）。
10. **WGC 依赖 Win10 1903**（ADR-0001 候选 C）：与 Win10 22H2 下限一致；若未来降低下限需重开媒体 ADR。

## 7. 责任批次与退出验收

| 事项 | 批次 | 退出验收 |
|---|---|---|
| 本 ADR 调研/候选 | R0-07 | 官方事实带 URL/抓取日期；A/B/C/D、失败分支、未解决限制登记；明确"未冻结" |
| 真实测试机矩阵（见调研报告 §6） | R0-07（G0 前） | W10-1/2/3/4、W11-1/2/3/4、U-1/2、P-1、R-1 有真实证据；本机不可替代；结果回写 G0 报告 |
| 最低系统/README 兼容决策 | 产品（G0/G4 前） | 书面批准 A 或 B；README/支持文档/发布矩阵同批修改；变更说明写清与旧文案差异 |
| R8-02 安装策略 | R8-02 | 在线 NSIS + 离线制品 + portable 策略冻结；Runtime 检测/minimumWebview2Version/失败 UX 实现；干净 Win10 22H2 无 Runtime + Win11 无 Runtime + 离线机实测通过 |
| 发布矩阵/验收更新 | R8-04 / G4 | config/release-hardware-matrix.json、HARDWARE_ACCEPTANCE.md、证据 schema 与最终支持口径一致；Win10 22H2 真机证据补齐 |
| WebView2 更新回归流程 | R8-04 之后 | 固定周期用 Edge preview 通道做前瞻兼容测试；回归有记录 |

**回退方式**：本 ADR 只改文档/决策记录，不改产品行为。若产品否决 A，可改选 B（同批改 README/矩阵/验收）或 C（单独评审）；README/矩阵修改必须可回退并保留变更说明。G0 前如出现 "Win10 22H2 无法安装/启动" 或 "WebView2 在 Win10 22H2 上停止支持" 的新证据，应重启本决策，不得沿用本候选。

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-11 | 初稿（候选）：官方事实核查与仓库现状核对；备选 A/B/C/D；建议候选 A+D（Evergreen 默认 + 离线制品 + Fixed Version 仅特定渠道）；真机矩阵计划与 R8-02/README 输入；全部真机验证标记"未验证" | [r0-minimum-windows-runtime.md](../r0-minimum-windows-runtime.md)；`.tmp-r07/runtime-researcher/`（哈希见 §3.4） |

