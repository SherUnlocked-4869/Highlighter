# R0-07 安装/分发矩阵（NSIS 测试包 + WebView2 模式）

日期：2026-11-11（Asia/Hong_Kong）。分支 `codex/rust-r0-baseline-contracts`，基线 HEAD `7c45a7b`（本文件写作时工作区另有 R0-07 打包配置、driver-spike 测试开关等未提交改动，由 Lead 统一提交）。
状态：**R0 证据文档（手动交互安装→启动→卸载链路已实测通过；自动静默安装“不落盘”根因已定位，环境修复后已复验通过；其余未验证项见 §10）**。上位文档：
[Rust 改造方案与开发计划](../2026-11-10-rust-migration-development-plan.md) §7 R0-07、§8 G0 版本矩阵、§9.2；
[R0-03 窗口原型](r0-window-prototype.md)；[R0 G0 报告（草案）](r0-g0-report.md)；[rust-app/README.md](../../../rust-app/README.md)。

**门禁声明：本文件不构成任何 gate 已通过的证据。G0 未通过；文档中的“未验证/阻塞”项不得改写成“通过”。**
所有产物均为**未签名候选测试包**（`Get-AuthenticodeSignature` = `NotSigned`），不得作为发布件。

## 1. 目的与边界

本任务（R0-07）只回答四件事：

1. R0-03 Tauri 2 原型能否产出可安装的 **NSIS 测试包**（`bundle.active=true`、`targets=["nsis"]`）；
2. **WebView2 分发模式**在本机的真实体积/内嵌物/网络依赖差异（downloadBootstrapper / embedBootstrapper / offlineInstaller / fixedRuntime / skip）；
3. **安装→启动→卸载**链路的真实行为（per-user、`/S` 静默，不做管理员提权）；
4. **缺失 WebView2 Runtime** 时应用/加载器的失败表现，以及对产品启动自检与安装引导的要求。

明确边界（计划 §8）：

- 只改 `rust-app/src-tauri/tauri.conf.json` 的打包配置（打开 bundle、指定 nsis、记录 WebView2 模式），并新增本文档与 `rust-app/README.md` 的 R0-07 测试包命令；**不改产品入口**、`main/`、`preload*.js`、`shared/`、`native/*`、`package.json`/`package-lock.json`、现有 Electron 构建与 CI。
- `bundle.active=true` **只服务 R0-07 测试包**，不代表产品构建入口迁移；原型仍用 `cargo run` 启动。
- 不提交 git（Lead 负责）；证据与临时产物放 `.tmp-r07/install/`（`.tmp*` 已 gitignore）。
- 不卸载/修改系统 WebView2 Runtime；不做管理员提权安装。

原型自身的已知限制（影响本矩阵的解释，见 §10）：R0-03 原型的 WebView2 用户数据目录在**编译期**固定为构建机路径
（`src-tauri/src/overlay.rs` 的 `env!("CARGO_MANIFEST_DIR")` → `rust-app/target/r0-window-webview2-data`），
安装包在**其它机器**上运行可能无法创建 WebView；R1 必须改成 per-user 数据根。本机安装烟测受此影响有限（路径存在）。

## 2. 环境（本机实测，2026-11-11）

> 与 [handoff.md](handoff.md) §8 历史快照中的旧机器（Ryzen 7 9850X3D / 47 GiB / 双屏 / F:）**不同**；本矩阵一律以当前机器为准（用户已确认）。

| 项 | 实测值 | 获取方式 |
|---|---|---|
| 主机 | `SHERUNLOCK02`，HONOR `FRI-GXXX` | `Win32_ComputerSystem` |
| OS | Microsoft Windows 11 家庭版 中文版，`10.0.26300`，Build `26300`，UBR `9974`（`DisplayVersion=26H2`；`ProductName` 仍是 `Windows 10 Home China` 兼容串） | `Win32_OperatingSystem` + `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` |
| CPU / RAM | 13th Gen Intel Core i5-13500H，12C/16T，2600 MHz；RAM 16,907,100,160 B（约 15.75 GiB） | `Win32_Processor` / `Win32_OperatingSystem` |
| GPU / 显示 | Intel Iris Xe（驱动 31.0.101.4032）；**单块活动显示器** `\\.\DISPLAY1` 2240×1400 @150%（逻辑 1493×933）；无副屏 | `Win32_VideoController` / `System.Windows.Forms.Screen` |
| 电源方案 | 平衡（`381b4222-f694-41f0-9685-ff5bb260df2e`），未固定 | `powercfg /getactivescheme` |
| 磁盘 | D: 开始前剩余约 198.4 GB | `Get-PSDrive` |
| WebView2 Runtime | `Microsoft Edge WebView2 Runtime`，`pv=157.0.4341.46`，位置 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application`（目录 `157.0.4341.42`、`157.0.4341.46`） | `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` |
| Rust | rustc/cargo `1.97.1`（`rust-app/rust-toolchain.toml` 固定；`tauri info` 显示 1.97.1-x86_64-pc-windows-msvc） | `rustc --version` / `cargo --version` |
| Node / npm | `24.15.0` / `11.17.0`（npm registry 为 `https://registry.npmmirror.com`） | `node --version` / `npm --version` / `npm config get registry` |
| Tauri CLI | `tauri-cli 2.12.4`（`npx --yes @tauri-apps/cli@2 --version`；下载到 npm 缓存，未写入仓库） | 命令输出 |
| NSIS 工具链 | **v3.13**，由 tauri-bundler 首次打包时从 GitHub 下载到 `%LOCALAPPDATA%\tauri\NSIS`；`nsis_tauri_utils` v0.5.3 | bundle 日志 + `makensis.exe /VERSION` |
| 本地 NSIS（对照，未使用） | `D:\tools\nsis\makensis.exe` 也是 v3.13；本矩阵未用它绕过 bundler | `makensis /VERSION` |

> **环境事实（2026-11-11 17:40 新增、19:4x 已修复，静默安装根因相关）**：`D:\workspace\Highlighter` 根目录曾带有
> DSH workspace-write 沙箱遗留的**强制完整性标签 `Low Mandatory Level:(OI)(CI)(NW)`**（另有
> `Everyone:(CI)(DENY)(DC)` 与能力 SID `S-1-4-1070570333-856284178:(OI)(CI)(W,D,DC)`）。标签继承到整个
> 工作区子树，工作区内所有 exe（含本任务安装包）创建进程时被 Windows 封顶为 Low IL，无法写入
> `%LOCALAPPDATA%`/`%TEMP%`/HKCU 等 Medium 位置——这是 §6.2 静默安装“不落盘”的根因，**不是**登录会话、
> 计划任务、作业对象或 UAC/Defender 问题。**2026-11-11 19:4x Lead 已执行修复**（全树 Low→Medium、移除
> DENY/能力 SID ACE），修复后工作区 exe 均为 Medium，§6.2 已用工作区原件复跑成功。

Cargo.lock（`rust-app/Cargo.lock`，未改动）中与本矩阵相关的版本：

| crate | 版本 |
|---|---|
| tauri | 2.12.5 |
| tauri-build | 2.7.4 |
| tauri-runtime | 2.12.2 |
| tauri-runtime-wry | 2.12.3 |
| wry | 0.57.2 |
| webview2-com / webview2-com-sys | 0.39.1 / 0.39.1 |
| tao | 0.37.2 |
| windows / windows-core | 0.62.2 / 0.62.2 |

> **Tauri CLI 会自动改写 Cargo.toml（已复现，非手工修改）**：CLI 2.12.4 在 `build`/`bundle` 时会把
> `tauri = { version = "2" }` 写成 `tauri = { version = "2", features = [] }`。实测：还原文件后重跑同一条命令，
> mtime 与同一行 diff 立即复现；构建/打包不受影响（`features = []` 未关闭 default features，release exe sha256 不变）。
> 另：**必须在 `rust-app/` 下执行 Tauri CLI**；在仓库根执行时 CLI 会把 `rust-app/prototypes/webview-media`
> 误当 Tauri 项目并改写其 Cargo.toml（该文件已按 Lead 要求还原）。

## 3. 打包配置与命令

`rust-app/src-tauri/tauri.conf.json` 的 bundle 段（本次唯一功能性改动）：

```json
"bundle": {
  "active": true,
  "targets": ["nsis"],
  "icon": ["icons/icon.ico"],
  "publisher": "Highlighter R0 (test build, not for release)",
  "shortDescription": "R0-07 NSIS test package for the R0-03 window prototype",
  "longDescription": "R0-07 installation/distribution probe for the R0-03 Tauri transparent-window prototype. Not a production build entry and not signed.",
  "windows": {
    "webviewInstallMode": { "type": "downloadBootstrapper", "silent": true },
    "nsis": { "installMode": "currentUser" }
  }
}
```

命令（均在 `D:\workspace\Highlighter\rust-app` 下执行）：

```powershell
npx --yes @tauri-apps/cli@2 --version                     # tauri-cli 2.12.4
npx --yes @tauri-apps/cli@2 build --no-bundle --ci       # release 构建（首次 1m45s；增量 22.21s）
npx --yes @tauri-apps/cli@2 bundle --bundles nsis --ci   # downloadBootstrapper（默认）
# 其它 WebView2 模式：用 --config 覆盖，不修改 tauri.conf.json
npx --yes @tauri-apps/cli@2 bundle --bundles nsis --ci --config .tmp-r07/install/config/embedBootstrapper.json
npx --yes @tauri-apps/cli@2 bundle --bundles nsis --ci --config .tmp-r07/install/config/offlineInstaller.json
```

配置覆盖文件内容（`.tmp-r07/install/config/`，gitignore）：

```json
{"bundle":{"windows":{"webviewInstallMode":{"type":"embedBootstrapper"}}}}
{"bundle":{"windows":{"webviewInstallMode":{"type":"offlineInstaller"}}}}
```

首次 bundle 时 tauri-bundler 从 GitHub 下载 NSIS 3.13（`github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip`）
与 `nsis_tauri_utils-v0.5.3`（`github.com/tauri-apps/nsis-tauri-utils/...`），校验哈希后解压到 `%LOCALAPPDATA%\tauri\NSIS`；
embed/offline 模式另从 Microsoft 下载 WebView2 bootstrapper / standalone installer（见 §4/§5）。

产物路径（gitignore，不入库）：`rust-app/target/release/bundle/nsis/Highlighter R0 Window Prototype_0.1.0_x64-setup.exe`；
每个模式的副本与 7z 清单在 `.tmp-r07/install/artifacts/<mode>/`、`.tmp-r07/install/logs/11-7z-<mode>.txt`。

## 4. 产物清单与哈希（最终产物，2026-11-11 13:15–13:18）

最终二进制：`rust-app/target/release/highlighter-r0-window.exe`，8,928,768 B，
sha256 `7C1A3DAEBCF8852D40A862C4DC10E2B389C3F158A8E5632CF96697714BD55715`，`NotSigned`，
FileVersion `0.1.0`，ProductName `Highlighter R0 Window Prototype`。该构建包含 driver-spike 的
`HIGHLIGHTER_R0_ALLOW_PRIMARY=1` 测试专用开关（默认关闭，生产包不应依赖）。

| 模式 | 产物（`.tmp-r07/install/artifacts/<mode>/` 下同名副本） | 大小 | sha256 | 签名 |
|---|---|---:|---|---|
| downloadBootstrapper | `Highlighter R0 Window Prototype_0.1.0_x64-setup.exe` | 2,012,149 B（1.92 MiB） | `DDB4C4030EDB395A67A6B038DDB10F1502D3F761CE8845F9D0E7700ACE804374` | `NotSigned` |
| embedBootstrapper | 同上 | 3,804,032 B（3.63 MiB） | `16361AD43F1C5A8C42CAEF7E0139BD86FC1DF63415136DAE5BF4C19F22A0C752` | `NotSigned` |
| offlineInstaller | 同上 | 219,793,431 B（209.61 MiB） | `97AD8212A07CDD9446B31E751B3D3F52DB6D2F48A0E83149CEA803CB0AE00F19` | `NotSigned` |

三个安装包**内嵌的应用 exe 相同**：8,928,768 B，sha256
`36AE37CC447C28C467B648DB5C543DEA644B654121D58931BBB47233BD7F3ADB`（`NotSigned`）。
它与 release exe 的差异来自 tauri-bundler 在打包时写入 bundle type 信息（日志 `Patching ... with bundle type information: nsis`），属预期。

**内嵌 WebView2 安装器**（从最终安装包用 7-Zip 提取，见 `.tmp-r07/install/logs/12-embedded-webview2.log`）：

| 模式 | 内嵌文件（安装包内路径） | 大小 | sha256 | 签名/版本 |
|---|---|---:|---|---|
| downloadBootstrapper | 无内嵌；安装时由 NSISdl 下载 `https://go.microsoft.com/fwlink/p/?LinkId=2124703` | — | — | — |
| embedBootstrapper | `$TEMP\MicrosoftEdgeWebview2Setup.exe` | 1,897,688 B | `CF2F2445FEF0C5C14E372045F84998771EEB8BB01D59BE4AFD00692FA160082E` | `Valid`，Microsoft Corporation，FileVersion `1.3.315.17`（Microsoft Edge Update Setup） |
| offlineInstaller | `$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe` | 214,990,032 B | `1BE9D2926954D99DD62653A22EFE813160FE0C40F1E422B44E6AAF5473F68EEC` | `Valid`，Microsoft Corporation，FileVersion `1.3.315.17` |

7z 清单（`.tmp-r07/install/logs/11-7z-*.txt`）显示安装包内容只有：应用 exe、NSIS 运行时插件
（`System.dll`、`nsDialogs.dll`、`nsis_tauri_utils.dll`、`StartMenu.dll`、download 模式的 `NSISdl.dll`、
`modern-wizard.bmp`）以及（embed/offline）内嵌的 WebView2 安装器。**没有** `msedgedriver`/`tauri-driver`/
测试端点/其它原型二进制（对 ADR-0006“生产包不含测试端点”的输入之一；完整隔离验证仍需安装后文件清单，见 §6）。

> **安装包不是逐字节可复现的**：同一 release exe 重复 bundle 会得到不同 sha256（makensis 写入时间戳/临时路径），
> 例如 download 模式两次为 2,011,173 / 2,012,149 B，embed 为 3,804,657 / 3,804,032 B，offline 为 219,799,140 / 219,793,431 B。
> 上表是**最终用于烟测的产物**；基于旧二进制（不含 ALLOW_PRIMARY 开关）的产物保留在 `.tmp-r07/install/artifacts-preallowprimary/`，不作为最终证据。

## 5. WebView2 分发模式对照

Tauri 2 的 `bundle.windows.webviewInstallMode` 支持 5 种模式（官方对照见
<https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options>）。本机实测：

| 模式 | 需要联网 | 本机安装包大小 | 相对 download 增量 | 内嵌 WebView2 安装器 | 状态 |
|---|---|---:|---:|---|---|
| downloadBootstrapper（默认） | 安装时 | 2,012,149 B | — | 无（NSISdl 下载 bootstrapper） | **实测产出** |
| embedBootstrapper | 安装时 | 3,804,032 B | +1,791,883 B | bootstrapper 1,897,688 B | **实测产出** |
| offlineInstaller | 否 | 219,793,431 B | +217,781,282 B | standalone installer 214,990,032 B | **实测产出** |
| fixedRuntime | 否 | 预计 +~180 MB（Tauri 文档估计） | 未测 | 固定版本 Runtime 目录 | **仅评估，未实测** |
| skip | 否 | +0 | — | 无 | 不推荐（缺 Runtime 时应用不可用） |

说明：

- Tauri 官方文档给 offlineInstaller 的估计是 “+~127 MB”，但**本机实测内嵌文件为 214,990,032 B（约 205 MiB）**；
  说明该估计值随 Runtime 版本/渠道变化，预算应以实测为准。
- NSIS 模板逻辑（`tauri-cli v2.12.4` 的 `installer.nsi`，已下载到 `.tmp-r07/install/logs/tauri-installer-nsi.txt` 备查）：
  - 先读 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-...}` 的 `pv`（64 位视图，读不到再读 HKCU）；
  - `pv` 为空且非 update 模式时：download 模式用 `NSISdl::download` 下载到 `$TEMP`；embed/offline 模式用 `File` 释放内嵌安装器；
    然后 `ExecWait "$6 <silent args> /install"`；失败则 `Abort`（**静默模式下 Abort 不弹窗、进程退出码为 0**——这是排障时需要注意的行为）；
  - 运行中实例检查使用 Windows Restart Manager（`CheckIfAppIsRunning`，按 `$INSTDIR\<main binary>.exe` 注册文件）。
- **fixedRuntime（未实测，成本/限制评估）**：需要从 Microsoft 下载固定版本 Runtime 的 `.cab` 并解压成目录，配置
  `{"type":"fixedRuntime","path":"<目录>"}`；安装包预计增加约 180 MB；应用不再跟随系统 Runtime 自动安全更新，
  必须自建 Runtime 更新与漏洞响应流程。除非产品明确要求“离线 + 固定 Runtime 版本”，否则不建议作为默认策略（R8-02 决策项）。

## 6. 安装/卸载烟测（**手动交互安装→启动→卸载已通过；自动静默安装“不落盘”根因已定位**）

计划链路：`setup.exe /S`（per-user，不提权）→ 核对 `%LOCALAPPDATA%\Highlighter R0 Window Prototype` 文件清单、
HKCU Uninstall 注册项、开始菜单快捷方式 → 运行已安装 exe `--self-test`（单屏无 env 预期 exit 2；
`HIGHLIGHTER_R0_ALLOW_PRIMARY=1` 时预期 PASS exit 0）→ 缺失 WebView2 探针 → `uninstall.exe /S` → 目录/注册项清理。

### 6.1 手动交互安装：成功（2026-11-11 14:17，用户在本机操作）

用户用交互向导手动安装**同一个** `downloadBootstrapper` 安装包（sha256 `DDB4C403…374`），选择**自定义目录**
`D:\Program Files\Highlighter R0 Window Prototype`（非默认 `%LOCALAPPDATA%`），安装成功。Lead 随后自动取证
（脚本 `.tmp-r07/install/verify-manual-install.ps1`，日志 `.tmp-r07/install/logs/manual-install-verify-142915.log`，
stdout/stderr 见同目录 `manual-installed-*.out.txt`）：

**安装结果（实测）**：

- 安装目录 2 个文件：`highlighter-r0-window.exe` 8,928,768 B（sha256 `36AE37CC447C28C467B648DB5C543DEA644B654121D58931BBB47233BD7F3ADB`，
  与安装包内嵌 exe **完全一致**）、`uninstall.exe` 79,288 B；exe `NotSigned`、FileVersion `0.1.0`、
  ProductName `Highlighter R0 Window Prototype`；**目录内无驱动/测试端点文件**。
- HKCU 卸载键 `Highlighter R0 Window Prototype`：DisplayName `Highlighter R0 Window Prototype`、DisplayVersion `0.1.0`、
  Publisher `Highlighter R0 (test build, not for release)`、InstallLocation/UninstallString/DisplayIcon 均指向实际安装路径、
  EstimatedSize `8796` KB。
- 开始菜单快捷方式存在：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Highlighter R0 Window Prototype.lnk`。
- 权限路径：本机 `D:\Program Files` 的 ACL 对 `BUILTIN\Users` 为 FullControl（Lead 实测），因此 per-user 安装写入
  该自定义目录**不需要管理员权限**；安装时是否出现 UAC/SmartScreen 提示未记录（待用户补充，见 §6.4）。

**已安装 exe 启动验证（4 个场景，同一脚本）**：

| 场景 | 结果 |
|---|---|
| 无 env，`--self-test` | 退出码 **2**，`[FAIL] startup code=secondary-monitor-required`，不建窗、无残留（265 ms） |
| `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`，`--self-test --hold-ms 2000` | 退出码 **0**：主屏 2240×1400 浮层、`[PASS] … target_primary=true allow_primary=true`、ready/init 各一次；app 进程 0。**WebView2 子进程在退出后约 3 s 仍有 2 个、10 s 内归零**（延迟回收，非常驻泄漏） |
| 空 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`（无 env） | 退出码 **2**（在创建 WebView 之前即因单屏拒绝失败，不触发加载器对话框） |
| 空 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` + `ALLOW_PRIMARY=1` | 加载器弹 `#32770` `Error` 对话框（189 ms 发现并自动点“确定”）；随后 `[FAIL] startup code=window-create-failed … runtime error: Could not find the webview runtime`，退出码 **2**，无残留 |

→ 与 release exe 的应用级探针结果一致（§7），证明**安装后的二进制与构建产物同源、启动与失败路径正常**；
同时说明：缺失 WebView2 时安装版应用同样是“加载器阻塞对话框 → Tauri 启动失败 exit 2”。

### 6.2 自动静默安装“不落盘”：根因已定位（2026-11-11 17:40，修正此前“会话/作业对象隔离”假设）

> 本节**推翻**旧版结论（旧版判断为“本机受限会话/环境级隔离，需真实桌面会话复测”）。完整实验记录与原始证据见
> `.tmp-r07/install/rootcause/ROOTCAUSE.md`、`probe-*.log/json`、`evidence-*.txt`；可复跑脚本同目录。

**根因**：`D:\workspace\Highlighter` 根目录带有 DSH workspace-write 沙箱遗留的**强制完整性标签
`Low Mandatory Level:(OI)(CI)(NW)`**（另有 `Everyone:(CI)(DENY)(DC)` 与能力 SID
`S-1-4-1070570333-856284178:(OI)(CI)(W,D,DC)`）。标签随目录继承到工作区所有 exe（含本任务全部安装包与最小
NSIS 对照包）。Windows 在创建进程时把进程完整性级别封顶为**不高于其镜像文件的完整性标签**：工作区内 exe
无论由哪个会话/进程启动，都是 Low IL（S-1-16-4096）。Low 进程受 **No-Write-Up** 约束，不能写 Medium 位置
（`%LOCALAPPDATA%`、`%TEMP%`、HKCU、`D:\Program Files` 等）；NSIS 静默模式忽略逐文件失败并正常退出 0，
于是表现为“exit 0、数百 ms、目录/HKCU/快捷方式全无”。**与登录会话、计划任务、作业对象、UAC、Defender 无关。**

**直接证据（2026-11-11 17:33 采集）**：

- `icacls "D:\workspace\Highlighter"`：`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`；安装包 exe：
  `Mandatory Label\Low Mandatory Level:(I)(NW)`（完整输出见 `rootcause/evidence-icacls.txt`）。
- suspended-create（进程尚未执行用户代码）读 token：工作区原件 `S-1-16-4096`（Low）；同字节副本复制到
  `%TEMP%` 后 `S-1-16-8192`（Medium）⇒ 不是 NSIS 自降权，而是镜像标签封顶。
- 非静默（page-less）最小 NSIS 从工作区启动时卡在 `#32770` 对话框：
  `Error opening file for writing: C:\Users\24532\AppData\Local\R07T6Install\payload.txt`
  （Low→Medium 写失败的直观证据）；`/S` 静默模式则吞掉错误并退出 0。
- 旧 `logs/child-groups.txt` 的“Medium”结论不具代表性：那是 System32 签名程序（如 whoami.exe）的 token，
  不是安装包子进程。

**对照实验（同一安装包字节，仅完整性标签不同）**：

| 上下文 | 安装包 | 进程 IL（创建时） | 结果 |
|---|---|---|---|
| 当前会话（CreateProcess `/S`） | 工作区原件（sha256 `DDB4C403…374`） | **Low** | exit 0 / 630 ms / **无落盘**（复现旧现象） |
| 交互桌面一次性计划任务（Interactive+Limited） | 工作区原件 | Low | exit 0 / 476 ms / **无落盘**（复现；任务本身不是原因） |
| 当前会话 | **`%TEMP%\R0Probe\final-setup.exe` 同字节副本** | **Medium** | exit 0 / 469 ms / **安装成功**：目录 2 文件（exe sha256 `36AE37CC…3ADB` 与包内一致）、HKCU Uninstall 键、开始菜单快捷方式 |
| 交互桌面一次性计划任务 | 同 `%TEMP%` 副本 | Medium | exit 0 / 731 ms / **安装成功**（lastTaskResult=0；任务已删除） |
| 当前会话 | 最小 NSIS `minimal-setup5.exe`（工作区） | Low | exit 0 / 387 ms / 无落盘 |
| 当前会话 / 交互计划任务 | 最小 NSIS `%TEMP%` 副本 | Medium | exit 0 / 500 ms、867 ms / 安装成功（`%LOCALAPPDATA%\R07MinimalNsisTest5` + HKCU 键） |

**已安装 exe 四场景复核（2026-11-11 17:37，交互计划任务用 Medium-IL 副本安装后）**：无 env exit 2
（`secondary-monitor-required`）；`ALLOW_PRIMARY=1` exit 0（`[PASS] … dpr=1.5`，ready/init 各一次）；
空 Runtime 目录（无 env）exit 2；空 Runtime 目录 + `ALLOW_PRIMARY=1` → 加载器 `#32770` Error 对话框
（319 ms 发现、347 ms 自动关闭）→ exit 2。均与 §6.1 一致。

**旧证据的重新解释/保留**：

1. 未签名包经 ShellExecute 启动弹“打开文件 - 安全警告”仍成立：自动化必须用 CreateProcess
   （`.NET ProcessStartInfo.UseShellExecute=false`）；最终用户双击安装有同样风险 → 发布必须签名（R8-02）。
2. 交互式向导可正常显示仍成立（与 Low 标签不矛盾：向导阶段尚未写 `%LOCALAPPDATA%`；用户此前手动安装成功
   最可能因为使用了工作区外的安装包副本——原始路径未记录，无法回溯确认）。
3. 旧 §6.2 中“`/P` 被动模式挂起”“`/D=` 无空格路径”等观察保留为历史记录，不再作为根因论据。

**ACL 修复后复跑（2026-11-11 19:47，问题关闭）**：

Lead 于 2026-11-11 19:4x 执行修复：`icacls "D:\workspace\Highlighter" /setintegritylevel (OI)(CI)M /T /C`
覆盖工作区全树 61,767 个文件，并移除 `Everyone:(CI)(DENY)(DC)` 与能力 SID ACE。修复后复核：

- `icacls "D:\workspace\Highlighter"`：`Mandatory Label\Medium Mandatory Level:(OI)(CI)(NW)`（Low 标签已消除）；
  安装包 exe、`rust-app/target/release/highlighter-r0-window.exe`、README.md 等均为 `Medium Mandatory Level`。
- **工作区原件**安装包（sha256 `DDB4C403…374`，未复制到工作区外）suspended-create token：
  `IntegritySid=S-1-16-8192`（Medium；修复前为 `S-1-16-4096` Low）。
- **使用工作区原件** CreateProcess `/S`（2026-11-11 19:47）：退出码 **0**、**770 ms**、安装进程 token
  `S-1-16-8192`（Medium）；安装目录 2 文件（exe sha256 `36AE37CC…3ADB` 与包内一致、`uninstall.exe`
  79,288 B）、HKCU Uninstall 键（DisplayVersion 0.1.0 / EstimatedSize 8796）、开始菜单快捷方式全部出现。
- 已安装 exe 四场景：无 env exit 2；`ALLOW_PRIMARY=1` exit 0（`[PASS] … dpr=1.5`）；空 Runtime 目录
  （无 env）exit 2；空 Runtime 目录 + `ALLOW_PRIMARY=1` → 加载器 `#32770` Error 对话框（274 ms 发现、
  293 ms 自动关闭）→ exit 2。与 §6.1 一致。
- `uninstall.exe /S`：exit 0 / 565 ms；安装目录、HKCU 卸载键、开始菜单快捷方式全部清理、无残留进程；
  遗留 `HKCU\Software\Highlighter R0 (test build, not for release)\Highlighter R0 Window Prototype`
  （default=安装路径）为 Tauri NSIS 模板既定行为（R8-02 决策项）。
- 现场：计划任务 0、%TEMP% 无新 `ns*.tmp`、应用进程 0。

→ **“静默 `/S` 不落盘”关闭为“环境缺陷（工作区完整性标签）已修复并复验”**；不再需要从工作区外副本运行
安装烟测。**下文“从工作区外副本运行”保留为历史/回退说明**：仅当再次检测到“工作区内 exe 为 Low IL”
（例如又使用了 workspace-write 会话）时才需要。
证据：`rootcause/probe-postfix-full.log/json`、`scenario-postfix-full-*.out/err.txt`、
`rootcause/probe-postfix-uninstall.log/json`、`rootcause/evidence-acl-fix-verified.txt`。

**环境修复（2026-11-11 19:4x 已由 Lead 执行并验证；命令保留为回退/复检用）**：在 danger-full-access 会话中

```powershell
icacls "D:\workspace\Highlighter" /setintegritylevel (OI)(CI)M /T /C
icacls "D:\workspace\Highlighter" /remove:d Everyone /T /C
icacls "D:\workspace\Highlighter" /remove "S-1-4-1070570333-856284178" /T /C
```

第 1 条为关键；修复前已在隔离子目录 `.tmp-r07/install/rootcause/il-test` 实测有效（执行后同一 exe 的
suspended-create token 由 Low 变 Medium、`%LOCALAPPDATA%` 写入恢复 OK；验证后该目录已删除）。
**回退/复检**：若再次出现 Low 标签（例如又使用 workspace-write 沙箱会话），安装/启动烟测可临时把 exe
复制到工作区外普通目录（如 `%TEMP%\<probe>\`）运行并记录副本 sha256，同时按 `icacls` 输出复检标签。
另：该标签可能同源影响其它“受限宿主”类结论（handoff §7 陷阱 3/4、ADR-0001 WGC 等）；本轮未复跑这些
环境级检查，**不得写成已解决**。

**复跑命令**：见 `rootcause/ROOTCAUSE.md` §4（`probe-silent-install.ps1` 基线/对照、`run-scheduled-probe.ps1`
一次性交互计划任务并自动删除、`probe-uninstall.ps1` 卸载、`cleanup-probe.ps1` 清理）。


### 6.3 已确认的安装包内容（非安装结果）

- 7z 提取最终 downloadBootstrapper 安装包得到应用 exe：8,928,768 B，sha256 `36AE37CC447C28C467B648DB5C543DEA644B654121D58931BBB47233BD7F3ADB`；
- 安装包内无测试驱动/端点文件（见 §4）。

### 6.4 卸载：成功（2026-11-11 15:49，用户确认后由 Lead 执行）

用户确认后，Lead 执行 `uninstall.exe /S`（静默卸载）并取证（日志 `.tmp-r07/install/logs/manual-install-verify-154849.log`）：

| 检查项 | 结果 |
|---|---|
| 卸载退出码 / 耗时 | **0** / 60 ms |
| 安装目录 `D:\Program Files\Highlighter R0 Window Prototype` | **已删除**（60 ms 内消失） |
| HKCU Uninstall 键（DisplayName `Highlighter R0 Window Prototype`） | **已删除**（计数 0） |
| 开始菜单快捷方式 `Highlighter R0 Window Prototype.lnk` | **已删除** |
| 运行中/残留进程 | 0（应用与相关 WebView2 进程均无） |

卸载前后另复核了已安装 exe 的 4 个启动场景（与 §6.1 完全一致：无 env exit 2 / ALLOW_PRIMARY=1 PASS / 缺失 WebView2 阻塞对话框后 exit 2），
确认卸载前安装仍然完整可用。

**已知遗留（如实记录，不是“通过”）**：

1. **`HKCU\Software\Highlighter R0 (test build, not for release)\Highlighter R0 Window Prototype` 仍存在**：
   默认值为安装路径，另有 `Installer Language=1033`。根因（对照 tauri-cli 2.12.4 的 `installer.nsi`，见
   `.tmp-r07/install/logs/tauri-installer-nsi.txt` 第 918-924 行）：该键只在卸载向导勾选“删除应用数据”
   （`$DeleteAppDataCheckboxState=1`）时才删除；**静默 `/S` 卸载默认不勾选**，所以保留。这是模板的既定行为，
   不是本轮特例。→ R8-02 需决定：是否让静默卸载默认清理该键，或改为无条件删除。
2. **`%TEMP%\~nsu.tmp` 存在但与本次卸载无关**：其创建时间 2026-10-12、修改时间 2026-11-06，早于本轮安装/卸载，
   属历史遗留；本轮未删除（避免误删他人数据）。
3. **Windows `AppListBackup` 中的条目**（`HKCU\Software\Microsoft\Windows\CurrentVersion\AppListBackup\...`）
   为操作系统托管的应用列表备份，不是安装器写入；不视为卸载器缺陷。
4. 原型把 WebView2 用户数据目录**编译期固定**到构建机路径（`rust-app/target/r0-window-webview2-data`），
   卸载不会删除它（也不应删除仓库构建目录）；R1/R8 必须改为 per-user 数据根并按策略清理（安装矩阵 §1/§11）。
5. **2026-11-11 17:39 复测**（§6.2 中由交互计划任务从 Medium-IL 副本重建的安装）：`uninstall.exe /S` exit 0 /
   715 ms，安装目录、HKCU 卸载键、开始菜单快捷方式全部清理、无残留进程；遗留 publisher 键仍存在
   （本次仅记录到 default=安装路径）。与上表结论一致。
6. **2026-11-11 19:48 ACL 修复后复验**（工作区原件安装，未复制）：`uninstall.exe /S` exit 0 / 565 ms，
   安装目录、HKCU 卸载键、开始菜单快捷方式全部清理、无残留进程；遗留 publisher 键仅 default=安装路径。
   与上表结论一致。

### 6.5 待补/待决策

- [x] **静默 `/S` 不落盘的环境根因**（§6.2，2026-11-11 17:40）：工作区 Low 完整性标签 → 工作区内 exe 以
  Low IL 运行 → No-Write-Up 阻止写 `%LOCALAPPDATA%`/HKCU；与登录会话/计划任务/UAC/Defender 无关；
  同字节副本在工作区外可正常静默安装（当前会话 + 交互桌面计划任务），最小 NSIS 对照一致。
- [x] **工作区 ACL/完整性标签清理与复跑**（2026-11-11 19:4x Lead 执行、19:47 复跑）：全树 61,767 文件
  Low→Medium、移除 DENY/能力 SID ACE；工作区原件静默安装 exit 0/770 ms 成功、四场景与卸载清理均通过（§6.2）。
- [ ] 若后续再次使用 workspace-write 沙箱会话，复检工作区标签是否被重新写入（回退方案见 §6.2）。
- [ ] 安装过程 UAC/SmartScreen 提示的真实用户体验（仍未记录；CreateProcess 路径无 UAC）。
- [ ] 跨机器安装（安装包内 exe 的 WebView2 数据目录编译期固定构建机路径，见 §1）。
- [ ] 清理标签后复跑 handoff §7 与 ADR-0001 中“受限宿主”相关环境级结论（Electron sandbox/TMP 写入/WGC 等）；
  本轮不把这些结论改写成已解决（仅提示可能同源）。

## 7. 缺失 WebView2 Runtime 的行为（同栈探针实测）

**探针**：复用仓库既有 R0-06 原型 `rust-app/prototypes/webview-pdf-resource`（Release，独立 workspace 但复用主 workspace
target 目录；依赖与 R0-03 同栈：tauri 2.12.5 / wry 0.57.2 / webview2-com 0.39.1），`--pdf` 模式创建**隐藏**窗口，
不需要副屏。用 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 指向**空目录**模拟 Runtime 缺失（不卸载系统 Runtime）。

| 场景 | 结果 |
|---|---|
| 对照组（不设 env） | 退出码 **0**，16.3 s，12 个 PDF 用例 `[PASS]`（证明探针与 Runtime 正常） |
| `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` = 空目录 | WebView2 加载器弹出**阻塞式 `#32770` 错误对话框**（标题 `Error`，SysLink 文本：`Could not find the WebView2 Runtime. Make sure it is installed or download it from https://developer.microsoft.com/en-us/microsoft-edge/webview2. You may have it installed on another user account, but it is not available for this one.`，按钮 `确定`）；**进程挂起，等待用户点确定**。点确定后 stdout：`[FAIL] 创建打印窗口 pdf-primary 失败: runtime error: Could not find the webview runtime, make sure it is installed`、`[r0-pdf] event loop exited code=3`，退出码 **3**，无残留进程。 |

**R0-03 release exe 的应用级探针**（`rust-app/target/release/highlighter-r0-window.exe`，未安装；与安装包内 exe 同源）：

| 场景 | 结果 |
|---|---|
| 无 env，`--self-test` | 退出码 **2**：`[FAIL] startup code=secondary-monitor-required message=no-secondary-monitor...`，不创建窗口（driver-spike 日志 `.tmp-r07/driver/release-self-test-no-env.log`，与本次复测一致） |
| `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`，`--self-test --hold-ms 2000` | 退出码 **0**：主屏 2240x1400 可见浮层、dpr=1.5、ready/init 各一次、`[PASS]`（`.tmp-r07/driver/release-self-test-allow-primary.log`） |
| `ALLOW_PRIMARY=1` + `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`=空目录 | 先弹与上表相同的 `#32770` “Error” 对话框（已自动点“确定”）；随后 `[FAIL] startup code=window-create-failed message=创建浮层窗口失败: runtime error: Could not find the webview runtime, make sure it is installed`，退出码 **2**，无残留进程（400 ms）。证据：`.tmp-r07/install/logs/release-exe-missing-wv2-allow-primary.out.txt` |

→ 即：**缺失 Runtime 时产品启动路径的表现是“加载器阻塞对话框 + Tauri 启动失败（exit 2）”**；产品必须在创建窗口前自检并给引导（见下）。

对产品的含义（R8-02 输入）：

1. 缺失/损坏 WebView2 时，**失败发生在 WebView2 加载器内部并弹阻塞对话框**，不是产品可控的静默错误；对托盘/自启动应用
   意味着“开机后卡在对话框/无提示”。产品**必须**在创建任何窗口前做能力检测：
   - 推荐：调用 WebView2Loader 的 `GetAvailableCoreWebView2BrowserVersionString`（或读 `EdgeUpdate\Clients\{F3017226-...}\pv`
     注册表）判断 Runtime 是否存在/版本是否满足；失败时用**原生 MessageBox**（带下载链接）说明并给出明确退出码；
   - 版本下限可用 `bundle.windows.minimumWebview2Version`（Tauri ≥2.10；旧字段 `bundle.windows.nsis.minimumWebview2Version` 已弃用）
     让安装器在版本过低时触发更新；
   - 离线/内网场景评估 `offlineInstaller` 或 `fixedRuntime`（§5）。
2. 加载器对话框是英文、阻塞、非产品 UI，不能作为产品引导；且它先于 Tauri 错误返回，日志/遥测可能只看到“卡住”。
3. **已安装 exe 的同类探针已执行（2026-11-11 14:29，见 §6.1）**：无 env → exit 2（单屏拒绝，不触发加载器）；
   `ALLOW_PRIMARY=1` + 空 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` → 先出同样的 `#32770` “Error” 加载器对话框
   （已自动点“确定”）→ `[FAIL] startup code=window-create-failed … Could not find the webview runtime`、
   exit 2、无残留。与 release exe 的结论一致。

## 8. 版本冻结（本轮实测）

| 项 | 冻结值 | 备注 |
|---|---|---|
| tauri CLI | `tauri-cli 2.12.4`（npx `@tauri-apps/cli@2`） | npm 缓存，不写入仓库；npx 版本会漂移，正式构建建议 pin |
| tauri / tauri-build | 2.12.5 / 2.7.4（`rust-app/Cargo.lock`） | `--locked` 可复现 crate 版本 |
| tauri-runtime(-wry) / wry / webview2-com | 2.12.2 / 2.12.3 / 0.57.2 / 0.39.1 | 同上 |
| Rust | 1.97.1（`rust-app/rust-toolchain.toml`） | |
| NSIS | 3.13（tauri-bundler 自动下载） | 由 CLI 决定；未使用本机 `D:\tools\nsis` |
| nsis_tauri_utils | v0.5.3 | tauri-bundler 自动下载 |
| WebView2 Runtime（本机） | 157.0.4341.46（另有 157.0.4341.42 目录） | 系统组件；多版本矩阵需真实测试机（ADR-0007） |
| Windows | 11 家庭版 10.0.26300，UBR 9974（26H2） | |
| Node / npm | 24.15.0 / 11.17.0 | 仅用于 npx 获取 CLI |

> 注意：这些值只代表本机一次采样；换机器/换 Runtime/换 CLI 版本后不能直接复用为“已冻结”结论。G0 前仍需真实测试机的
> WebView2 有/无/离线、旧 Runtime 版本、Windows build 下限矩阵（ADR-0007）。

## 9. 结论（截至本文件）

1. **可以**从 R0-03 原型产出三种 NSIS 测试包（download/embed/offline），payload 正确、内嵌 WebView2 安装器可提取且为
   Microsoft 有效签名；三种包本身均 `NotSigned`，只能作为测试件。
2. 体积/网络依赖与官方方向一致：download 1.92 MiB（联网）、embed 3.63 MiB（联网，+~1.8 MB）、offline 209.61 MiB（离线）。
   offline 的实际体积明显大于文档估计（~127 MB），预算必须按实测。
3. **手动交互安装→启动→卸载链路已实测通过（§6.1/§6.4）**：用户以自定义目录
   `D:\Program Files\Highlighter R0 Window Prototype` 手动安装成功；安装目录/文件哈希（内嵌 exe `36AE37CC…3ADB` 一致）/
   HKCU 卸载键/开始菜单快捷方式均正确；已安装 exe 的 4 个启动场景符合预期（含缺失 Runtime 的阻塞对话框 + exit 2）；
   用户确认后 `uninstall.exe /S` 退出码 0（60 ms），安装目录、HKCU 卸载键、开始菜单快捷方式均删除、无残留进程。
   **已知遗留**：静默卸载会保留 `HKCU\Software\<publisher>\<product>`（安装路径 + Installer Language）——
   这是 tauri-cli 2.12.4 NSIS 模板“仅在勾选删除应用数据时才清理”的既定行为（§6.4），R8-02 需决策是否改为无条件清理。
   **自动静默安装“不落盘”根因已定位**（§6.2，2026-11-11 17:40）：工作区被 DSH workspace-write 沙箱遗留
   `Low Mandatory Level` 完整性标签 → 工作区内 exe 以 Low IL 运行 → No-Write-Up 阻止写 `%LOCALAPPDATA%`/HKCU；
   **与登录会话/计划任务/UAC/Defender 无关**。同一字节副本（sha256 `DDB4C403…374`）在工作区外目录、由当前
   会话与交互桌面一次性计划任务静默安装均成功，安装产物与 §6.1 一致；最小 NSIS 对照同样“工作区失败/副本成功”。
   **2026-11-11 19:4x Lead 修复工作区完整性标签（全树 Low→Medium）后，19:47 用工作区原件（未复制）复跑：
   静默安装 exit 0 / 770 ms 成功（安装进程 token=Medium）、四场景与 `uninstall.exe /S` 清理全部符合预期
   → 问题关闭为“环境缺陷已修复并复验”**；旧“从工作区外副本运行”仅保留为回退说明。
4. 缺失 WebView2 的失败行为已实测（同栈探针 + release exe 应用级探针）：加载器阻塞对话框 + 探针退出码 3 / 应用退出码 2；
   产品必须做启动前检测与引导。
5. fixedRuntime 仅完成文档评估（成本/更新责任），未实测。
6. G0 仍未通过；本文件只补齐 R0-07 的部分证据（产物矩阵、版本冻结、缺失 Runtime 行为），完整安装矩阵与
   WebView2 多版本矩阵仍需真实测试机/用户桌面会话。

## 10. 未验证项（不得写成通过）

- [x] 手动交互安装的目录/注册项/快捷方式/已安装 exe 启动与缺失 WebView2 行为（§6.1，2026-11-11 实测）。
- [x] **卸载链路**：`uninstall.exe /S` 退出码 0，安装目录/HKCU 卸载键/开始菜单快捷方式均清理、无残留进程（§6.4，2026-11-11 实测）。
- [x] **自动静默安装“不落盘”环境根因与修复复验**（§6.2）：2026-11-11 17:40 定位为工作区 Low 完整性标签
  → 工作区内 exe 以 Low IL 运行 → No-Write-Up；19:4x Lead 修复工作区标签（61,767 文件 Low→Medium、移除
  DENY/能力 SID ACE）后，19:47 用工作区原件复跑：静默安装 exit 0/770 ms 成功、四场景与卸载清理符合预期。
- [x] 工作区 ACL/完整性标签清理的执行与清理后复跑（§6.2，2026-11-11 19:4x/19:47；已远离“需从工作区外副本”的限制）。
- [ ] 若后续再次使用 workspace-write 沙箱会话，复检工作区标签是否被重新写入（回退方案见 §6.2）。
- [ ] 卸载后 `HKCU\Software\<publisher>\<product>` 遗留键的清理决策（Tauri NSIS 模板仅在勾选删除应用数据时清理；R8-02 决策，§6.4）。
- [ ] 安装过程 UAC/SmartScreen 的真实用户体验记录（待用户补充）。
- [ ] fixedRuntime 实测（下载固定版本 cab、配置、安装体积、运行时是否生效、更新策略）。
- [ ] skip 模式行为（预期：安装包不处理 Runtime，缺失时应用不可用）。
- [ ] WebView2 多版本/旧版本/缺失真实机器矩阵（ADR-0007 依赖）。
- [ ] 安装包代码签名与 SmartScreen/“打开文件 - 安全警告”的真实用户体验（本轮只观察到未签名警告）。
- [ ] 安装器在**其它机器**上的行为（原型 WebView2 数据目录编译期固定为构建机路径，见 §1）。
- [ ] 安装包逐字节可复现性（本轮已证明不可复现；正式发布需记录签名后的哈希与来源）。
- [ ] 安装/卸载对真实用户数据（`%LOCALAPPDATA%\dev.highlighter.r0.window-prototype` 等）的影响（原型未使用真实数据根）。

## 11. 对 R8-02 的输入

1. **安装包预算**：在线 downloadBootstrapper 约 2 MB；需要“安装时无网”的版本用 offlineInstaller 约 210 MB（本机实测），
   fixedRuntime 预计 +~180 MB。产品需按发行渠道决定在线/离线策略，不能沿用旧文档的 127 MB 估计。
2. **必须签名**：本机未签名安装包经 ShellExecute 启动即触发“打开文件 - 安全警告”；发布前需代码签名 + 时间戳，
   并验证 SmartScreen 体验；同时 `Get-AuthenticodeSignature` 状态必须进入发布门禁。
3. **WebView2 策略**：默认 downloadBootstrapper + `minimumWebview2Version`；离线/内网渠道用 offlineInstaller；
   fixedRuntime 仅在明确需要固定版本时评估（自担安全更新）。应用启动前必须检测 Runtime 并给出原生引导
   （不能依赖加载器阻塞对话框）。
4. **per-user 安装已实测**：配置为 `nsis.installMode=currentUser`（默认），实测安装到**用户自定义目录**
   `D:\Program Files\Highlighter R0 Window Prototype` 成功（该目录 ACL 对 Users 为 FullControl，故未提权也可写），
   HKCU Uninstall + 用户开始菜单快捷方式正确；默认目录为 `%LOCALAPPDATA%\<productName>`。R8-02 若要求 per-machine，
   需要单独验证提权/多用户/卸载行为。
   **卸载清理需补一个决策**：静默 `/S`（未勾选“删除应用数据”）会保留 `HKCU\Software\<publisher>\<product>`
   （安装路径 + Installer Language），模板只在该勾选为 1 时删除（§6.4）；发布前应确认是否需要无条件清理。
5. **测试端点隔离**：安装包 payload 与**安装后文件清单**（§6.1：仅应用 exe + uninstall.exe）均确认不含
   `msedgedriver`/`tauri-driver`/测试端点。
6. **原型数据目录**：R0-03 原型把 WebView2 数据目录编译期固定到构建机 `rust-app/target/...`，安装包跨机器不可用；
   R1/R8 必须改为 `%LOCALAPPDATA%\<bundle id>` 数据根，并在卸载时按策略清理。
7. **构建可复现性**：NSIS 安装包非逐字节可复现（时间戳/临时路径）；发布流水线需记录 CLI/crate/NSIS/WebView2 版本，
   并对签名后的最终产物记录 sha256。Tauri CLI 会改写 Cargo.toml（§2），CI 需接受或显式 pin。
8. **工具链 pin**：tauri CLI 通过 npx 获取会漂移；正式流水线应 pin `@tauri-apps/cli` 精确版本与 NSIS 下载哈希
   （tauri-bundler 已校验哈希），并固定 `rust-app/rust-toolchain.toml`。

## 12. 证据索引（`.tmp-r07/install/`，gitignore）

| 路径 | 内容 |
|---|---|
| `logs/10-final-build-release.log` | 最终 release 构建（22.21 s，exe 8,928,768 B） |
| `logs/11-bundle-matrix.log` | 三种模式 bundle 全过程、产物大小/sha256/签名、packed exe、内嵌 WebView2 |
| `logs/11-bundle-<mode>.log` | 单模式 tauri bundle 原始输出（含下载 URL/哈希校验/NSIS 调用） |
| `logs/11-7z-<mode>.txt` | 每个安装包的 7-Zip 内容清单 |
| `logs/12-embedded-webview2.log` | 从最终安装包提取的内嵌 WebView2 安装器（大小/sha256/签名/版本） |
| `logs/pdf-probe-control.out.txt` / `pdf-probe-missing-webview2.out.txt` | 缺失 WebView2 同栈探针的对照/失败输出 |
| `logs/manual-install-verify-142915.log` | 手动交互安装后的自动取证：安装状态、4 个已安装 exe 启动场景、缺失 Runtime 对话框与退出码 |
| `logs/manual-install-verify-154849.log` | 用户确认后的卸载取证：卸载前后状态、4 个启动场景复核、`/S` 退出码、目录/注册项/快捷方式清理 |
| `logs/manual-installed-*.out.txt` / `.err.txt` | 上述 4 个场景的原始 stdout/stderr |
| `verify-manual-install.ps1` | 可复跑的安装后取证脚本（Lead 编写，scratch；含 `-Uninstall` 开关，本轮未使用） |
| `logs/install-smoke-final-downloadBootstrapper.log` | 安装烟测（v2，CreateProcess）观察记录（含失败证据） |
| `logs/release-exe-missing-wv2-allow-primary.out.txt` | release exe + ALLOW_PRIMARY + 空 WebView2 目录的应用级探针输出（exit 2） |
| `logs/child-groups.txt` | 旧版“子进程 IL=Medium”取证（System32 签名程序 token；**不代表安装包子进程**，见 §6.2） |
| `nsis-min-test/` | 同版本 NSIS 最小 per-user 安装器对照（工作区原件 Low IL → 不落盘；`%TEMP%` 副本 → 成功，见 §6.2） |
| `rootcause/ROOTCAUSE.md` | **静默安装根因报告**：结论、机制、对照实验、复跑命令、修复建议、遗留（2026-11-11 17:40） |
| `rootcause/probe-silent-install.ps1` / `probe-uninstall.ps1` / `run-scheduled-probe.ps1` / `cleanup-probe.ps1` / `probe-lib.ps1` | 可复跑探针：上下文/token/状态取证、基线复现、一次性交互计划任务（自动删除）、卸载、清理 |
| `rootcause/probe-<tag>.log/json` | 各实验原始证据：工作区原件失败复现、同字节副本成功、最小 NSIS 对照、四场景（含进程 IL、exit、耗时、子进程/窗口） |
| `rootcause/scenario-*.out.txt` / `.err.txt` | 已安装 exe 四场景 stdout/stderr |
| `rootcause/task-definition-*.xml` / `task-run-*.log` / `task-state-*.json` | 一次性计划任务定义/运行/lastTaskResult/删除证据（Interactive+Limited） |
| `rootcause/evidence-icacls.txt` / `evidence-tokens.txt` | 工作区 Low 完整性标签与沙箱 ACE 的 icacls 输出；工作区原件 vs `%TEMP%` 副本的 suspended-create token 对照 |
| `rootcause/diag-token.ps1` / `diag-label.ps1` / `cs-writer*.exe` / `nsis-t6/` / `t6-trace/` | 反证实验：Low exe 写 `%LOCALAPPDATA%` 失败、`#32770`“Error opening file for writing”证据、隔离目录标签修复验证 |
| `rootcause/probe-postfix-full.log/json`、`scenario-postfix-full-*.out/err.txt` | **ACL 修复后复跑**（工作区原件）：安装 exit 0/770 ms、进程 IL=Medium、目录/HKCU/快捷方式产物、四场景原始输出 |
| `rootcause/probe-postfix-uninstall.log/json` | ACL 修复后卸载复验：exit 0/565 ms、目录/HKCU 卸载键/快捷方式清理、遗留 publisher 键 |
| `rootcause/evidence-acl-fix-verified.txt` | 修复后 icacls 标签（Medium）与 token 证据（工作区根/安装包 exe/rust-app target exe） |
| `logs/silent-console-capture.txt` | 静默安装控制台捕获尝试（命令失败记录） |
| `logs/tauri-installer-nsi.txt` / `tauri-utils-nsh.txt` | tauri-cli v2.12.4 NSIS 模板/工具宏（排障与逻辑核对） |
| `artifacts/<mode>/` | 最终安装包副本（与 `rust-app/target/release/bundle/nsis/` 相同） |
| `artifacts-preallowprimary/` | 旧二进制（不含 ALLOW_PRIMARY 开关）产物，仅历史对照 |
| `config/embedBootstrapper.json` / `offlineInstaller.json` | `--config` 覆盖文件 |
| `install-smoke-final.ps1` / `bundle-matrix.ps1` | 可复跑脚本 |

复跑要点：在 `rust-app/` 下执行 Tauri CLI；先 `build --no-bundle` 再 `bundle`；安装烟测用 CreateProcess（避免 ShellExecute
安全警告）；**工作区 Low 完整性标签未清理前，安装/启动烟测必须把 exe 复制到工作区外普通目录再运行**（记录副本 sha256，
见 §6.2）；不要卸载/修改系统 WebView2 Runtime。