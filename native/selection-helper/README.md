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
| `test/real-selection.ps1` | 副屏真实选词自动化（副屏窗口 + SendInput 拖选/双击） | 新增 |

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

```powershell
# 副屏 Notepad + 真实双击（UIA 路径）
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Target Notepad -Gesture DoubleClick
# 副屏 Notepad + 真实拖选
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Target Notepad -Gesture Drag
# 本进程 RichTextBox + 真实拖选，强制走回退复制路径
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Target WinForms -Gesture Drag -Clipboard
```

脚本只用副屏，结束时关闭自己打开的窗口/进程；helper 输出与 stderr 落在 `.tmp-r0-hook/`（gitignore）。

## 边界

- 原型：没有配置面（18 个 JS 方法/6 个事件里的设置项）、没有 Electron utility process
  消息协议、没有 Rust 宿主；`getCurrentSelection()` 同步 API 与 clipboard coordinator
  （命名管道 lease）未实现。
- `--simulate-failure=uia|hook` 只用于演示错误分支的退出码与 JSON 事件，**不是**真实
  COM/钩子失败；真实 UIA 初始化失败未复现。
- 不修改 `vendor/selection-hook/`，不 `npm install`，不接入 Electron 构建。
