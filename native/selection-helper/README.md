# selection-helper（R0-04 原型）

独立进程版 Windows 划词钩子小样，用于回答计划 D04 / ADR-0002 的问题：
**把现有 C++ 核心（`vendor/selection-hook`）提取成独立 helper 的成本，是否低于用 Rust 重写？**

本目录是 **R0 证据原型**，不接入产品构建、不改 `vendor/selection-hook/`、不改
`main/services/selection-hook-host.js`。提取成本评估见
[`docs/plans/rust-migration/r0-hook-extraction.md`](../../docs/plans/rust-migration/r0-hook-extraction.md)。

## 结构

| 路径 | 作用 | 来源 |
|---|---|---|
| `src/main.cc` | CLI、DPI 感知、`WH_MOUSE_LL`/`WH_KEYBOARD_LL` 安装与消息循环、手势状态机、JSON Lines 输出、心跳、`--self-test`、错误路径 | 重新落位 `selection_hook.cc` 中的 hook/gesture/event 逻辑 |
| `src/retrieval_worker.{h,cc}` | MTA 取词线程：`CoInitializeEx(MTA)` + `CUIAutomation`、单 pending 请求、2 s 有界停止、值语义结果回调 | 替代 `vendor/core/worker.{h,cc}`（唯一含 Node-API 的核心文件） |
| `src/jsonl.h` | 线程安全的单行 JSON 输出与 UTF-8/转义工具 | 新增 |
| `build.ps1` | vswhere → vcvars64 → cl/link；`-Clean`、`-SelfTest` | 新增 |
| `test/real-selection.ps1` | 单目标真实选词自动化（原设计副屏窗口 + SendInput 拖选/双击） | 新增 |
| `test/real-selection-matrix.ps1` | 多应用真实选词矩阵驱动：Chrome/Edge（本地 HTML + 临时 profile）、Word/Excel（COM 创建）、资源管理器（临时目录 + 地址栏）、Notepad；真实 SendInput 手势、UIA/剪贴板双路径、驱动侧独立选择校验、`--force-renderer-accessibility` 行、helper Medium IL 预检 | 2026-11-11 新增 |
| `test/run-selection-matrix.ps1` | 一键重跑：`build.ps1 -Clean -SelfTest` 门禁 + helper IL 预检 + 逐行矩阵 + JSON 汇总 | 2026-11-11 新增 |

以下 vendor 文件 **原样编译**（0 行修改）：`core/engine.cc`、`lib/clipboard.cc`、
`lib/clipboard_transaction.cc`、`lib/transient.cc`、`lib/keyboard.cc`、
`lib/string_pool.cc`、`lib/utils.cc`（以及各头文件）。

## 构建

```powershell
# 需要 Visual Studio 2022 Build Tools（MSVC v143 + Windows SDK），脚本自行用 vswhere 定位
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/build.ps1 -Clean -SelfTest
```

产物：`native/selection-helper/build/selection-helper.exe` 与 `bin/selection-helper.exe`
（两者均已 gitignore）。编译参数：`/std:c++17 /EHsc /utf-8 /MT /DNOMINMAX`；链接
`uiautomationcore user32 ole32 oleaut32 oleacc shell32 gdi32`。

> `/DNOMINMAX` 与 `gdi32.lib` 来自 node-gyp 的 Windows 默认设置，`binding.gyp` 未列出；
> 独立构建必须自己补上，否则 `engine.cc:877` 的 `std::min` 与剪贴板图元备份链接失败。
> 这是提取成本中唯一的“隐藏构建耦合”项。
>
> **2026-11-11 本机补充**：受限宿主会话曾继承一个**缺结尾反斜杠**的 `VSINSTALLDIR`，导致
> `vcvars64.bat` 打印 `Could not find directory "...VC\"` 并把 `cl.exe` 留在 PATH 外。`build.ps1`
> 现在在临时 vcvars 导入脚本里显式 `set "VSINSTALLDIR=<vswhere 解析出的安装路径>\"`，避免该问题。
>
> **完整性级别**：若工作区根带有 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` 继承标签，
> 在这里构建出的 exe 会以 **Low IL** 运行，`WH_MOUSE_LL` 收不到发往 Medium IL 应用的输入（matrix 会
> 拒绝记录证据）。构建前用 `icacls <exe> | findstr /i Mandatory` 确认，必要时先修复工作区 ACL 再
> `-Clean` 重建。

## 运行

```powershell
bin/selection-helper.exe --help
bin/selection-helper.exe --self-test --duration-ms 1500
bin/selection-helper.exe --duration 30 --heartbeat-ms 1000
bin/selection-helper.exe --duration-ms 15000 --exit-after-selection
bin/selection-helper.exe --clipboard --mouse-events --keyboard-events --duration 10
```

退出码：`0` 正常；`1` 运行期错误；`2` UIA/COM 初始化失败；`3` 钩子安装失败；
`4` 参数错误；`5` self-test 失败；`6` `--exit-after-selection` 超时未选到词。

## JSON Lines 契约（原型，非产品合同）

stdout 每行一个 JSON 对象，立即 flush；stderr 只放人读诊断。

| `type` | 关键字段 |
|---|---|
| `helper-start` | `version`, `selfTest` |
| `status` | `status`（`dpi-awareness`/`started`/`stopping`/`stopped`/`self-test-pass`/`self-test-fail`） |
| `probe` | `foregroundHwnd`/`foregroundPid`/`foregroundProgram`、虚拟桌面尺寸、显示器数、双击时间 |
| `uia-ready` | `comInitialized`, `initializationHr`, `rootElementProbe`, `rootControlType`, `rootName` |
| `hook-ready` | `mouseHook`, `keyboardHook`, `win32Error` |
| `heartbeat` | `elapsedMs`, `hookRunning`, `autoRetrievals`, `retrievalsCompleted`, `selectionsFound`, `mouseEventsQueued/Dropped`, `keyboardEventsQueued`, `lastMouseEventAgoMs`, `lastKeyEventAgoMs` |
| `text-selection` | `sequence`, `detection`（`drag`/`double-click`/`shift-click`）, `found`, `text`, `textLength`, `textTruncated`, `sourcePid`, `sourceHwnd`, `program`, `method`（`1`=uia/`3`=msaa/`99`=clipboard）, `positionLevel`, 6 组坐标, `stage`, `retrievalElapsedMs` |
| `mouse-event` / `keyboard-event` | 仅在 `--mouse-events` / `--keyboard-events` 时输出 |
| `error` | `stage`, `exitCode`, `message`, `win32Error`, `hr` |

`--self-test` 判定：COM/UIA 初始化成功、`GetRootElement` 探针成功、两个低级钩子安装成功、
worker 2 s 内干净 join。真实选词不属于 self-test（需外部输入）。

## 真实选词验证

单目标（原脚本，设计上只放副屏；本机单屏会 exit 2 拒绝开窗）：

```powershell
# 副屏 Notepad + 真实双击（UIA 路径）
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Target Notepad -Gesture DoubleClick
# 副屏 Notepad + 真实拖选
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Target Notepad -Gesture Drag
# 本进程 RichTextBox + 真实拖选，强制走回退复制路径
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Target WinForms -Gesture Drag -Clipboard
```

多应用矩阵（2026-11-11 新增；可见窗口只放主屏，需显式 `-AllowPrimaryDisplay`：
用户已授权本轮证据使用主屏；窗口短时、结束关闭并恢复剪贴板）：

```powershell
# 一行一条；逐项记录 target/gesture/method(text)/耗时/sourcePid/program/驱动侧选择
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Chrome -Gesture Drag -BrowserA11y default -AllowPrimaryDisplay
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Chrome -Gesture Drag -BrowserA11y force -AllowPrimaryDisplay
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Edge -Gesture Drag -AllowPrimaryDisplay
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Word -Gesture Drag -AllowPrimaryDisplay
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Excel -Gesture Drag -Clipboard -AllowPrimaryDisplay
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection-matrix.ps1 -Target Explorer -Gesture Drag -AllowPrimaryDisplay

# 一键重跑（先 build.ps1 -Clean -SelfTest，再跑全部行，输出 PASS/FAIL 与 JSON 汇总）
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/run-selection-matrix.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/run-selection-matrix.ps1 -SkipBuild -Rows Chrome-force,Word,Excel-clipboard
```

矩阵脚本退出码：`0` 观察到选词、`1` helper 运行但未取到、`2` 无可用的显示/未授权主屏、
`3` helper 未启动、`4` 意外错误、`5` 目标准备/校准失败、**`7` helper 完整性级别不是 Medium（拒绝记录证据）**。
runner 退出码：`0` 全部行通过、`1` 有行失败、`2` 构建门禁失败、**`3` helper IL 预检失败**、`4` 参数错误。

结果 JSONL 追加到 `.tmp-r0-hook/matrix-results.jsonl`（gitignore），每行含 target/gesture/
clipboardFallback/browserA11y/helperIntegrity/found/method/methodName/text/textLength/stage/
retrievalElapsedMs/sourcePid/program/driverSelection/calibration/timings 等字段。

**2026-11-11 修复后实测（Medium IL helper）**：10 行中 9 行 PASS——Notepad（39 字符）、Chrome 默认/强制
a11y（各 15）、Edge 默认/强制 a11y（各 15）、Word（36，31 ms）、Excel 默认/`--clipboard`（各 29，16/32 ms）、
资源管理器双击选词（4），全部 `method=1 uia`；资源管理器**拖选**行因测试校准未建立选择而 FAIL（非 helper
缺陷，同窗口双击行通过）。证据：`.tmp-r0-hook/matrix-results.jsonl`、`matrix-run-summary.json`、
`matrix-run-final.log`。卡死恢复探针 `hang-recovery-test.ps1`（进程级 kill/重启通过；真实 provider 卡死
未复现）与管理员窗口负样本 `admin-negative-test.ps1`（UAC 经用户批准；UIPI 负样本符合预期）也在
`.tmp-r0-hook/`，属一次性证据脚本，不在本目录交付。

### 本机（2026-11-11）已验证的测试环境陷阱

1. **工作区 Low 完整性标签**：工作区根带 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` 时，
   构建出的 helper 以 Low IL 运行，UIPI 使其低级钩子收不到发往 Medium IL 应用窗口的注入输入
   （`hookReady:true` 但 `mouseEventsQueued=0`）。此时所有跨应用矩阵行都是环境伪失败；矩阵脚本
   在记录前强制校验 helper 进程 IL=Medium（否则 exit 7），runner 预检失败即 exit 3。
2. **helper 控制台窗口必须可见且不得移动/隐藏**：本机实测 `Start-Process -WindowStyle Hidden`、
   `-NoNewWindow`、或启动后 `ShowWindow(SW_HIDE)` / `MoveWindow` 其控制台窗口，都会让后续
   `WH_MOUSE_LL`/`WH_KEYBOARD_LL` 回调不再收到任何输入（3/3 可复现）。矩阵脚本以普通方式启动
   helper，并把目标窗口放在屏幕底部条带，避免 helper 控制台覆盖目标窗口。
3. **Chromium 默认不暴露 UIA 页面树**：默认启动时 UIA 只见地址栏 Edit（没有 Document/Text），加
   `--force-renderer-accessibility` 后才出现页面 Document/Text。因此矩阵对每个浏览器分
   “默认 a11y / 强制 a11y”两行；默认行预期走 MSAA/剪贴板回退。
4. **Word 受保护视图**：用 `Start-Process WINWORD.EXE file.rtf` 打开工作区临时文件可能进入
   “受保护的视图”（只读、UIA 行为不同）；矩阵改用 COM `Word.Application` 创建文档，不落盘、
   绕过受保护视图。Excel 同理用 COM 创建 workbook。
5. **资源管理器地址栏**：需要先用真实 `Ctrl+L` 进入编辑模式再拖选；矩阵脚本在目标已前台时注入
   Ctrl+L，并用 UIA 焦点元素矩形计算拖选坐标。

`test/real-selection.ps1` 与矩阵脚本都只用自己启动/打开的窗口和进程；结束时关闭窗口、删除临时
文件（Chrome/Edge 临时 profile 也位于 `.tmp-r0-hook/`）、按原文本恢复剪贴板。helper 输出与
stderr 落在 `.tmp-r0-hook/`（gitignore）。

## 边界

- 原型：没有配置面（18 个 JS 方法/6 个事件里的设置项）、没有 Electron utility process
  消息协议、没有 Rust 宿主；`getCurrentSelection()` 同步 API 未实现。
- **clipboard coordinator（命名管道 lease）客户端未实现**：helper 的 `CoordinatorConfig` 保持
  `required=false`，剪贴板回退不做租约握手（`vendor/.../lib/transient.cc?required=false` 恒授权）。
  与 `native/clipboard` 的协议级互通证据（脚本协议客户端）见
  [`docs/plans/rust-migration/r0-hook-extraction.md`](../../docs/plans/rust-migration/r0-hook-extraction.md)
  §4.11；**该证据不是 helper↔native/clipboard 联调**，R3 必须补客户端或明确禁用回退。
- `--simulate-failure=uia|hook` 只用于演示错误分支的退出码与 JSON 事件，**不是**真实
  COM/钩子失败；真实 UIA 初始化失败未复现。
- 2026-11-11 环境修复（工作区 Low→Medium）后已完成真机应用矩阵重跑：10 行中 9 行 PASS（真实 SendInput
  手势，全部 `method=1 uia`；唯一 FAIL 为资源管理器拖选行的测试校准问题）。矩阵的 Medium IL 预检保留，
  环境回退时会拒绝记录。真实 provider 卡死仍未复现，管理员窗口只有 UIPI 负样本。
- 不修改 `vendor/selection-hook/`，不 `npm install`，不接入 Electron 构建。
