# R0-07 安装/分发矩阵（NSIS 测试包 + WebView2 模式）

日期：2026-11-11（Asia/Hong_Kong）。分支 `codex/rust-r0-baseline-contracts`，基线 HEAD `7c45a7b`（本文件写作时工作区另有 R0-07 打包配置、driver-spike 测试开关等未提交改动，由 Lead 统一提交）。
状态：**R0 证据文档（安装/卸载烟测阻塞；其余部分完成，未验证项见 §10）**。上位文档：
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

> 与 [handoff.md](handoff.md) §2 的旧机器（Ryzen 7 9850X3D / 47 GiB / 双屏 / F:）**不同**；本矩阵一律以当前机器为准（用户已确认）。

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

## 6. 安装/卸载烟测（**阻塞，未通过；不得写成已验证**）

计划链路：`setup.exe /S`（per-user，不提权）→ 核对 `%LOCALAPPDATA%\Highlighter R0 Window Prototype` 文件清单、
HKCU Uninstall 注册项、开始菜单快捷方式 → 运行已安装 exe `--self-test`（单屏无 env 预期 exit 2；
`HIGHLIGHTER_R0_ALLOW_PRIMARY=1` 时预期 PASS exit 0）→ 缺失 WebView2 探针 → `uninstall.exe /S` → 目录/注册项清理。

### 6.1 已实测的失败/阻塞证据

1. **未签名安装包经 ShellExecute 启动会弹阻塞式安全警告**：用 `Start-Process`（ShellExecute）启动安装包时，
   出现 `#32770` 对话框“打开文件 - 安全警告”（无发布者），进程等待人工确认；自动化必须改用 CreateProcess
   （`.NET ProcessStartInfo.UseShellExecute=false` 或 `&` 调用）。该现象对最终用户双击安装同样是风险 → 发布必须签名（R8-02）。
2. **静默安装不落盘（未解决）**：CreateProcess 直接执行 `setup.exe /S`，**退出码 0、耗时 144 ms，但**：
   - `%LOCALAPPDATA%\Highlighter R0 Window Prototype` 不存在；
   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall` 无本产品键；
   - 开始菜单无 `Highlighter R0 Window Prototype.lnk`；无 `uninstall.exe`。
   用 `/S /D=<无空格临时路径>` 重复，结果相同。被动模式 `/P` 进程挂起（线程 `WaitReason=UserRequest`，
   MainWindowHandle 标题为 `Highlighter R0 Window Prototype Setup`，但无可枚举可见窗口），已终止。
3. 已排除：安装包路径带空格/参数未传入（`/D=` 无空格路径同样无落盘）；安装包 payload 损坏（7z 可完整提取应用 exe 与插件）。
   仍待验证的候选原因：WebView2 段提前 `Abort`（静默 Abort 退出码为 0）、NSISdl/网络路径、Restart Manager 运行中检查、
   currentUser 安装模式/权限上下文。**下一步**：用 `cmd /c` 捕获 NSIS 静默 Abort 的 AttachConsole 输出、
   用 embedBootstrapper/offlineInstaller 产物对照、交互模式观察向导页，定位后重跑完整链路。

4. **交互式向导可以正常显示**（说明安装包本身可运行）：直接启动安装包（无参数）后 3 s 内出现可见向导窗口
   `#32770` “Highlighter R0 Window Prototype Setup”；UIA 读到 “Choose Install Location” 页，目标目录
   `C:\Users\24532\AppData\Local\Highlighter R0 Window Prototype`、`Space required: 8.5 MB`。
   自动化点击 “Next >” 未完成：NSIS MUI 的按钮在 UIA 中暴露为 `ControlType.Pane`（无 InvokePattern），本轮时间窗内
   未完成自动点击安装，随后关闭向导（未绕过安全机制、未改系统设置）。
5. **对照实验（排除安装包 payload 缺陷）**：用同一 NSIS 3.13 现场编译一个最小 per-user 安装器
   （`RequestExecutionLevel user`、`InstallDir "$LOCALAPPDATA\R07MinimalNsisTest5"`、写文件+注册表+卸载器），
   `/S` 运行同样“退出码 0 但目录/注册表均未创建”；说明本机**当前受限会话**下 NSIS 安装器无法完成落盘
   （环境/系统级限制），不是本安装包特有的缺陷。证据：`.tmp-r07/install/nsis-min-test/`、
   `.tmp-r07/install/logs/child-groups.txt`（子进程完整性级别 = Medium Mandatory Level，排除 Low IL 解释）。
   > 未继续深挖/绕过（Lead 明确要求：不得为了通过而绕过安全提示或修改系统安全设置）；完整安装链路需真实桌面会话复测。

### 6.2 已确认的安装包内容（非安装结果）

- 7z 提取最终 downloadBootstrapper 安装包得到应用 exe：8,928,768 B，sha256 `36AE37CC447C28C467B648DB5C543DEA644B654121D58931BBB47233BD7F3ADB`；
- 安装包内无测试驱动/端点文件（见 §4）。

### 6.3 待补（未验证）

- 安装目录完整文件清单、HKCU Uninstall 键各字段（DisplayName/DisplayVersion/Publisher/InstallLocation/UninstallString/EstimatedSize）、
  开始菜单快捷方式、已安装 exe 的 sha256/签名；
- 已安装 exe `--self-test`（无 env → exit 2；`HIGHLIGHTER_R0_ALLOW_PRIMARY=1` → 单屏主屏窗口 + PASS exit 0）；
- 已安装 exe + 空 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`（无 env / 有 env 两种情况）；
- `uninstall.exe /S` 后的目录/注册项/快捷方式清理与残留检查。

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
3. R0-03 已安装 exe 的同类探针（无 env 预期 exit 2；`HIGHLIGHTER_R0_ALLOW_PRIMARY=1` 时先出加载器对话框、点确定后
   `[FAIL] startup code=window-create-failed`、exit 2）**尚未执行**，依赖 §6 安装问题解决；届时补入本节。

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
3. **安装→启动→卸载链路未验证（阻塞）**：本机 `/S` 静默安装 exit 0 但不落盘、`/P` 挂起；用同版本 NSIS 现场编译的最小
   per-user 安装器对照同样不落盘，判定为当前受限会话/宿主环境的系统级限制（不是安装包 payload 缺陷）；交互向导可显示到
   “Choose Install Location” 页但本轮未完成自动点击。因此 §6.3 全部为未验证项，不得在 G0 报告中写成通过。
4. 缺失 WebView2 的失败行为已实测（同栈探针 + release exe 应用级探针）：加载器阻塞对话框 + 探针退出码 3 / 应用退出码 2；
   产品必须做启动前检测与引导。
5. fixedRuntime 仅完成文档评估（成本/更新责任），未实测。
6. G0 仍未通过；本文件只补齐 R0-07 的部分证据（产物矩阵、版本冻结、缺失 Runtime 行为），完整安装矩阵与
   WebView2 多版本矩阵仍需真实测试机/用户桌面会话。

## 10. 未验证项（不得写成通过）

- [ ] 安装/卸载全链路（§6.3）：目录、注册项、快捷方式、已安装 exe 启动、卸载清理。
- [ ] 本机受限会话下 NSIS 安装器不落盘的环境级根因（最小安装器对照同样复现；需真实桌面会话复测，不在本轮绕过系统安全机制）。
- [ ] 已安装 exe 的 `--self-test`（单屏无 env / `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`）与缺失 WebView2 行为。
- [ ] 静默安装不落盘的根因与修复验证（当前候选原因见 §6.1）。
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
4. **per-user 安装**：本轮配置为 `nsis.installMode=currentUser`（默认），安装目录 `%LOCALAPPDATA%\<productName>`、
   HKCU Uninstall；不需要管理员权限。R8-02 若要求 per-machine，需要单独验证提权/多用户/卸载行为。
5. **测试端点隔离**：安装包 payload 已确认不含 `msedgedriver`/`tauri-driver`；安装后文件清单仍需补测（§6.3）。
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
| `logs/install-smoke-final-downloadBootstrapper.log` | 安装烟测（v2，CreateProcess）观察记录（含失败证据） |
| `logs/release-exe-missing-wv2-allow-primary.out.txt` | release exe + ALLOW_PRIMARY + 空 WebView2 目录的应用级探针输出（exit 2） |
| `logs/child-groups.txt` | 子进程完整性级别（Medium，排除 Low IL 解释） |
| `nsis-min-test/` | 同版本 NSIS 最小 per-user 安装器对照（同样不落盘，用于排除安装包缺陷） |
| `logs/silent-console-capture.txt` | 静默安装控制台捕获尝试（命令失败记录） |
| `logs/tauri-installer-nsi.txt` / `tauri-utils-nsh.txt` | tauri-cli v2.12.4 NSIS 模板/工具宏（排障与逻辑核对） |
| `artifacts/<mode>/` | 最终安装包副本（与 `rust-app/target/release/bundle/nsis/` 相同） |
| `artifacts-preallowprimary/` | 旧二进制（不含 ALLOW_PRIMARY 开关）产物，仅历史对照 |
| `config/embedBootstrapper.json` / `offlineInstaller.json` | `--config` 覆盖文件 |
| `install-smoke-final.ps1` / `bundle-matrix.ps1` | 可复跑脚本 |

复跑要点：在 `rust-app/` 下执行 Tauri CLI；先 `build --no-bundle` 再 `bundle`；安装烟测用 CreateProcess（避免 ShellExecute
安全警告）；不要卸载/修改系统 WebView2 Runtime。