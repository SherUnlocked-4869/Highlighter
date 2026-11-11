# R0-04 划词钩子独立 helper 提取小样（ADR-0002 证据：提取成本 vs 重写）

- 状态：**原型完成 + 2026-11-11 补测完成（宿主工作区 Low 完整性标签已修复并重跑）；G0 未通过。修复后真机应用矩阵 9/10 行 PASS（§4.9）、管理员窗口取得 UIPI 负样本（§4.14）、卡死恢复仅进程级通过且真实 provider 卡死未复现（§4.13）；lease 协议级互通见 §4.11（helper 端无客户端，非联调）。本文不是 gate 通过的证据，也不构成 ADR-0002 的最终冻结。**
- 决定批次：R0-04（计划 §2 D04、§7 R0-04、§8 G0；[r0-baseline.md](r0-baseline.md) §4.2）
- 实施批次候选：R3（划词/剪贴板，见计划 §7）
- 日期：2026-11-10 首版；**2026-11-11 续测完成**（Asia/Hong_Kong）
- 证据代码：`native/selection-helper/`（新增 7 个文件 + gitignore 的 `build/`、`bin/`）；2026-11-11 新增 `test/real-selection-matrix.ps1`、`test/run-selection-matrix.ps1`
- 证据日志：`.tmp-r0-hook/`（gitignored，不提交；含 `LOW-IL-CONTAMINATION.md` 污染登记）
- 代码基线：分支 `codex/rust-r0-baseline-contracts`，2026-11-11 续测时 HEAD `a2a87e3`；**`vendor/selection-hook/` 未改动（0 行）**
- 关联模板：[ADR-0000 模板](adr/0000-template.md)

---

## 1. 背景与问题

计划 §2 的 **D04** 决定：*"划词优先提取 C++ 独立 helper，替换 N-API 宿主；提取成本高于重写且行为夹具完备时，再选择 Rust 钩子实现。"* 本小样的任务是把这个"优先"变成可审阅的成本证据。

现状（源码事实，行数实测）：

| 部分 | 文件 | 行数 | 说明 |
|---|---|---:|---|
| N-API 包装 + hook 线程 + 手势/事件 + 配置 | `vendor/selection-hook/src/windows/selection_hook.cc` | 1,915 | 196 行命中 `Napi::`/`napi_`；N-API 仅存在于这个文件和 `core/worker.*` |
| UIA → MSAA → 剪贴板取词引擎 | `core/engine.{h,cc}` + `core/types.h` | 893 + 156 + 268 | 0 处 N-API；线程亲和（UIA client 必须与其 COM apartment 同线程） |
| 剪贴板事务/租约/键盘/工具 | `lib/*.cc` + `lib/*.h`（6 + 7 文件） | 992 + 281 | 0 处 N-API |
| 自动取词 MTA 线程 + TSFN 交接 | `core/worker.{h,cc}` | 454 + 76 | **唯一 Node 绑定的核心文件**：`napi_threadsafe_function` 结果回传、生命周期依赖 Node env |
| JS API/事件/配置面 | `index.js` | 689 | 18 个实例方法、6 类事件、start 配置项；`main/services/selection-hook-host.js` 把它包进 Electron utility process |

问题：**本分支的 Rust 进程不能直接消费 `.node` addon**（调研 §6.3；计划 D04 的前提）。因此要么保留一个可被 Rust 宿主拉起的独立 helper（方案 A），要么用 Rust 重写取词/手势/剪贴板事务（方案 B），要么短期保留 Node sidecar（方案 C，违反 D08 终态）。

本小样的判定问题：**A 的提取边界在哪、代价是多少？A 与 B 的成本差是否足以支撑"提取优先"？**

---

## 2. 备选方案

| 方案 | 描述 | 优点 | 代价/风险 |
|---|---|---|---|
| **A 提取 C++ 独立 helper** | 把 `engine + lib` 原样编译进 `selection-helper.exe`；用独立进程替代 N-API 宿主；Rust 宿主用进程协议拉起 | 兼容逻辑零改写、复用 2,590 行经过真机验证的 C++；COM/UIA 继续隔离在 helper 进程；崩溃可整进程回收；与现有 utility process 隔离模型同构 | 需重做协议（JSONL/管道/心跳）、需产品化配置面与 18 方法/6 事件语义、C++ 维护面保留、helper 计划/打包/签名 |
| **B Rust 重写钩子** | 用 Rust（`windows` crate / COM）重写 UIA→MSAA→剪贴板事务、hook 线程、手势与过滤 | 终态纯 Rust；无跨语言进程协议 | 需重写约 3,000 行兼容关键 C++（含大量 issue 驱动的守卫逻辑）；没有行为夹具库，只能靠 14 个现有 JS 测试 + 真机矩阵；UIA/COM/剪贴板事务等价风险高 |
| **C 保留 Node sidecar** | 继续用现有 addon，Rust 通过 Node sidecar 调用 | 0 改动 | 运行环境仍含 Node，直接违反计划 D08 / G3；只能作为登记了退出批次的临时方案 |

---

## 3. 实测条件与命令

### 3.1 环境

| 项 | 实测值 | 来源 |
|---|---|---|
| OS | Windows 11 专业版 build `26300.9711` | [r0-baseline.md](r0-baseline.md) §1.2 |
| CPU / 内存 | AMD Ryzen 7 9850X3D（8C/16T，4700 MHz）/ 约 47.2 GiB | 同上 |
| 显示器 | 主屏 `(0,0)` 3840×2160 @150%；副屏 `(3840,-170)` 1440×2560 @**125%**（混合 DPI，负 Y） | R0-03 更正，见 [r0-window-prototype.md](r0-window-prototype.md) |
| 编译器 | MSVC `19.44.35228` x64（Visual Studio 2022 Build Tools `17.14.36`，vswhere 定位 `D:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`） | 本次构建输出 |
| Windows SDK | 随 Build Tools 安装（`vcvars64.bat` 初始化 INCLUDE/LIB） | 本次构建 |
| helper DPI 感知 | `SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE)` = per-monitor v1（**与 addon 相同**，`selection_hook.cc:1857`） | helper `status:dpi-awareness` 事件 |
| 自动化驱动 DPI 感知 | per-monitor v2（`SetProcessDpiAwarenessContext(-4)`），保证 SendInput 用物理像素 | `test/real-selection.ps1` |
| 电源方案 | 平衡（未冻结，仅功能验证，不用于性能结论） | `r0-baseline.md` §1.2 |
| 运行环境变量 | `ELECTRON_RUN_AS_NODE=1`（与本任务无关；helper 不启动 Electron/Node） | 本机 |

### 3.2 可复现命令

```powershell
# 构建（脚本自行用 vswhere 找 Build Tools、vcvars64 导入环境；无需预开 VS 命令行）
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/build.ps1 -Clean -SelfTest

# 启动/退出/心跳/错误码
native/selection-helper/bin/selection-helper.exe --self-test --duration-ms 1500
native/selection-helper/bin/selection-helper.exe --duration 30 --heartbeat-ms 1000
native/selection-helper/bin/selection-helper.exe --exit-after-selection --duration-ms 15000

# 真实选词（副屏窗口 + SendInput 真手势；helper JSONL 落 .tmp-r0-hook/）
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Target Notepad -Gesture DoubleClick
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Target Notepad -Gesture Drag
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/real-selection.ps1 -Target WinForms -Gesture Drag -Clipboard
```

数据：Target 的文本由 `test/real-selection.ps1` 写入 `.tmp-r0-hook/real-selection-target.txt` 或内存 RichTextBox；**不含任何真实用户数据/凭据**。helper 只读当前选中文本，不写盘。剪贴板回退会备份/恢复全部剪贴板格式（生产事务，见 §4.4.3 的恢复校验）。

---

## 4. 证据

### 4.1 提取边界（哪些能原样复用）

| 处置 | 文件 | 行数 | 说明 |
|---|---|---:|---|
| **原样复用（0 行修改）** | `core/engine.h`、`core/engine.cc`、`core/types.h`、`lib/{clipboard,clipboard_transaction,transient,keyboard,string_pool,utils}.cc`、`lib/{clipboard,clipboard_policy,clipboard_transaction,keyboard,string_pool,transient,utils}.h` | **2,590**（16 文件） | 直接以 vendor 路径编译进 helper；`grep` 实测 0 处 `Napi::`/`napi_` |
| **必须替换** | `core/worker.h`、`core/worker.cc` | 530（76 + 454） | 唯一 Node 绑定核心：`napi_threadsafe_function` 结果回传 + Node env 清理/放弃线程语义；helper 用 `src/retrieval_worker.{h,cc}`（465 行）替换，保留 COM MTA、就绪握手、单 pending 槽、2 s 有界停止、stage 诊断 |
| **逻辑重落位** | `src/windows/selection_hook.cc` | 1,915（196 行 N-API 命中） | N-API ObjectWrap/参数校验/TSFN/环境清理约 685 行不可复用；hook 线程、手势判定、事件分发、DPI、`SHQueryUserNotificationState` 等约 835 行逻辑按语义重写为 `src/main.cc`（1,374 行，含 CLI/JSONL/心跳/self-test 等原型设施） |
| 新增构建/验证 | `build.ps1`、`test/real-selection.ps1`、`README.md` | 200 / 399 / ~140 | 可复跑 |

**结论（边界事实）**：提取只需要重写 **530 行 N-API 线程交接 + 约 835 行宿主胶水**；**2,590 行兼容关键逻辑（UIA/MSAA/剪贴板事务/背压/输入序列守卫）零改动复用**。`vendor` 修改 0 行。

#### 4.1.1 N-API 耦合点清单（逐处）

| 文件:行（实测） | 耦合内容 | helper 替换方式 |
|---|---|---|
| `core/worker.h:10` | `#include <napi.h>` | 删除，`retrieval_worker.h` 无 N-API |
| `core/worker.h:49` / `:71` | `napi_threadsafe_function resultTsfn` / `workerTsfn` 参数 | 改为 `std::function` 值语义 sink |
| `core/worker.cc:95-99` | `napiMutex` + `std::atomic<napi_threadsafe_function>` 状态 | 删除；仅保留原生状态 |
| `core/worker.cc:114-156` | `napi_acquire/release_threadsafe_function` 启动/失败路径 | `Start()` 只做线程 + 就绪握手 |
| `core/worker.cc:216-225` | `Stop()` 中 `napi_tsfn_abort`（先断回调再等待） | `Stop()` 直接置 stop 标志并 join/有界放弃 |
| `core/worker.cc:274` | `ThreadMain(..., napi_threadsafe_function)` 签名 | 去掉参数 |
| `core/worker.cc:407-415` | `napi_call_threadsafe_function(..., napi_tsfn_nonblocking)` 结果投递 | 直接调用 sink（helper 结果在 worker 线程输出 JSONL） |
| `core/worker.cc:429-433` | 线程退出前 `napi_release_threadsafe_function` | 删除 |
| `core/worker.cc:443-454` | `PinCurrentModule()`（放弃线程时钉住 addon 模块） | 删除；独立进程退出即回收（见 §4.5 恢复证据） |
| `selection_hook.cc:45` / `:152-155` | `#include <napi.h>` / `Napi::ObjectWrap<SelectionHook>` | 改为普通 `main()` + 全局单实例状态 |
| `selection_hook.cc:213-214` | `Napi::ThreadSafeFunction mouse_tsfn/keyboard_tsfn` | 改为 `EventQueue`（512/128 上限）+ 自动复位事件 |
| `selection_hook.cc:467-502` / `:1896-1915` | `Init`/`NODE_API_MODULE` 导出 | 无 |
| `selection_hook.cc:528-539` / `:1815` / `:1842` | 三个 TSFN 创建与 `NonBlockingCall` | hook 回调改为短临界区入队 + `SetEvent`（钩子回调不得阻塞） |
| `selection_hook.cc:1408-1450` / `:1468-1502` | 自动结果 TSFN 创建/`CallSelectionResultJs`/finalize/generation 校验 | sink 直接输出；generation 仅单会话（1） |
| `selection_hook.cc:413-466` | Node env cleanup hook（LIFO 顺序、关停时 abort TSFN） | 无；`Stop()` 顺序固定（hook → worker → 退出） |
| `selection_hook.cc:655-698` / `:699-964` | 同步 `getCurrentSelection()` 与 14 个配置 setter（STA UIA client、参数校验、数组解析） | **未实现**（原型只覆盖自动取词；见 §6） |

实测统计（`grep -cE 'Napi::|napi_'` 命中行）：`selection_hook.cc` 196、`worker.cc` 15、`worker.h` 3；`engine.cc`、`types.h`、全部 `lib/*` **均为 0**。

#### 4.1.2 `binding.gyp` 之外的隐式构建耦合（提取成本的一部分）

两个真实构建失败（原文记录）：

1. **`/DNOMINMAX`**：`engine.cc(877): error C2589: “(”:“::”右边的非法标记` + `C2059` + `C2737`（`std::min` 被 `windows.h` 的 `min` 宏破坏，`const DWORD wait = std::min(...)`）。node-gyp 的 Windows 默认 defines 带 `NOMINMAX`，`binding.gyp` 自己不写；独立构建必须补 `/DNOMINMAX`。
2. **`gdi32.lib`**：链接期 `clipboard.obj : error LNK2019: 无法解析的外部符号 __imp_DeleteEnhMetaFile / __imp_GetEnhMetaFileBits / __imp_SetEnhMetaFileBits`（`RestoreClipboard`/`BackupClipboard` 的图元文件格式备份）。node-gyp 默认链接 gdi32，`binding.gyp` 只列 `uiautomationcore.lib`/`user32.lib`。
3. 其它：`/std:c++17`、`/EHsc`（gyp 显式 `/EHsc`）；独立 EXE 用 `/MT` 静态运行库（addon 用 node-gyp 默认 `/MD`，由 Electron 提供 vcruntime）。

### 4.2 构建证据

```text
$ powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/build.ps1 -Clean -SelfTest
selection-helper build: configuration=Release
  vswhere   : D:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools
  vcvars64  : ...\VC\Auxiliary\Build\vcvars64.bat
  compiler  : 用于 x64 的 Microsoft (R) C/C++ 优化编译器 19.44.35228 版
  cl        : main.cc / retrieval_worker.cc / engine.cc / clipboard.cc /
              clipboard_transaction.cc / transient.cc / keyboard.cc /
              string_pool.cc / utils.cc            (9 个编译单元)
  output    : native/selection-helper/build/selection-helper.exe (306176 bytes)
  output    : native/selection-helper/bin/selection-helper.exe
  self-test : PASS
selection-helper build: OK
```

| 项 | 实测 |
|---|---|
| clean build + self-test 总耗时 | **6.4 s**（其中 self-test 1.5 s；纯构建约 5 s） |
| 编译单元 | 9（2 新增 + 7 vendor 源文件） |
| 产物 | `selection-helper.exe` 306,176 B，`sha256 6fca8bc3a04a39c3f7b46432e6ff426243d9f219cf1c66ad14c4e5344e9eaba6`（一次构建样本；PE 时间戳会使哈希随重建变化） |
| 可复跑性 | `-Clean` 重跑成功；构建脚本只依赖 vswhere/vcvars64/cl/link，无 npm、无 Node |

### 4.3 启动、退出与错误路径证据

self-test 关键 JSON（stdout，逐行 flush；`pid`/时间戳为当次值）：

```json
{"type":"status","status":"dpi-awareness","mode":"per-monitor-v1","hr":"0x0"}
{"type":"probe","virtualScreenX":0,"virtualScreenY":-170,"virtualScreenWidth":5280,"virtualScreenHeight":2560,"monitorCount":2,"doubleClickTimeMs":500}
{"type":"uia-ready","comInitialized":true,"initializationHr":"0x0","rootElementProbe":true,"rootControlType":50033,"rootName":"桌面 1","workerError":""}
{"type":"hook-ready","mouseHook":true,"keyboardHook":true,"win32Error":0}
{"type":"heartbeat","elapsedMs":1000,"hookRunning":true,"autoRetrievals":0,"retrievalsCompleted":0,"selectionsFound":0}
{"type":"status","status":"self-test-pass","comUiaInit":true,"rootElementProbe":true,"mouseHook":true,"keyboardHook":true,"workerCleanStop":true,"selectionSeen":false,"uptimeMs":1500,"exitCode":0}
```

`uia-ready` 不只是 `CoCreateInstance` 成功：worker 线程还调用了 `IUIAutomation::GetRootElement` 并读到根元素（控件类型 50033 = Desktop、名称"桌面 1"），证明 UIA 客户端真的连上了 broker。`hook-ready` 两个低级钩子均为 true（`SetWindowsHookEx` 失败会带 Win32 错误码）。

退出码矩阵（`.tmp-r0-hook/exit-codes.txt`，最终二进制实测）：

| 命令 | exit | 最后一行事件 |
|---|---:|---|
| `--self-test --duration-ms 1500` | **0** | `status:stopped` / `exitCode:0` |
| `--duration 0.5`（小数秒） | 0 | `status:stopped`（516 ms 后退出） |
| `--duration abc` | **4** | 打印 usage（参数错误） |
| `--bogus` | **4** | 打印 usage |
| `--simulate-failure=uia` | **2** | `error{stage:"uia-init",exitCode:2}` + `status:self-test-fail` |
| `--simulate-failure=hook` | **3** | `error{stage:"hook-install",exitCode:3}` + `status:self-test-fail` |
| `--simulate-failure=bogus` | 4 | 参数错误 |
| `--exit-after-selection --duration-ms 800`（无输入） | **6** | `status:stopped{selectionSeen:false,exitCode:6}` |
| `--help` | 0 | usage |

> 诚实标注：`--simulate-failure` 是**注入的错误分支**（用于演示退出码与 JSON 错误事件），不是真实 COM/钩子失败。真实的 UIA 初始化失败（如 Web Station/COM 不可用）与 `SetWindowsHookEx` 被拒（如受限桌面/注入防护）本轮**未复现**。

### 4.4 真实选词证据（副屏 + 真实鼠标输入）

方法：自动化脚本在副屏打开目标窗口（Notepad 或本进程 RichTextBox），启动 helper，等待 `status:started`，用 `SendInput`/`mouse_event` 产生**真实鼠标手势**（不是把选中文本喂给 helper）；helper 的 `WH_MOUSE_LL` 钩子看到真实事件后走 vendor 取词管线。可见窗口只放副屏（`(3840,-170)` 区域），结束由脚本关闭。

| # | 目标 | 手势 | 命中路径 | 结果 | 证据 |
|---|---|---|---|---|---|
| 1 | Windows 11 Notepad（真实文件窗口，副屏） | 双击 `04`（事件时间间隔 <500 ms） | `method=1` **uia**，`positionLevel=3 full` | **PASS**，text=`"04"`，sourcePid/hwnd=Notepad | `.tmp-r0-hook/final-Notepad-DoubleClick.log` |
| 2 | Windows 11 Notepad | 拖拽 4000→4320（距离 320 px） | `method=1` **uia**，`positionLevel=3 full` | **PASS**，text=`"0-04 selection helper probe line one\r"` | `.tmp-r0-hook/final-Notepad-Drag.log` |
| 3 | 本进程 WinForms RichTextBox（副屏） | 拖拽 3977→4707 | `method=99` **clipboard 回退**（UIA/MSAA 无结果后） | **PASS**，text=`"R0-04 selection helper probe line one"`，回退耗时 140 ms | `.tmp-r0-hook/final-WinForms-Drag-Clipboard.log` |
| 负样本 | 同一 WinForms RichTextBox | 拖拽（未开 `--clipboard`） | `method=0 none`，stage=complete，16 ms | **FAIL**（UIA 路径对该控件取不到文本；改走回退后 PASS） | `.tmp-r0-hook/final-WinForms-Drag.log` |

成功样本原始 JSON（节选，坐标即 UIA 返回的物理屏幕坐标）：

```json
{"type":"text-selection","detection":"double-click","found":true,"textLength":2,"text":"04","sourcePid":2744,"sourceHwnd":"0x1320ad2","program":"Notepad.exe","method":1,"methodName":"uia","positionLevel":3,"positionLevelName":"full","startTop":{"x":4018,"y":103},"startBottom":{"x":4018,"y":147},"endTop":{"x":4038,"y":103},"endBottom":{"x":4038,"y":147},"mouseStart":{"x":4020,"y":120},"mouseEnd":{"x":4020,"y":120},"stage":"complete","retrievalElapsedMs":16}
{"type":"text-selection","detection":"drag","found":true,"textLength":37,"text":"0-04 selection helper probe line one\r","sourcePid":40168,"sourceHwnd":"0xa0b88","program":"Notepad.exe","method":1,"methodName":"uia","positionLevel":3,"positionLevelName":"full","startTop":{"x":4000,"y":103},"startBottom":{"x":4000,"y":147},"endTop":{"x":4318,"y":103},"endBottom":{"x":4318,"y":147},"mouseStart":{"x":4000,"y":120},"mouseEnd":{"x":4320,"y":120},"stage":"complete","retrievalElapsedMs":0}
{"type":"text-selection","detection":"drag","found":true,"textLength":37,"text":"R0-04 selection helper probe line one","sourcePid":35052,"sourceHwnd":"0x9c0b96","program":"powershell.exe","method":99,"methodName":"clipboard","positionLevel":2,"positionLevelName":"mouse-dual","mouseStart":{"x":3977,"y":62},"mouseEnd":{"x":4707,"y":62},"stage":"complete","retrievalElapsedMs":140}
```

#### 4.4.1 手势/钩子事件证据

- 鼠标事件（`--mouse-events`，Notepad 双击）：`mouse-down → mouse-up → mouse-down → mouse-up`，坐标与事件一致；hook 只在手势成立时触发一次取词（heartbeat `autoRetrievals:1`）。
- 键盘钩子（`--keyboard-events`，注入无副作用的 `VK_F24` 两次）：4 条 `keyboard-event`（down/up ×2），`uniKey:"F24"`、`vkCode:135`、`flags:16/144`，证明 `WH_KEYBOARD_LL` 与 `convertKeyCodeToUniKey` 路径工作，且 `ObserveInput` 输入序列被更新（剪贴板事务守卫依赖它）。
- 手势判定逻辑与 addon 一致（`MIN_DRAG_DISTANCE=8`、`MAX_DRAG_TIME=8000 ms`、双击距离 ≤3 + `GetDoubleClickTime()`、Shift+Click、窗口未移动），来自 `selection_hook.cc:74-77`、`ProcessMouseEvent`。

#### 4.4.2 回退复制的安全性校验

`WinForms -Clipboard` 运行前后用 `Get-Clipboard -Raw` 对比：`beforeLen=5 afterLen=5 restored=True`。即 helper 的裁剪板事务（备份全部格式 → 清空 → 合成复制 → 读取 → 受守卫恢复）在真实拖选上完成了 **备份/恢复闭环**；退出后剪贴板内容与运行前一致。

#### 4.4.3 进程/窗口清理

- 每次运行后：`Get-Process notepad,selection-helper` 为空；自动化脚本在 `finally` 中关闭自己创建的窗口/进程。
- 崩溃恢复（真实）：启动 helper（60 s）→ `Stop-Process -Force` 杀进程 → 残留 `selection-helper` 进程数 **0** → 立即重跑 `--self-test --duration-ms 1500` **exit 0**。说明进程隔离模型下"杀掉即回收、可重启"成立；**不代表**对 UIA provider 卡死的真实恢复已验证（见 §4.5）。

### 4.5 失败分支与恢复

| 分支 | 本轮证据 | 判定 |
|---|---|---|
| 构建失败（缺 `NOMINMAX` / 缺 gdi32） | 见 §4.1.2，错误原文 C2589/C2059/C2737、LNK2019×3；补齐后 0 警告失败 | **通过（真实遇到并修复）** |
| UIA/COM 初始化失败 | 仅 `--simulate-failure=uia` 注入（exit 2 + error 事件）；真实失败**未复现** | 路径有、真实条件**未验证** |
| 钩子安装失败 | 仅 `--simulate-failure=hook` 注入（exit 3）；`SetWindowsHookEx` 真实拒绝**未复现** | 路径有、真实条件**未验证** |
| 取词超时/无选词 | `--exit-after-selection --duration-ms 800` 真实跑 → exit 6 + `selectionSeen:false`；WinForms UIA 负样本 `found:false`（stage=complete，16 ms） | **通过（真实）** |
| 取词卡死恢复（provider 不返回） | 代码路径：worker `Stop()` 2 s 有界等待 → 打印 `selection worker stop timed out` → detach + 计数（`retrieval_worker.cc`）；2026-11-11 用“冻结 UI 线程目标”构造挂起，但 UIA 调用仍快速返回（31 ms），**未触发超时分支** | 代码在、真实触发**仍未验证**（§4.13） |
| 权限不足目标（管理员窗口） | 2026-11-11：UAC 经用户批准取得 High IL 目标；Medium helper 对其拖选 `mouseEventsQueued=0`（UIPI，符合预期） | **负样本通过（§4.14）**；无正向样本 |
| 进程被杀恢复 | 真实 kill → 0 残留 → 重启 self-test exit 0（§4.4.3）；2026-11-11 Medium IL 复核：kill helper / kill 目标进程后残留 0、重启 exit 0（§4.13） | **通过（真实，已复核）** |

### 4.6 线程模型与宿主协议差异

| 维度 | 现有 addon（Electron utility process 内） | 提取 helper（本原型） |
|---|---|---|
| 进程 | Electron `utilityProcess.fork(selection-hook-host.js)`，Node runtime | 普通 Win32 控制台进程，Rust/宿主直接 spawn |
| 主/JS 线程 | Node 事件循环：TSFN 把 mouse/key/result 事件投递到 JS 主线程；同步 `getCurrentSelection()` 用**调用线程 STA** UIA client | main 线程 = 纯分发器（无 COM）：`EventQueue` + 自动复位事件；无 JS 主线程概念 |
| hook 线程 | `WH_MOUSE_LL`/`WH_KEYBOARD_LL` 线程 + 消息循环（`MsgWaitForMultipleObjectsEx`），回调里 `NonBlockingCall` | 同结构（逐行语义移植）；回调改为短临界区入队 + `SetEvent`（不阻塞低级钩子） |
| 取词线程 | MTA worker：`CoInitializeEx(MTA)` + `CUIAutomation`，结果经 TSFN 回 JS（generation/owner 校验丢弃过期结果） | 同 MTA 结构；结果经 `std::function` 值语义 sink 直接写 JSONL（单会话 generation=1） |
| 停止/回收 | `stop()` → TSFN abort → 2 s 有界 join → 超过则 controlled abandonment + `PinCurrentModule`（issue #17/#24 语义） | `Stop()` → 2 s 有界 join → 超时 detach（独立进程退出即回收，故不需要 Pin）；`selection-hook-service.js` 的心跳/重启语义需在 Rust 宿主重建 |
| 传输 | `MessagePort.postMessage` 结构化克隆（Electron utility process） | **JSON Lines on stdout**（原型）；产品建议改长度前缀/帧协议或本地管道，需版本与最大帧限制 |
| 事件 | `text-selection`、`mouse-down/mouse-up/mouse-move/mouse-wheel`、`key-down/key-up`、`status`、`error` | 同名语义但为 JSON 行；另有 `heartbeat`/`probe`/`uia-ready`/`hook-ready` 原型事件 |
| 方法/配置面 | 18 个实例方法 + `start(config)`（`enableClipboard`、`enableMouseMoveEvent`、`selectionPassiveMode`、`clipboardMode`、`globalFilterMode/List`、`clipboardFilterList`、`debug`、coordinator…） | 只用 CLI flag 覆盖其中一部分；**配置面未实现** |
| 剪贴板协调 | `setClipboardCoordinator()` + 命名管道 lease（`required=true` 时由 Rust 剪贴板服务授权） | 只走 `required=false` 的 lease 分支（恒 granted）；命名管道/HMAC 协议**未接** |
| 健康/卡死判定 | service 层 `ping/pong`：1,000 ms 间隔，1,500 ms 超时，连续 2 次失败回收（`selection-hook-service.js:11-27`） | 需 Rust 宿主按同等语义实现；本原型只有 heartbeat 事件，无 ping 命令 |
| 启动/停止握手 | host 发 `start/stop/update-options/...`，等 `status:started/stopped` | `status:started` JSON 行 + 退出码 |

### 4.7 提取成本粗估（附依据）

**方案 A（提取）到产品化的剩余工作**（本小样已完成标 ✅）：

| 工作项 | 状态 | 估算 | 依据 |
|---|---|---:|---|
| 核心提取边界、构建、取词/回退/停止/错误码 | ✅ 本轮 | — | 本小样 2,046 行 C++（含原型设施）可编译可跑；真实选词 3 样本通过 |
| 产品协议（帧格式/版本/心跳/ping/字节上限/背压） | 未做 | 3–5 人日 | 现有 host 协议 6 入站消息/6 出站事件 + 1,000/1,500 ms 心跳语义需逐条映射；本原型 JSONL 只证明数据流可行 |
| Rust 宿主进程管理（spawn/health/restart/回退/日志脱敏） | 未做 | 3–5 人日 | rust-app `service-host` crate 已有 22 tests 可扩展；`selection-hook-service.js` 现有 545 行状态机可作为等价规格 |
| 18 方法/6 事件配置面 + 过滤器/被动模式/鼠标移动/剪贴板模式 | 未做 | 4–6 人日 | `selection_hook.cc:699-964` 约 266 行参数校验 + `index.js` 689 行 JS 封装；需要 CLI/协议双向映射 |
| 行为兼容验证（浏览器/Office/资源管理器/PDF + 现有 14 个 selection-* JS 测试改造） | 未做 | 5–8 人日 | 仓库现有 `test/selection-*.test.js` 14 个文件；真机矩阵目前只有 2 类目标 |
| 打包/签名/更新/崩溃恢复/权限集成 | 未做 | 3–5 人日 | 与 R8 发布链、R3 集成共同决定 |
| **合计** | | **18–29 人日 ≈ 3.5–6 人周** | 置信度中：最不确定的"提取边界"已被本小样证伪为可控；剩余均为有参考实现的工程工作 |

**方案 B（Rust 重写）到等价行为**：

| 工作项 | 估算 | 依据 |
|---|---:|---|
| UIA→MSAA（IAccessible）→剪贴板事务重写 | 8–12 人日 | 对应 2,590 行 C++ 兼容逻辑；`GetSelection`-only 决策（issue #25，Chromium 全文档范围会冻结 30 s）、祖先 walk（issue #18/PR #14）等反向兼容决策必须重新验证 |
| 剪贴板全格式备份/恢复 + sequence/owner/前台/InputSerial 守卫 | 4–7 人日 | `clipboard.cc` 312 + `clipboard_transaction.cc` 71 + `clipboard_policy.h` 34 + `transient.cc` 118；注释明确"改任何守卫都要重跑应用矩阵" |
| hook 线程 + 手势判定 + 事件/配置面 | 4–6 人日 | `selection_hook.cc` 中约 835 行逻辑 + 18 方法/6 事件 |
| COM/MTA 线程模型、停止有界/放弃、崩溃恢复 | 3–5 人日 | issue #17（Electron 主线程阻塞）/issue #24（env 清理）语义 |
| 行为矩阵/回归 + 真机 | 8–15 人日 | 无行为夹具库；14 个 JS 测试主要覆盖 JS 侧，native 真机矩阵仍是空的 |
| **合计** | **27–45 人日 ≈ 5.5–9 人周** | 且高度依赖"写对了兼容行为"的验证成本；失败后返工风险高于 A |

方案 C 不进入成本比较（违反 D08/G3 终态；只可作为登记了退出批次的临时兼容）。

**判断**：按上述依据，A（3.5–6 人周）明显低于 B（5.5–9 人周）且行为风险显著更低；A 的主要成本在**协议与宿主**（有参考实现），B 的主要成本在**重新验证兼容性**（无夹具、无参考）。这支持 D04 的"提取优先"。

### 4.8 风险清单（供 ADR-0002 登记）

| 风险 | 方案 | 触发信号 | 缓解 |
|---|---|---|---|
| 协议语义漂移（事件顺序/心跳/背压） | A | 事件丢失、停止卡住、宿主误判卡死 | 帧协议 + 序号 + 心跳/超时自动化测试；对照 `selection-hook-service.js` 状态机 |
| helper 成为第二套运行时维护面 | A | vendor 上游更新无法合并、bug 只修一边 | 明确 fork 策略：helper 只编译 vendor 源、不复制；上游同步批次化；登记长期退出/再评估批次 |
| UIA provider 差异（如 WinForms RichTextBox 取不到） | A/B | 浏览器/Office 某版本无文本或卡顿 | 保持 UIA→MSAA→clipboard 顺序与过滤逻辑不变；建真机矩阵（当前为空） |
| UIA/COM 卡死不返回 | A/B | Stop 超时日志、宿主线程被拖住 | 保留 2 s 有界停止/放弃 + 进程整杀；真实挂起 provider 测试待补 |
| 高级权限目标读不到 | A/B | 管理员窗口选词失败 | 文档化限制（UIPI）；不承诺越权 |
| clipboard 回退与用户复制竞态 | A/B | 错误恢复/覆盖用户剪贴板 | 复用现有事务守卫（本轮仅验证成功路径的恢复闭环） |
| Rust 重写低估 | B | 迁移后浏览器/Office 行为回归 | G0 前不选 B；若选，先建行为夹具库并计划真机矩阵 |

### 4.9 真机/目标矩阵覆盖（2026-11-11 修复后实测）

环境修复（工作区完整性标签 Low→Medium，见 §4.10）后，用 `run-selection-matrix.ps1` 对真实应用窗口做真实 SendInput 手势矩阵（主屏，单屏 2240×1400@150%，每行可见窗口约 7–12 s，结束关闭并恢复剪贴板）。结果文件：`.tmp-r0-hook/matrix-results.jsonl`、`matrix-run-summary.json`、`matrix-run-final.log`、逐行 `matrix-run-<row>-*.jsonl`。

| # | 目标 / 行 | 手势 | helper method | 取到文本 | 文本长度 | 取词耗时 | program | IL | 驱动侧独立校验 | 结果 |
|---|---|---|---|---:|---|---:|---:|---|---|---|---|
| 1 | Notepad（UIA TextPattern） | 拖选 | **1 uia** | `R0-04 notepad selection probe line one` | 39 | 0 ms | Notepad.exe | Medium | Ctrl+C 回读一致 | **PASS** |
| 2 | Chrome（默认 a11y） | 拖选 | **1 uia** | `second line has` | 15 | 0 ms | chrome.exe | Medium | UIA 选择一致 | **PASS** |
| 3 | Chrome（`--force-renderer-accessibility`） | 拖选 | **1 uia** | `second line has` | 15 | 0 ms | chrome.exe | Medium | UIA 选择一致 | **PASS** |
| 4 | Edge（默认 a11y） | 拖选 | **1 uia** | `second line has` | 15 | 0 ms | msedge.exe | Medium | UIA 选择一致 | **PASS** |
| 5 | Edge（`--force-renderer-accessibility`） | 拖选 | **1 uia** | `second line has` | 15 | 0 ms | msedge.exe | Medium | UIA 选择一致 | **PASS** |
| 6 | Word（COM 创建文档，未落盘） | 拖选首行 | **1 uia** | `R0-04 word selection probe line one` | 36 | 31 ms | WINWORD.EXE | Medium | COM `Selection.Text` 一致 | **PASS** |
| 7 | Excel（COM workbook，单元格 A1 双击进入编辑态后拖选） | 拖选 | **1 uia** | `R0-04 excel selection probe c` | 29 | 16 ms | EXCEL.EXE | Medium | UIA 选择一致 | **PASS** |
| 8 | Excel（同上，`--clipboard`） | 拖选 | **1 uia** | `R0-04 excel selection probe c` | 29 | 32 ms | EXCEL.EXE | Medium | UIA 选择一致 | **PASS** |
| 9 | 资源管理器（地址栏 Ctrl+L 后拖选） | 拖选 | — | — | — | — | — | Medium | 校准阶段无法用拖选在地址栏建立可验证文本选择（UIA `GetSelection` 为空、Ctrl+C 回读为空） | **FAIL（样本未建立，非 helper 缺陷）** |
| 10 | 资源管理器（地址栏 Ctrl+L 后双击选词） | 双击 | **1 uia** | `hook`（路径 `.tmp-r0-hook` 中的词） | 4 | 16 ms | explorer.exe | Medium | UIA 选择一致 | **PASS（补充行）** |

**读法/限制**：

- 本机在 Medium IL 下 Chromium 的 UIA 页面树可被 UIA 客户端激活（默认行也能命中 `method=1`）；`--force-renderer-accessibility` 行用于对照，不构成产品要求。
- 所有 10 行都由真实 `mouse_event`/`SetCursorPos` 手势触发 helper 的 `WH_MOUSE_LL`（`heartbeat.mouseEventsQueued>0`），不是把文本喂给 helper；驱动侧另有独立选择校验（UIA selection / COM Selection / Ctrl+C 回读），与 helper 结果对比一致。
- 资源管理器拖选行失败原因是**测试校准**问题（Win11 地址栏控件在脚本注入的拖选下未产生可验证选择），helper 未触发；同一窗口的 **双击选词**行 PASS，说明该目标本身可用。该失败不得写成“helper 不支持资源管理器”。
- 单元格网格选择（不进入编辑态）在首轮重跑中为 `found=false method=0`：引擎把 Excel 网格选择判定为非文本 UI 对象选择并有意跳过剪贴板回退（避免对 UI 对象执行复制）；进入单元格编辑态（本表第 7/8 行）即走 UIA 文本路径 PASS。这是行为事实，R3 文档应保留该差异。
- 全部 PASS 行 helper 退出码 0（`--exit-after-selection` 命中后退出）；每行结束无 helper/目标残留，剪贴板恢复。

### 4.10 宿主环境缺陷（工作区 Low 完整性标签）——已修复，重跑有效

**本轮结论：缺陷已修复，§4.9 的矩阵结果是在 Medium IL helper 下取得的有效证据；修复前的失败日志保留为历史记录，不得再引用为行为结论。**

- 根因（同批 teammate install-probe 定位、本小样复核）：`D:\workspace\Highlighter` 根目录带此前 DSH 沙箱遗留的 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` 继承标签；工作区内编译出的 `selection-helper.exe` 由此以 **Low IL** 运行（实测：驱动 pwsh=Medium、explorer=Medium、helper=Low），UIPI 使 helper 低级钩子收不到发往 Medium IL 应用窗口的输入、跨进程 UIA/剪贴板受限 → 所有跨应用样本为环境伪失败。
- 历史证据：`.tmp-r0-hook/low-il-evidence.txt`、`LOW-IL-CONTAMINATION.md`（污染登记；其中 matrix-*/diag-* 已标注不作结论）。
- 修复（Lead 执行，用户批准）：工作区全树 Low→Medium（`icacls` 设 Medium、移除 Everyone DENY 与能力 SID），`whoami.exe` 在工作区内显示 `Mandatory Label\Medium Mandatory Level`。
- 修复后复核：工作区 `icacls` 显示 `Mandatory Label\Medium Mandatory Level:(OI)(CI)(NW)`；新构建的 helper exe 带 Medium 标签，运行进程 IL=**Medium**（`run-selection-matrix.ps1` 预检 + `matrix-results.jsonl` 每行 `helperIntegrity:"Medium"`）。`build.ps1 -Clean -SelfTest` PASS。
- 修复后 `run-selection-matrix.ps1` 实测：10 行中 9 行 PASS（唯一 FAIL 为资源管理器拖选的测试校准问题，见 §4.9 说明）。

### 4.11 clipboard lease `required=true` 与 `native/clipboard` 联调分析（2026-11-11）

**协议事实（只读核对源码；`native/clipboard` 未改动）**

- **父进程 stdio 帧**（`shared/clipboard-protocol.js`、`native/clipboard/src/protocol.rs`）：4 字节 LE 总长 + 1 字节 kind（1=控制帧无 payload，2=二进制帧）+ 4 字节 LE JSON 头长 + JSON 头 + payload；上限 `MAX_FRAME` 1 MiB / `MAX_HEADER` 512 KiB / `MAX_CHUNK` 256 KiB。请求头字段：`version:1`、`type:"request"`、`requestId`、`sessionEpoch`（initialize 之后）、`method`、`params`。
- **协调器生命周期**（`native/clipboard/src/main.rs`）：`initialize` →（可选 `configure`）→ `coordination.start {hostPid}` 返回 endpoint → `coordination.status` → `coordination.stop`（要求 capture 已暂停）→ `quiesce` 后 stdin EOF 退出。`coordination.start` 仅当 capture 未启用、未注册、非 quiescing 时允许。
- **命名管道租约**（`native/clipboard/src/coordinator.rs`）：随机 logon-scoped 管道 `\\.\pipe\Highlighter.Clipboard.<32B hex>`；endpoint 含 `pipeName/nonce/hostEpoch/hostPid/serverPid`；管道 DACL 只授权当前 logon SID，拒绝远程客户端；注册时校验宿主与后台同 logon SID 同 Windows session，并持有宿主进程 HANDLE。
- **固定包协议 v1**：请求固定 128 B、回复固定 32 B；begin（`HLC1`、op=1、tx、nonce、hostEpoch，80–111 必须为 0）→ 回复（status、tx、leaseGeneration、leaseMs=2000、保留 0）；end（op=2、tx、nonce、hostEpoch、generation、5 个序列锚点、outcome=1/2/3）→ 回复（generation 必须匹配）。客户端整个 grant 握手预算 100 ms，租约有效期 1500 ms（`vendor/.../lib/transient.cc` 常数与 `coordinator.rs` 2000 ms 交叉核对一致）。
- **屏障/恢复**（`native/clipboard/src/barrier.rs` + T03 文档）：grant 前先进入 Pending 并等待既有读 permit 释放（≤60 ms）；grant 后断连/非法包/2 s 到期 → Orphaned，不自动恢复；宿主仍存活时 `coordination.recover` 返回 `HOST_STILL_RUNNING`；注册/移除/恢复要求 capture 暂停。
- **产品侧语义**（`main/services/clipboard-service.js`，只读）：历史功能启用时先 `hook.setClipboardCoordinationRequired(true)`，`waitForRetiredHosts()` 后再 `coordination.start {hostPid: hook.getDiagnostics().hostPid}`，然后用 `hook.configureClipboardCoordinator(endpoint)` 下发；停用时 `setClipboardCoordinationRequired(false)` 并拆除 coordinator；capture 只有在 coordinator 配置完成且无 paused reasons 后才 `configure{enabled:true}`；stop/quiesce 路径要求 capture 暂停且协调器可收口，失败映射固定错误码（`COORDINATION_BUSY`/`COORDINATION_ORPHANED`/`CAPTURE_BLOCKED` 等）。
- **helper 现状（缺口）**：`native/selection-helper` 未移植 `lib/transient.{h,cc}` 客户端，也没有任何 coordinator 配置面；其 `SelectionConfigSnapshot.coordinator` 保持默认 `CoordinatorConfig{}`，即 `required=false`。按 `transient.cc:57`，`required=false` 时 `TransientLease` 构造即 `granted_=everGranted_=true`，**不做管道握手**。因此：
  - helper 的剪贴板回退（`--clipboard`/产品默认）当前**绕过** native/clipboard 的采集屏障与租约；
  - 若 R3 要求 `required=true`，helper 现有代码无法满足（无 pipe client / 无 endpoint 输入 / 无 revision/健康握手），只能 fail-closed（拒绝回退）或由产品改为“协调器未配置时禁用回退”；
  - 产品级冲突面：抓取侧在 lease 内会暂停读取并检查序列锚点，而 helper 回退会 `OpenClipboard/EmptyClipboard/SetClipboardData` 并恢复用户剪贴板；两者同时活跃时会出现“抓取把 helper 临时剪贴板当用户内容”或“helper 恢复覆盖抓取基线”的风险。现有 6 个守卫计数（`leaseDenied/backupRejected/inputInterrupted/ambiguousInterleaving/restored/restoreFailed`）应作为 R3 的验收观测点。

**最小联调证据（协议层，非 C++ helper 客户端）**

- 脚本：`.tmp-r0-hook/clipboard-lease-interop.ps1`（gitignored）；用脚本驱动真实 `native/clipboard/bin/HighlighterClipboard.exe`：stdio 帧 `initialize` → `coordination.start {hostPid=本脚本 PID}` → 真实命名管道 begin/end → `coordination.status` → `coordination.stop`/`quiesce`。
- 结果（`.tmp-r0-hook/clipboard-lease-interop.json` / `.log`，2026-11-11 18:06 UTC+8 实测一次）：

| 步骤 | 实测结果 |
|---|---|
| `initialize` | `protocolVersion:1`、`capabilities.coordination:true`、`history:false`（未传 storageRoot，G0 probe） |
| `coordination.start {hostPid}` | 返回 endpoint；`hostPid` 与脚本 PID 一致、`serverPid`=sidecar pid |
| 命名管道 begin | `HLC1 status=0`、tx 回显、`generation=2`、`leaseMs=2000` |
| end | `HLC1 status=0`、generation 匹配 |
| `coordination.status.lastCompletion` | `transactionId`/`generation` 匹配、`outcome:"restored"`、5 个锚点与 baseline 一致（155） |
| 退出 | `coordination.stop`→stopped、`quiesce`→stopped、sidecar exit 0、stderr 为空 |

- **必须同时写明的限制**：这是“Rust coordinator ↔ 脚本协议客户端”的协议互通证据；**不是** C++ helper 与 native/clipboard 的联调（helper 没有客户端实现），也**没有**启动 capture，因此未覆盖 capture 与 lease 的真实竞争。禁止表述为“联调通过”。

**R3 设计输入（本分析产出）**

1. helper 必须移植 lease 客户端（`lib/transient.{h,cc}` 118 行 + `clipboard_transaction.cc` 的 RAII 集成）或由宿主提供等价的“授权后才允许回退”机制；两者只能选一，不能假设 `required=false`。
2. helper 进程应作为 coordinator 的注册宿主：Rust supervisor 用 helper PID 调 `coordination.start {hostPid}`，再把 endpoint（pipeName/nonce/hostEpoch/serverPid）经私有通道下发；endpoint 凭据不得进命令行/日志/持久设置。
3. 需要协议版本/健康握手的宿主侧映射：`setClipboardCoordinationRequired(true)` 的“先 required 再 start/configure”顺序、revision 失效语义、host 退出→Orphaned→recover 的 2 s 租约与 2 s 有界停止预算。
4. `required=true` 下回退被拒（leaseDenied）应作为可观测诊断，而不是静默降级为 UIA/MSAA 失败；产品设置需决定“协调器启用时是否禁用 helper 回退”。
5. 真实竞争测试（capture 启用 + helper 回退并发、快速复制、第三方写剪贴板、宿主崩溃 orphan）仍是 R3 的验收项；本轮只完成协议互通。

### 4.12 2026-11-11 新增环境陷阱（复跑前必读）

1. **工作区完整性标签（已修复）**：见 §4.10；修复前工作区内构建的 exe 会继承 Low label 并以 Low IL 运行。修复后仍需在改动 ACL 后 rebuild；矩阵/runner 用 Medium IL 预检兜底。
2. **helper 控制台窗口必须可见且不得移动/隐藏**：本机实测 `Start-Process -WindowStyle Hidden`、`-NoNewWindow`、或启动后 `ShowWindow(SW_HIDE)`/`MoveWindow` 其控制台窗口，都会让后续 `WH_MOUSE_LL/WH_KEYBOARD_LL` 回调不再收到任何输入（`hookReady:true` 但 `mouseEventsQueued=0`，3/3 可复现）。矩阵脚本因此以普通方式启动 helper 并把目标窗口放在屏幕底部条带，避免 console 覆盖目标。
3. **Chromium UIA 可访问性**：默认启动时 UIA 只见地址栏 Edit；`--force-renderer-accessibility` 后才暴露 Document/Text。矩阵分“默认/强制”两行，默认行的期望路径是 MSAA/剪贴板回退。
4. **vcvars64 与被继承的 VSINSTALLDIR**：本机会话继承的 `VSINSTALLDIR` 缺少结尾反斜杠，导致 `vcvars64.bat` 打印 `Could not find directory "...VC\"` 并把 cl.exe 留在 PATH 外；`build.ps1` 已改为在临时 vcvars 导入脚本里显式 `set "VSINSTALLDIR=<vswhere 路径>\"`，`-Clean -SelfTest` 已通过。

---

### 4.13 真实卡死恢复（2026-11-11，Medium IL）

目标：验证“取词请求进行中” helper 的 2 s 有界停止、无残留、重启可用。脚本：`.tmp-r0-hook/hang-recovery-test.ps1` + `.tmp-r0-hook/hang-target.ps1`；结果：`.tmp-r0-hook/hang-recovery-results.json` / `hang-recovery.log`。

| 场景 | 构造/动作 | 实测 | 判定 |
|---|---|---|---|
| A 有界停止（构造 provider 挂起） | 独立 GUI 目标在成为前台后**冻结 UI 线程**（目标进程自身 Sleep，不再泵消息）；helper Medium IL 对其拖选触发取词 | `mouseEventsQueued=2`、`autoRetrievals=1`；取词在 **31 ms** 内 `stage=complete found=false`（`retrievalElapsedMs=31`，sourcePid=目标进程）——UIA 调用没有真正阻塞；helper 按 `--duration-ms 9000` 正常退出（exit 6，总耗时 8,991 ms），**未触发** “stop timed out; thread abandoned” 分支；残留 0；重启 `--self-test` exit 0 | 进程级恢复 **通过**；**真实 provider 卡死未复现**，2 s 有界停止超时分支本轮仍未取得真实触发证据（如实记录） |
| B 取词期间 kill helper | 拖选后 `Stop-Process -Force` helper | 残留 0；重启 `--self-test` exit 0 | **通过（进程级）**；(取词在 kill 前已完成，严格说不是 in-flight 命中) |
| C 取词期间 kill 目标进程 | 拖选后 kill 目标进程 | helper 存活（hookRunning=true），心跳 2 条 mouse 事件、1 次取词完成；按 duration 正常退出 exit 6，残留 0；重启 exit 0 | **通过（进程级）**；同样未复现真实阻塞 |

**诚实标注**：本机用“冻结 WinForms UI 线程”构造的挂起目标被 UIA 客户端快速返回（未调入 provider 即完成），因此“真实 provider 不返回 → 2 s 有界停止超时”仍是**未验证**项；它需要更底层的手段（如挂起目标进程的 UIA 提供者/使用 RPC 挂起）或真实问题应用。进程隔离模型下的 kill/重启恢复已取得真实证据。

### 4.14 管理员/高完整性窗口负样本（2026-11-11）

脚本：`.tmp-r0-hook/admin-negative-test.ps1`；结果：`.tmp-r0-hook/admin-negative-results.json` / `admin-negative.log`。**未绕过 UAC**：`Start-Process -Verb RunAs notepad.exe` 由用户批准。

| 项 | 实测 |
|---|---|
| 驱动进程 IL | Medium |
| UAC 提权 | 用户批准，成功；elevated notepad pid=18900，token IL=**High** |
| helper IL | Medium |
| 真实拖选手势（aimed at elevated window） | `mouseEventsQueued=0`、`selectionEvents=0`（helper 未观察到任何输入） |
| 判定 | **UIPI 负样本（符合预期）**：Medium IL 低级钩子收不到发往 High IL 窗口的注入输入，非 helper 缺陷；产品应把“管理员窗口不可取词”文档化为平台限制，不承诺越权。 |

**重跑入口（已用于本表）**：

```powershell
# 重建 helper（含 build.ps1 -Clean -SelfTest 门禁）并跑全部行，逐行 PASS/FAIL + JSON 汇总
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/run-selection-matrix.ps1
# 只跑某几行（跳过重建）：
powershell -NoProfile -ExecutionPolicy Bypass -File native/selection-helper/test/run-selection-matrix.ps1 -SkipBuild -Rows Chrome-force,Word,Excel-clipboard
```

`real-selection-matrix.ps1` 单行入口、退出码与行定义见 [native/selection-helper/README.md](../../../native/selection-helper/README.md)。脚本在记录任何结果前强制校验 helper 进程完整性级别为 Medium（否则 matrix exit 7 / runner exit 3）。
## 5. 结论（建议）

对 ADR-0002 的建议（**不冻结**）：

1. **建议选择方案 A：提取 C++ 独立 helper**，作为 R3 的实现基线。置信度：**中高**。依据：本小样证明 0 行 vendor 改动即可复用 2,590 行兼容关键逻辑；构建可复跑（clean 6.4 s）；真实选词在 Notepad UIA（拖选/双击）与剪贴板回退路径均通过；错误码/self-test/进程回收有可执行证据；A 的剩余工作（协议/宿主/配置面/矩阵）有现成参考实现，B 的剩余工作（兼容性等价）没有。
2. **前置条件**（不满足不进 R3 正文）：
   - 产品协议必须重新设计（不得把原型 JSONL 直接当产品合同）：帧长度/版本/心跳/ping/最大 payload/背压/错误码；建议以 `selection-hook-service.js` 的 545 行状态机作为等价规格写契约测试。
   - **真机矩阵须在 Medium IL 环境重跑**：环境缺陷已修复并完成重跑（§4.9 10 行中 9 PASS；§4.10）；`run-selection-matrix.ps1` 在记录前强制校验 Medium IL 并保留为回归门禁。
   - **helper 端缺少 clipboard coordinator 客户端**（§4.11）：R3 必须移植 lease 客户端或明确“协调器启用时禁用回退”，不得依赖 `required=false` 的恒授权语义。
   - 登记 C++ helper 的维护与退出计划（上游同步策略；未来是否再次 Rust 化；谁负责）。
   - G0 仍缺：浏览器/Office/资源管理器/PDF 真机矩阵、权限不足目标、真实 provider 卡死恢复、长稳/进程组。本文不能替代这些证据。
3. **不选方案 B（现在）**：唯一支持它的证据是"终态纯 Rust"，但重写成本 5.5–9 人周且没有行为夹具库；与 D04 的变更条件（"提取成本高于重写且行为夹具完备"）不符——两个条件都未成立。
4. **方案 C 仅可作过渡**：若 R3 前需要临时兼容，必须按 D08 登记责任批次与退出验收。
5. **2026-11-11 续测的增量判断（不改变方案 A 建议，但收紧“已验证”口径）**：
   - **真机应用矩阵：已取得有效证据**（§4.9，Medium IL 重跑）：Notepad、Chrome（默认/强制 a11y）、Edge（默认/强制 a11y）、Word、Excel（默认/`--clipboard`）、资源管理器（双击选词）共 9 行 PASS，均为真实 SendInput 手势触发、`method=1 uia`；资源管理器**拖选**行失败是测试校准问题（样本未建立），不作为 helper 失败结论。矩阵中剪贴板回退路径未成为命中路径（UIA 全命中），回退证据仍来自首版 WinForms 样本。
   - **真实卡死恢复（§4.13）**：进程级 kill/重启恢复通过（无残留、重启 self-test exit 0）；但“provider 永不返回 → 2 s 有界停止超时”**未复现**，仍未取得该分支的真实触发证据。
   - **管理员窗口（§4.14）**：UAC 经用户批准后取得 High IL 目标；Medium helper 对其拖选 `mouseEventsQueued=0`，**UIPI 负样本符合预期**（平台限制，不承诺越权）。
   - lease/coordinator 侧：协议级最小互通已验证（§4.11）；**不能**表述为“helper 与 native/clipboard 联调通过”（helper 无客户端实现，且未启用 capture 竞争）。
   - A vs B 的成本对比证据（0 行 vendor 改动、2,590 行复用、构建 6.4 s）与上述矩阵证据共同支持 A；R3 仍需补协议/宿主/配置面/coordinator 客户端与 PDF/DPI/长稳矩阵。
对计划/估算的影响：R0-04 的提取边界已从"待验证"变为"有实测边界"；R3 中"划词/回贴"可拆成 **helper 产品化 + Rust 宿主进程管理 + 配置面/协议 + 真机矩阵** 四个可独立验收的切片，而不是整体 Rust 重写。

---

## 6. 未解决限制

- **R0-04 验收项现状（2026-11-11 修复后口径）**：真机应用矩阵 9/10 行通过（§4.9；唯一 FAIL 为资源管理器拖选行的测试校准问题）；管理员高完整性窗口只有 UIPI **负样本**（§4.14，符合预期，不承诺越权）；**真实 provider 卡死**仍未复现，2 s 有界停止超时分支没有真实触发证据（§4.13 只覆盖进程级 kill/重启恢复）。
- **lease `required=true`**：协议级最小互通已验证（§4.11，脚本协议客户端 + 真实 `native/clipboard` sidecar），但 **helper 端没有 coordinator 客户端**，与 `native/clipboard` 的产品级联调、capture 与回退的真实竞争仍未完成。**前台授权 `AllowSetForegroundWindow`** 未验证。
- 资源管理器**拖选**样本在本机脚本下未建立（UIA `GetSelection` 与 Ctrl+C 回读均为空），已用同窗口**双击选词**行覆盖该目标；后续如需拖选行，需要改进 Win11 地址栏的脚本化选择。
- 同步 API `getCurrentSelection()`（STA UIA client）与 14 个配置 setter 未实现；本原型只覆盖自动取词。
- 矩阵中的浏览器行使用脚本控制的本地 HTML + 临时 profile；真实网页、PDF 阅读器、Electron 应用、混合 DPI/多屏未覆盖。
- 首版真实选词只在 Windows 11 26300 + 混合 DPI 副屏一次采样；本轮单屏 2240×1400@150%；100%/200% DPI、屏幕拔插、RDP、锁屏/休眠未验证。
- helper DPI 感知为 per-monitor **v1**（与 addon 相同）；R3 冻结坐标基线时需按 R0-03 结论评估 v1/v2 与 Electron/Tauri 的差异。
- 无长稳/内存/句柄泄漏数据；helper 常驻内存与 CPU 未测（不做性能结论）。
- 原型 JSONL 无协议版本/流控；stdout 管道阻塞会反压 worker（产品必须改为非阻塞帧协议或持续读取）。
- `--mouse-events`/`--keyboard-events` 是原型调试选项，高负载下会大量输出；事件队列上限 512/128 与 addon 一致，溢出会丢弃并计数。
- 进程隔离降低了卡死恢复成本，但也意味着 helper 崩溃期间没有取词（宿主需重启）；"崩溃后自动重启"语义只做了手工 kill→重启验证（本轮 Medium IL 复核通过）。
- 测试环境约束：helper 控制台窗口在脚本化运行中需保持可见（§4.12 陷阱 2，Low IL 期间 3/3 复现；修复后矩阵仍按该方式运行，未再单独验证隐藏控制台）；Chromium 默认 UIA 页面树是否暴露取决于 UIA 客户端激活时机（§4.12 陷阱 3）。
## 7. 责任批次与退出验收（建议）

| 批次 | 内容 | 退出验收（可复跑） |
|---|---|---|
| R3-00（前置/环境） | ✅ 已完成（2026-11-11）：工作区完整性标签 Low→Medium、重建 helper、确认进程 IL=Medium | `run-selection-matrix.ps1` 预检通过（helper IL=Medium）；`build.ps1 -Clean -SelfTest` exit 0；矩阵每行 `helperIntegrity=Medium` |
| R3-a（helper 产品化第一片） | helper 协议冻结（帧格式/版本/心跳/ping/错误码）+ 事件/命令映射 | 协议契约测试通过；helper `--self-test` 与心跳/卡死回收测试通过；Notepad/浏览器/Office 中至少 2 类真机样本 |
| R3-b | Rust 宿主 spawn/health/restart/日志脱敏 + service 状态机等价 | 与 `selection-hook-service.js` 行为对照（重启、心跳失败回收、退出码）；kill helper 后自动恢复 |
| R3-c | 18 方法/6 事件/过滤/被动模式/剪贴板模式配置面 **+ coordinator lease 客户端（§4.11）** | 现有 14 个 selection-* JS 测试改造后全绿；配置矩阵真机复核；`required=true` 下 leaseDenied/恢复计数可观测 |
| R3-d | 真机矩阵补齐 + 长稳 + 打包/签名 | 浏览器/Office/资源管理器/PDF + 管理员窗口 + 100/200% DPI；>8 h 长稳；release 包不含 Node |
| 回退方式 | 保留现有 N-API utility process 作为并行开关，直到 R3-d 退出验收通过 | 开关级回退；不修改用户数据 |

---

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 首版：R0-04 提取小样、构建/运行/真实选词/错误路径证据、成本评估与 ADR-0002 建议 | `native/selection-helper/`、`.tmp-r0-hook/`（gitignored）、本文 §3–§4 |
| 2026-11-11 | 续测（本机 SHERUNLOCK02，单屏 2240×1400@150%）：新增真实应用矩阵驱动 `test/real-selection-matrix.ps1`（Chrome/Edge/Word/Excel/资源管理器/Notepad、UIA/剪贴板双路径、键盘 Ctrl+L/Ctrl+C、驱动侧独立选择校验）与一键重跑 `test/run-selection-matrix.ps1`（含 `-Clean -SelfTest` 门禁与 helper IL 预检）；`build.ps1` 修复被继承 `VSINSTALLDIR` 缺尾反斜杠导致 vcvars64 失败的问题 | `.tmp-r0-hook/`、`native/selection-helper/` 源码 |
| 2026-11-11 | **环境缺陷登记**：工作区根 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)` → 工作区内构建的 helper 以 Low IL 运行（实测 pwsh/explorer=Medium，helper=Low），UIPI 使跨应用真实选词/卡死恢复/管理员窗口样本全部失效；这些失败是环境伪失败，**matrix 结果不作结论**，待 ACL 修复 + rebuild 后重跑 | `.tmp-r0-hook/LOW-IL-CONTAMINATION.md`、`low-il-evidence.txt`、`low-il-preflight.txt` |
| 2026-11-11 | **lease/native-clipboard 补证**：核对 T03 固定包协议与 `clipboard-service.js` 协调器语义；定位 helper 缺少 lease 客户端的缺口（`required=false` 恒授权）；用真实 `native/clipboard` sidecar + 脚本协议客户端完成 begin/end/status 协议级闭环（`begin status=0 generation=2 leaseMs=2000`、`lastCompletion outcome=restored`、sidecar exit 0）；**不是** helper↔native/clipboard 联调 | `.tmp-r0-hook/clipboard-lease-interop.ps1`、`clipboard-lease-interop.json`、`clipboard-lease-interop.log`、本文 §4.11 |
| 2026-11-11 | 新增环境陷阱：helper 控制台窗口必须可见且不得移动/隐藏（否则低级钩子 0 事件，3/3 复现）；Chromium 默认无 UIA 页面树，需 `--force-renderer-accessibility` 才暴露 Document/Text | `.tmp-r0-hook/` 诊断日志、本文 §4.12 |
| 2026-11-11 | **环境修复与矩阵重跑（有效证据）**：工作区 Low→Medium 后重建 helper（进程 IL=Medium），`run-selection-matrix.ps1` 跑 10 行：Notepad/Chrome 默认+force/Edge 默认+force/Word/Excel/Excel-clipboard/Explorer-doubleclick 共 9 行 PASS（全部 `method=1 uia`），Explorer 拖选行因测试校准失败（样本未建立） | `.tmp-r0-hook/matrix-results.jsonl`、`matrix-run-summary.json`、`matrix-run-final.log`、本文 §4.9–§4.10 |
| 2026-11-11 | **真实卡死恢复复核**：构造冻结 UI 线程目标后取词仍在 31 ms 完成（UIA 未真正阻塞）；进程级 kill helper/kill 目标进程恢复通过（残留 0、重启 self-test exit 0），2 s 有界停止超时分支**未复现** | `.tmp-r0-hook/hang-recovery-results.json`、`hang-recovery.log`、本文 §4.13 |
| 2026-11-11 | **管理员窗口负样本**：UAC 经用户批准启动 High IL notepad；Medium helper 对其拖选 `mouseEventsQueued=0`，UIPI 平台限制符合预期（未绕过 UAC） | `.tmp-r0-hook/admin-negative-results.json`、`admin-negative.log`、本文 §4.14 |
