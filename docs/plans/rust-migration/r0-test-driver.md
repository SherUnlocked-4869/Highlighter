# R0 桌面 E2E 测试驱动评估（ADR-0006 证据）

日期：2026-11-11。状态：**R0 证据文档；测试驱动路线为"候选 A（tauri-driver + 精确匹配 msedgedriver + 应用侧断言）"，G0 前不冻结**。
对应共享任务：`task-2`（ADR-0006 桌面 E2E 测试驱动评估）。
上位文档：迁移计划 §10、[r0-baseline.md](r0-baseline.md) §4.7 与 §6.2 S0-3；被评估原型见 [r0-window-prototype.md](r0-window-prototype.md)。
决策记录：[adr/0006-desktop-test-driver.md](adr/0006-desktop-test-driver.md)；索引 [adr/README.md](adr/README.md)。

> 约定：本文"通过"均有实测命令 + 原始 JSON/stdout 证据；没有执行过的项写"未验证"，不得当成通过。
> 原始证据放在 `.tmp-r07/driver/`（gitignore，不提交）；文档只摘录关键输出与文件哈希。
> 本机为单屏（AGENTS.md 要求可见测试窗口默认放副屏），用户已明确允许本机出现短暂可见测试窗口；
> 所有 session 均持续 1~3 秒并自动关闭。

## 1. 结论摘要

1. **官方 WebDriver 路径在本机可用（真实证据）。** `tauri-driver 2.1.0` + `msedgedriver 157.0.4341.46`（与本机
   WebView2 Runtime `157.0.4341.46` 完全一致）+ 无 npm 依赖的 Node 探针，**真实 Tauri 进程**的 new session /
   窗口句柄 / execute sync+async / Tauri IPC 命令调用 / W3C 指针动作 / 截图 / delete session 全流程通过；
   本机至少 6 次 `new session` 成功，含 close 与 crash 两个边界分支。
2. **能力边界已经用真实响应界定**：WebDriver 只能看到 **Web 内容**（截图 2241x1401、带 alpha，不是桌面合成结果）；
   `window/rect` 返回的是 **CSS/DIP** 坐标（1494x934），不是物理像素（2240x1400）；launch 模式下应用 **stdout 不落盘**，
   握手/日志断言必须走页面 DOM、宿主命令或应用自写日志。
3. **失败分支可观测**：应用启动即退出（单屏未开测试开关）→ session 500 且 `tauri-driver` 的 stderr 里能看到应用错误行；
   缺可执行文件 → 500；关闭窗口 → session invalid；强杀应用 → 后续命令 404 `invalid session id`。
4. **环境陷阱两个（都已实测复现并解决）**：受限宿主下 msedgedriver 需要可写的 `TMP/TEMP`（否则 500
   `cannot create temp dir for user data dir`）；本机单屏必须用测试专用开关 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`
   才能让 R0-03 原型出窗（未设置时行为与改动前完全一致，仍 exit 2）。
5. **生产隔离成立（原型层面）**：三种 NSIS 变体的载荷只有 应用 exe + WebView2 安装器 + NSIS 插件 DLL，
   安装/内嵌 exe（`36AE37CC…`）与 Release exe（`7C1A3DAE…`）字符串扫描均**不含** msedgedriver /
   tauri-driver / webdriver / remote-debugging-port；原型本身没有测试端点（无 HTTP 监听、无 WebDriver 依赖）。
   仅有的 `HIGHLIGHTER_R0_ALLOW_PRIMARY` 字符串是**测试专用、默认关闭**的开关（见 §4.1）。
6. **建议（候选，未冻结）**：R1-e 以 **A 为主**（tauri-driver 作为 CI 桌面冒烟/关键链路驱动），**C（宿主 --self-test
   探针）保留**为启动/退出/几何/进程树烟测；**B（WebView2 CDP + Playwright）作为回退候选**本轮未验证；
   `@wdio/tauri-service`（官方 2026 文档推荐）作为 A 的上层客户端候选未评估。主要未验证项：GitHub runner 实测、
   msedgedriver 版本不匹配行为、无 WebView2 Runtime 机器、多窗口/托盘、混合 DPI、长时稳定性。

## 2. 环境与版本冻结表

### 2.1 实测机器（与 handoff 记录的机器不同，以本机为准）

| 项 | 值 |
|---|---|
| 主机 | SHERUNLOCK02（用户确认） |
| OS | Microsoft Windows 11 家庭版 中文版，build **26300**（`10.0.26300`） |
| CPU / RAM | 13th Gen Intel Core i5-13500H（12C/16T）/ 15.75 GiB |
| GPU | Intel Iris Xe 核显（驱动 31.0.101.4032） |
| 显示器 | **单屏** `\\.\DISPLAY1`，物理 2240x1400、**150%**（DIP 1493x933），工作区 2240x1352；无副屏 |
| 仓库 | `D:\workspace\Highlighter`，分支 `codex/rust-r0-baseline-contracts`，起始 HEAD `7c45a7b` |
| Rust | rustc/cargo **1.97.1**（`rust-app/rust-toolchain.toml` 固定） |
| Node / npm | **24.15.0** / 11.17.0 |
| 依赖缓存 | `CARGO_HOME=D:\DevCache\cargo`（crates.io 可访问，离线缓存可用） |

### 2.2 版本冻结表（本次实测绑定）

| 组件 | 版本 | 获取/标识 | 证据 |
|---|---|---|---|
| tauri-driver | **2.1.0** | `cargo install tauri-driver --locked`（装在 `CARGO_HOME`，不写仓库 Cargo.lock） | exe SHA256 `F497C9B3508D0DC721ECE1CAF9980BFA24BE3E244EB1FCF9A10C41A50D0B071B` |
| msedgedriver | **157.0.4341.46** | `https://msedgedriver.microsoft.com/157.0.4341.46/edgedriver_win64.zip`（HTTP 200，11,706,112 B） | zip SHA256 `AD94F3A9…9420`，exe SHA256 `6C3FDCB9…BD8F` |
| WebView2 Runtime | **157.0.4341.46** | 注册表 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv` | 安装目录 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\157.0.4341.46`（另有 .42 残留目录） |
| 会话内浏览器版本 | **157.0.4341.46** | `new session` 能力 `browserVersion` / `msedge.msedgedriverVersion` | `.tmp-r07/driver/webdriver-wrapper/summary.json` |
| Tauri 栈 | tauri **2.12.5** / tauri-build 2.7.4 / tauri-runtime 2.12.2 / tauri-runtime-wry 2.12.3 / wry **0.57.2** / webview2-com(-sys) 0.39.1 / tao 0.37.2 | `rust-app/Cargo.lock` | `.tmp-r07/driver/version-evidence.txt` |
| Node 探针 | 无 npm 依赖（Node 24 内置 fetch） | 仓库 `scripts/rust/probe-tauri-webdriver.js` | SHA256 `12ECFE64…AE46` |
| 安装器 | 见 §8 | `.tmp-r07/install/artifacts/*` | Release exe `7C1A3DAE…5715`；内嵌 exe `36AE37CC…3ADB` |

**版本匹配规则（实测确认）**：msedgedriver 必须与 **WebView2 Runtime 完全同版本**（官方 WebView2 WebDriver 文档要求；
本机二者均为 `157.0.4341.46`，且 session 返回的 `browserVersion` 与 `msedgedriverVersion` 相等）。
下载 URL 用运行时 `pv` 的全版本号拼接；`https://msedgedriver.microsoft.com/LATEST_RELEASE_157` 返回
`157.0.4341.46`（UTF-16 文本），可用于"当前 stable major 的最新 build"探测。
**不匹配时的行为本轮未实测**（只有这一个运行时版本可用，无法伪造），列入 §11。

### 2.3 启动参数（实测有效）

```
tauri-driver --port 4444 --native-port 4445 \
  --native-driver D:\workspace\Highlighter\.tmp-r07\driver\msedgedriver\157.0.4341.46\msedgedriver.exe
```

环境变量（由启动 tauri-driver 的父进程设置，经 msedgedriver 继承给被启动的应用）：

- `TMP/TEMP` → 仓库内 scratch（如 `.tmp-r07/driver/tmp`），**必须存在且可写**；
- `HIGHLIGHTER_R0_ALLOW_PRIMARY=1` → 单屏主机允许主屏作为目标（**测试专用**，见 §4.1；多屏机器不需要）；
- `TAURI_WEBVIEW_AUTOMATION=true` / `TAURI_AUTOMATION=true` 由 tauri-driver 自己注入 native driver 进程
  （源码 `tauri-driver-2.1.0/src/webdriver.rs:50-51`），不需要调用方设置。

## 3. 获取与安装（命令 + 真实输出）

### 3.1 tauri-driver

```powershell
cargo install tauri-driver --locked
# ...
#    Compiling tauri-driver v2.1.0
#     Finished `release` profile [optimized] target(s) in 42.28s
#   Installing D:\DevCache\cargo\bin\tauri-driver.exe
#   Installed package `tauri-driver v2.1.0` (executable `tauri-driver.exe`)

cargo install --list | Select-String tauri-driver
# tauri-driver v2.1.0:
#     tauri-driver.exe
```

- 完整的安装日志：`.tmp-r07/driver/cargo-install-tauri-driver.log`（4,071 B，SHA256 `88C728D1…5B17B`）。
- **注意**：`tauri-driver --version` 不被支持（实测报 `Error: unused arguments left: ["--version"]`），
  版本必须用 `cargo install --list` 或 exe 哈希确认；`--help` 只有 `--port/--native-port/--native-host/--native-driver` 四个参数。
- 官方 README 仍标注 "pre-alpha"（跨平台 WebDriver 中间层），风险写入 ADR-0006 §6。
- crates.io 版本与 Tauri 2 的兼容性：本次 2.1.0 + tauri 2.12.5 **实测兼容**（session 成立），未触发换 git 版的场景。

### 3.2 msedgedriver

```powershell
# 1) 读取 WebView2 Runtime 版本
$k = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
(Get-ItemProperty $k).pv        # 157.0.4341.46

# 2) 官方下载（先 HEAD 探测：HTTP 200，Content-Length=11706112）后保存
Invoke-WebRequest -Uri 'https://msedgedriver.microsoft.com/157.0.4341.46/edgedriver_win64.zip' -OutFile .tmp-r07\driver\msedgedriver\157.0.4341.46\edgedriver_win64.zip
Get-FileHash .tmp-r07\driver\msedgedriver\157.0.4341.46\edgedriver_win64.zip -Algorithm SHA256
# AD94F3A90CB9AC70FC691D83AC98FDCADD2ABB94C58CAE33020AA2B497519420

# 3) 解压并核对版本
Expand-Archive -Path .tmp-r07\driver\msedgedriver\157.0.4341.46\edgedriver_win64.zip -DestinationPath .tmp-r07\driver\msedgedriver\157.0.4341.46
.\msedgedriver.exe --version
# Microsoft Edge WebDriver 157.0.4341.46 (a0c6bd61d7884b3c402a34c67d05100107a9e5e4)
```

- 选择逻辑（CI 也要照此实现）：先读运行时 `pv`；用 `https://msedgedriver.microsoft.com/<pv>/edgedriver_win64.zip`
  精确下载；若 404 再退化到 `LATEST_RELEASE_<major>`，但必须校验 major/build 匹配，**不允许静默使用不匹配版本**。
- 本次实测过的 URL 探测：`157.0.4341.46` → 200；`157.0.4341.42` → 200（旧 build 也有驱动）；不存在的 build → 404。
- 官方文档背景（2026-11-11 抓取，仅作背景、不作为本机实测）：Tauri WebDriver 文档
  `https://v2.tauri.app/develop/tests/webdriver/`（推荐 `@wdio/tauri-service`，手动 tauri-driver 路线限 Windows/Linux）；
  Microsoft WebView2 WebDriver 文档 `https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver`
  （"launch/attach" 两种模式、要求 Edge WebDriver 与 WebView2 Runtime 版本一致）。

## 4. 前置条件与环境陷阱（实测复现）

| # | 陷阱 | 真实症状 | 解决 |
|---|---|---|---|
| 1 | 受限宿主 / 子进程无用户 Temp 写权限 | 首次 `POST /session` 直接 500：`session not created from unknown error: cannot create temp dir for user data dir` | 把 `TMP/TEMP` 指向仓库内已存在目录 `.tmp-r07/driver/tmp`；wrapper 脚本自动设置 |
| 2 | 单屏主机 + 原型安全约定 | 应用启动即 `[FAIL] startup code=secondary-monitor-required`、退出码 2；msedgedriver 报 `session not created: Microsoft Edge failed to start: crashed (DevToolsActivePort file doesn't exist)` | 测试专用开关 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`（§4.1）；未设置时行为与改动前一致 |
| 3 | 端口固定 | 4444/4445 被占用时 tauri-driver/msedgedriver 起不来 | wrapper 支持 `-Port/-NativePort`；CI 单机串行执行 |
| 4 | launch 模式应用 stdout 丢失 | `tauri-driver` 把 native driver 的 stdout 置为 null（源码 `webdriver.rs:55-58`），应用 stdout 不落盘；成功路径 stdout/stderr 日志均 0 字节 | 断言走页面 DOM/宿主命令；R1 需应用自写结构化日志（§10/§11） |
| 5 | 无 WebView2 Runtime 的机器 | R0-07 用同栈 PDF 原型实测：WebView2 loader 弹**阻塞式 #32770 错误对话框**（标题 Error），进程挂起；关闭后 Tauri 返回 `runtime error: Could not find the webview runtime...`、退出码 3 | CI runner 必须预装匹配版本 WebView2 Runtime；本 ADR 不声称在无 Runtime 机器上 tauri-driver 可用（未验证） |

### 4.1 测试专用开关 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`（本次新增，需登记）

**用途**：本机单屏，R0-03 原型按 AGENTS.md 安全约定拒绝在主屏出窗（exit 2），导致无法在单屏主机上做 WebDriver session。
该开关只用于**自动化/性能对照**，让原型把主屏当作目标显示器。

**实现（最小改动，只在 `rust-app/src-tauri/src/`）**：

| 文件 | 位置 | 作用 |
|---|---|---|
| `src/cli.rs` | `:16` `ENV_ALLOW_PRIMARY`；`:21` `parse_allow_primary`（纯函数，严格只接受 `1`）；`:26` `allow_primary_from_env`；`:74` USAGE 增"测试专用环境变量"段；`:170-181` 单测 | 解析环境变量 |
| `src/monitors.rs` | `:148-176` `select_target(monitors, requested, allow_primary)`；`:326-346` 单测 | `allow_primary=false` 时**直接委托**原 `select_secondary`（默认路径语义零变化）；`true` 时仍优先副屏，无副屏才退回主屏，显式 `--monitor` 主/副屏均可 |
| `src/main.rs` | `:46-48` static `ALLOW_PRIMARY`；`:405` 命令面 `require_secondary` 在开关打开时放行主屏；`:502` 启动选择目标显示器；`:611` 自检如实打印；`:824-827` 读取环境变量 | 生效与日志 |

**行为**：

- 未设置（默认）：与改动前**完全一致**——单屏 `monitors=1` → `[FAIL] startup code=secondary-monitor-required`、**exit 2、不创建窗口**；
- 设置为 `1`：manual 模式窗口出现在主屏；`--self-test` 允许通过，但自检行**如实打印**
  `target_primary=true allow_primary=true` 与 `source=HIGHLIGHTER_R0_ALLOW_PRIMARY (test-only switch; NOT a secondary-monitor verification)`，
  不会伪装成"副屏通过"；
- 多屏机器即使设置该开关，仍优先选副屏（不改变既有语义）；
- 只认 `1`（去空白），`0/true/yes/空` 等一律不开启（单测覆盖）。

**验证（debug + release 都实测）**：

```powershell
cargo build --manifest-path rust-app/Cargo.toml -p highlighter-r0-window         # OK（13.83s 首次增量）
cargo test  --manifest-path rust-app/Cargo.toml -p highlighter-r0-window --locked  # 17 passed / 0 failed（原 15 + 新增 2）

# 无 env：exit 2，无窗口
.\rust-app\target\debug\highlighter-r0-window.exe --self-test
#  [r0-window] monitors=1
#  [FAIL] startup code=secondary-monitor-required ...
#  EXITCODE=2

# env=1：主屏出窗 + 自检 PASS，诚实标注
$env:HIGHLIGHTER_R0_ALLOW_PRIMARY='1'
.\rust-app\target\debug\highlighter-r0-window.exe --self-test --hold-ms 2000
#  [r0-window] mode=self-test hold_ms=2000 protocol=r0-prototype-1 allow_primary=true
#  [self-test] allow_primary=true target_primary=true source=HIGHLIGHTER_R0_ALLOW_PRIMARY (test-only switch; NOT a secondary-monitor verification)
#  [PASS] r0-03 self-test: secondary_monitor_index=0 target_primary=true allow_primary=true negative_y=false ready/init_once ok dpr=1.5 canvas_dpr_ok=true
#  [self-test] result exit_code=0 primary_scale=1.5 monitors=1 target_primary=true allow_primary=true
#  EXITCODE=0
```

- 日志与哈希：`.tmp-r07/driver/self-test-no-env.log`（641 B，`7EE90F57…4BC5F`）、
  `self-test-allow-primary.log`（2,473 B，`18D4A13C…BACA`）；release 二进制的对应日志哈希**完全相同**
  （`release-self-test-no-env.log` / `release-self-test-allow-primary.log`），说明 debug/release 行为一致。
- Release 构建（packager 用于 NSIS 的同一二进制 `7C1A3DAE…5715`，8,928,768 B）实测：无 env exit 2、env=1 PASS，
  见 `.tmp-r07/driver/release-self-test-*.log`。

**生产隔离登记**：

- 该开关在 **release 构建也生效**（供单屏 CI/性能对照），但原型**不是产品**，生产包不依赖它；
  NSIS 不需要剥离，但 R1 若要把类似开关带进产品，必须改成 **仅测试构建**（cfg feature / test build）并保证默认路径不可达。
- 生产包行为不受影响：不设置该变量时所有路径与改动前一致（已用 release exe 实测）。
- 风险：环境变量是进程级开关，没有调用者身份校验；只存在于原型，禁止在任何产品入口复制此模式。

## 5. 最小 WebDriver 探针（真实 session）

### 5.1 文件

| 文件 | 说明 |
|---|---|
| `scripts/rust/probe-tauri-webdriver.js` | 无 npm 依赖（Node 24 fetch）的原始 W3C WebDriver 探针；写 JSONL 原始协议日志 + summary + 截图；支持 `--mode full/close/crash` 与负样本；退出码 0/2/3 |
| `scripts/rust/run-tauri-webdriver-probe.ps1` | 一条命令完成环境准备、启动 tauri-driver（等端口就绪）、运行 Node 探针、清理进程（tauri-driver Job object + 显式兜底杀子进程） |

两者都不改产品代码、不 npm install、证据只写 `.tmp-r07/`。

### 5.2 一次真实全流程（2026-11-11 13:25 本地时间）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/run-tauri-webdriver-probe.ps1 -NativeDriver .tmp-r07\driver\msedgedriver\157.0.4341.46\msedgedriver.exe -AllowPrimaryScreen -OutDir .tmp-r07\driver\webdriver-wrapper
```

关键输出（原样摘录，完整见 `.tmp-r07/driver/probe-run-wrapper.log`）：

```text
[probe] tauri-driver pid=20532, waiting for 127.0.0.1:4444 ...
[200] GET /status (17ms)
[200] POST /session (565ms)
  sessionId: cea17c2895ed9e44cf3ca17370289966
  browserVersion: 157.0.4341.46
  debuggerAddress: localhost:50124
[200] GET /window/handles (2ms)
  windowHandles: ["66812B6A935B0DFF7FE117374D6FE947"]
[200] POST /execute/sync (document.title) (92ms)
  title: Highlighter R0-03 overlay prototype
[200] POST /execute/sync (page state) (7ms)
  pageState: url=http://tauri.localhost/ readyState=complete dpr=1.5 inner=1494x934 screen=(0,0) hasTauri=true
[200] GET /window/rect (4ms)
  windowRect: {"height":934,"width":1494,"x":0,"y":0}
[200] POST /execute/async (host_list_monitors) (9ms)
  hostListMonitors: {"ok":true,"value":{"monitors":[{"index":0,"isPrimary":true,"size":[2240,1400]}],"primaryScale":1.5,"secondaryIndex":null}}
[200] POST /actions (pointer click) (22ms)
[200] POST /execute/sync (pointerdown count) (6ms)
  inputInjection: {"actionsStatus":200,"clickCount":1}
[200] READY poll (HUD state) (6ms)
  readyPoll: state=ready text="R0-03 原型 ready ... 握手 = ready -> init（单次）"
[200] GET /screenshot (97ms)
  screenshot: 102740 bytes sha256=19a6fe3d…34d
[200] DELETE /session/{id} (9ms)
[500] POST /session (missing application, negative) (107ms)
[probe] node probe exit=0
[probe] driver cleaned (tauri-driver pid=20532, native pids=9744)
```

清理后核对：`tauri-driver=0`、`msedgedriver=0`、`highlighter-r0-window=0`、端口 4444 关闭（wrapper 实测输出）。

**能力解读**：

1. session 创建耗时 **565 ms**（含启动 Tauri 进程、创建透明浮层、WebView2 初始化）；`browserVersion` 与
   `msedgedriverVersion` **完全一致**（157.0.4341.46）；`debuggerAddress` 证明 EdgeDriver 通过 WebView2 的 CDP 端口附加。
2. 页面 URL 是 `http://tauri.localhost/`（Tauri 2 的 WebView2 自定义协议宿主），`window.__TAURI__` 可用，
   说明 WebDriver 驱动的是**真实 Tauri 宿主里的页面**，不是浏览器 mock。
3. `execute/async` 里调用宿主命令 `host_list_monitors` 返回真实显示器 JSON（2240x1400 / isPrimary=true），
   证明 **WebDriver → 页面 → Tauri IPC → Rust 命令面** 全链路可达。
4. 页面 HUD 由"booting"变为"ready"本次用 6 ms（冷启动首次实测 259 ms / 2 次轮询），且文案包含
   "握手 = ready -> init（单次）"，说明 **ready → init → metrics** 握手完成，WebDriver 可以等待/断言该状态。
5. 截图 2241x1401 PNG 102,740 B（sha256 `19A6FE3D…34D`）含 alpha 通道：半透明棋盘格像素 A=41（≈0.16），
   即 **截图是 Web 内容自身 alpha，不是桌面合成后的画面**（透明区域不会露出桌面/其他窗口的内容）。
6. close/crash/负样本见 §7。

**会话数**：本机共 **6 次成功 new session**（手动 1 次 + 首版探针 1 次 + 全流程 2 次 + close 1 次 + crash 1 次），
外加 2 次预期失败的负样本（缺可执行文件、单屏未开开关）。

## 6. 能力矩阵（实测 vs 未验证）

| 能力 | 命令/方式 | 结果 | 判定 |
|---|---|---|---|
| 启动真实 Tauri 进程并建立 session | `POST /session` + `tauri:options.application` | 200，565 ms，browserName=webview2 | **通过** |
| 驱动/浏览器版本一致性 | capabilities | browserVersion = msedgedriverVersion = 157.0.4341.46 | **通过** |
| 窗口句柄 | `GET /window/handles` | 1 个（原型单窗口） | **通过** |
| 同步脚本 | `POST /execute/sync` | title/URL/DPR/HUD/`window.__TAURI__` 可读 | **通过** |
| 异步脚本 + 宿主 IPC | `POST /execute/async` → `host_list_monitors` | 返回 Rust 命令 JSON | **通过** |
| 输入注入 | `POST /actions`（pointer move/down/up） | 页面 pointerdown 计数 = 1 | **通过** |
| 页面握手等待 | 轮询 HUD `data-state` | booting → ready；文案含 ready→init 单次 | **通过** |
| 截图 | `GET /screenshot` | PNG 2241x1401、带 alpha（Web 内容，不是桌面合成） | **通过（有限制）** |
| 窗口几何 | `GET /window/rect` | 1494x934 @ (0,0)，**CSS/DIP 单位**，非物理 2240x1400 | **通过（有限制）** |
| 关闭窗口 | `DELETE /session/{id}/window` | 200 `{"value":[]}` → 应用退出、session 失效 | **通过** |
| 应用崩溃检测 | 强杀 `goog:processID` 进程 | 后续命令 404 `invalid session id`；DELETE session 仍 200 | **通过** |
| 会话清理 | `DELETE /session/{id}` | 200，应用进程与 WebView2 子进程归零 | **通过** |
| 多窗口/托盘/主窗口 | — | 原型只有 1 个窗口，未实现托盘 | **未验证（R1）** |
| 透明合成/白闪/鼠标穿透 | — | WebDriver 截图不含桌面合成，不能断言 | **未验证（需宿主截屏）** |
| 文件对话框/系统权限弹窗 | — | 未做 | **未验证** |
| 混合 DPI / 100%/200% | — | 本机单屏仅 150% | **未验证** |
| WebView2 版本不匹配 | — | 只有匹配版本可用 | **未验证** |
| 无 WebView2 Runtime | — | 本机已安装；R0-07 用同栈 PDF 原型观察到阻塞对话框 | **未验证（高风险，见 §4 陷阱 5）** |
| 长时/并发稳定性 | — | 只做了单次 session 与各分支 1 次 | **未验证** |

## 7. 失败分支实测（原始 JSON 摘录）

### 7.1 缺可执行文件（负样本）

```json
{"value":{"error":"session not created",
 "message":"session not created\nfrom unknown error: no msedge binary at D:\\workspace\\Highlighter\\.tmp-r07\\driver\\webdriver-wrapper\\definitely-missing-highlighter-r0-window.exe"}}
```

判定：驱动会明确报"no msedge binary at <path>"，HTTP 500；不会启动任何进程。

### 7.2 单屏 + 未设置测试开关（应用启动即退出）

命令：不带 `HIGHLIGHTER_R0_ALLOW_PRIMARY` 启动第二个 tauri-driver（4446/4447）后 `POST /session`。

```json
{"value":{"error":"session not created",
 "message":"session not created: Microsoft Edge failed to start: crashed.\n  (session not created: DevToolsActivePort file doesn't exist)\n  (The process started from msedge location D:\\workspace\\Highlighter\\rust-app\\target\\debug\\highlighter-r0-window.exe is no longer running, so msedgedriver is assuming that msedge has crashed.)"}}
```

同时 tauri-driver 的 stderr 里有应用自己的错误行（`.tmp-r07/driver/tauri-driver-noenv.log`）：

```text
[r0-window] startup failed: secondary-monitor-required (no-secondary-monitor: 未检测到副屏；原型拒绝在主屏创建可见窗口（不创建、不显示）)
```

判定：**失败可观测且快（165 ms）**，但驱动错误文案会把原因归为 "msedge crashed"；CI 必须同时采集应用
stderr/日志才能定位真实原因（这条也是"应用侧日志必须落盘"的证据）。

### 7.3 关闭窗口（`--mode close`）

```text
[200] DELETE /window (W3C close current window) (70ms)   → {"value":[]}
[404] GET /window/handles (after close) (1ms)            → invalid session id
[404] POST /execute/sync (after close) (1ms)             → invalid session id
[200] DELETE /session/{id} (after close) (1ms)
```

判定：仅有的窗口关闭后应用退出（`highlighter-r0-window=0`），session 立即失效；这是**设计边界**，
R1 的"关窗/隐藏/退出区分"必须由宿主自己提供可观测状态（计划 R1-d），不能依赖 driver 推断。

### 7.4 应用崩溃（`--mode crash`）

```text
killing application process pid=12836
[404] GET /window/handles (after app crash) (2ms)   → invalid session id
[404] POST /execute/sync (after app crash) (21ms)   → invalid session id
[200] DELETE /session/{id} (after crash) (1ms)
```

判定：崩溃被检测为 session 失效（404），驱动与 tauri-driver 本身不崩；清理 DELETE 仍返回 200。

### 7.5 其它已记录但未完全验证的分支

- **TMP 不可写**：500 `cannot create temp dir for user data dir`（首次实测复现，见 §4 陷阱 1）。
- **msedgedriver 版本不匹配**：未实测（只安装了一个精确匹配版本）。
- **tauri-driver 未启动/端口被占**：未单独测（wrapper 会在端口等待阶段抛错）；CI 需超时保护。
- **无 WebView2 Runtime**：未在本机复现；R0-07 用同栈原型观察到阻塞对话框（见 §4 陷阱 5），本 ADR 不重复验证。

## 8. 生产隔离证据（Release / NSIS）

> 原型不是产品；本节的目的是证明"测试驱动/测试端点只存在于测试侧，不随安装包分发"。
> NSIS 安装矩阵的最终安装/卸载验证由共享任务 task-1（R0-07，packager）负责，证据在
> `.tmp-r07/install/logs/install-smoke-final-*.log` 与 [r0-installation-matrix.md](r0-installation-matrix.md)；
> 本文不重复安装（packager 明确要求避免并发安装），但**独立用 7-Zip 检查了三种安装器载荷**。
> 截至本文定稿，packager 的"安装后文件清单/卸载注册项"仍在其文档 §6.3 标注为待补测，本文不代替其结论。

### 8.1 Release 二进制（`rust-app/target/release/highlighter-r0-window.exe`）

- 大小 **8,928,768 B**，SHA256 `7C1A3DAEBCF8852D40A862C4DC10E2B389C3F158A8E5632CF96697714BD55715`。
- 字符串扫描（ASCII + UTF-16LE 双编码搜索）：

| 关键串 | 是否出现 | 说明 |
|---|---|---|
| `msedgedriver` / `tauri-driver` / `WebKitWebDriver` | 否 | 无驱动二进制/引用 |
| `remote-debugging-port` / `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | 否 | 无调试端口/调试参数 |
| `webdriver` / `wdio` / `selenium` | 否 | 无 WebDriver 客户端/服务端代码 |
| `HIGHLIGHTER_R0_ALLOW_PRIMARY` | **是** | 测试专用开关（默认关闭、只读一次 env；行为见 §4.1） |
| `prototype-overlay` | 是 | 原型窗口标签（预期） |

- 依赖侧证据：`rust-app/src-tauri/Cargo.toml` 只依赖 tauri/serde/serde_json/highlighter-windows-platform，
  **没有** webdriver / test-server 类 crate；原型没有 HTTP/TCP 监听代码；命令面是固定的 9 个应用命令
  （`src/main.rs:834-846` 的 `invoke_handler`），其中没有一个测试端点。

### 8.2 三种 NSIS 安装器（packager 最终产物，独立 7-Zip 25.01 核对）

| 变体 | 大小（B） | SHA256 | 载荷（`7z l` 独立列目录） |
|---|---|---|---|
| downloadBootstrapper | 2,012,149 | `DDB4C403…4374` | `$PLUGINSDIR\*.dll/bmp` + `highlighter-r0-window.exe` + NSISdl.dll（下载式 WebView2 引导） |
| embedBootstrapper | 3,804,032 | `16361AD4…C752` | `$PLUGINSDIR\*.dll/bmp` + `$TEMP\MicrosoftEdgeWebview2Setup.exe`（1,897,688 B）+ `highlighter-r0-window.exe` |
| offlineInstaller | 219,793,431 | `97AD8212…0F19` | `$PLUGINSDIR\*.dll/bmp` + `$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe`（214,990,032 B）+ `highlighter-r0-window.exe` |

- **三种变体里都没有 msedgedriver / tauri-driver / WebDriver 文件**；载荷只有 应用 exe、WebView2 安装器、NSIS 插件 DLL。
- 三种变体**内嵌的应用 exe 完全相同**：8,928,768 B，SHA256 `36AE37CC447C28C467B648DB5C543DEA644B654121D58931BBB47233BD7F3ADB`
  （与 packager 提供的提取哈希一致；与 Release exe 不同是因为 bundler 打了 bundle-type 补丁）。
- 对该"用户实际安装到的 exe"做同样的字符串扫描：无 `msedgedriver/tauri-driver/webdriver/remote-debugging-port`，
  有 `HIGHLIGHTER_R0_ALLOW_PRIMARY`（测试开关）与 `prototype-overlay`。
- 三种安装器的原始二进制字符串扫描同样无驱动/调试串（NSIS 载荷压缩，二进制扫描不能替代 7z 载荷清单；两者都做了）。

### 8.3 仓库侧检查

- `git ls-files` 中没有任何 msedgedriver / tauri-driver / edgedriver 文件；
- `rust-app/target/release`（除 bundle 目录）下没有名字含 driver 的文件；
- `rust-app/target/release/bundle/nsis/` 只有安装器 setup exe 一个文件；
- 驱动与截图证据全部在 `.tmp-r07/`（`.tmp*` gitignore），不会进提交。

### 8.4 结论

**测试驱动不进入生产产物**：应用二进制/安装器载荷中没有驱动文件、没有 WebDriver 依赖、没有调试端口逻辑；
唯一的测试开关是测试专用、默认关闭、release 可用但生产不依赖（已在 §4.1 登记）。
未完成项：安装后目录清单/卸载注册项由 R0-07 负责（其 [r0-installation-matrix.md](r0-installation-matrix.md) §6.3
标注"待补测"），本文只引用其证据路径，不声称已验证。

## 9. 与现有 Playwright Electron E2E 的对照

现有 Electron E2E（`e2e/electron-app.js` + `playwright.config.js`，`npm run test:e2e`）用
`playwright._electron.launch` 直接启动 Electron 主进程，并在主进程里注入测试桩（对话框、故障捕获、数据根隔离）。
Tauri 没有 Electron 主进程，**不能复用这条启动路径**；tauri-driver 是官方给出的等价桌面驱动。

| 维度 | 现有 Playwright Electron | tauri-driver（本次实测） |
|---|---|---|
| 启动真实产品进程 | 是 | 是（EdgeDriver 启动 Tauri exe） |
| 渲染器 DOM/脚本 | 是（page API） | 是（execute sync/async） |
| 主进程侧注入（对话框桩/日志/故障） | 强 | 无主进程通道；需要宿主命令/测试钩子（R1） |
| 渲染器 console 采集 | 是（page.on console） | 未评估（可用 execute 读页面状态替代部分） |
| 截图 | 页面截图（合成结果） | Web 内容 alpha，不是桌面合成 |
| 多窗口 | 是 | 本原型不支持，未验证 |
| 跨平台 | Windows/macOS/Linux | Windows/Linux（tauri-driver 官方）；macOS 无 WKWebView 驱动 |
| 与产品代码的耦合 | 需在主进程注入测试钩子 | 通过 `tauri:options` 启动，无需改产品入口（但仍需测试开关处理单屏） |

**对 R1-e 的含义**：现有 Electron E2E 的"主进程测试桩"能力不能假设在 Tauri 侧存在；R1 需要宿主侧
测试钩子（命令或日志文件）来获得等价能力，且测试钩子必须只进测试构建（与计划 §10 一致）。

## 10. CI 计划（GitHub Windows runner，未实测）

本机不是 CI，以下为**候选计划**，需在 R1-e 用真实 runner 验证（§11 未验证项之一）。

### 10.1 步骤（建议实现为 `scripts/rust/` 下的一个 PowerShell 步骤或 YAML job）

1. checkout + 固定 rust 1.97.1（`rust-app/rust-toolchain.toml` 已固定）+ Node 24；
2. `cargo build --release -p highlighter-r0-window`（或用缓存产物，缓存 key 含 Cargo.lock）；
3. 解析 WebView2 Runtime 版本：
   `(Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv`；
4. 安装 tauri-driver：`cargo install tauri-driver --locked --version 2.1.0`（缓存 `$CARGO_HOME/bin`）；
5. 下载精确匹配的 msedgedriver：`https://msedgedriver.microsoft.com/<pv>/edgedriver_win64.zip`；
   记录 pv / driver 版本 / zip sha256 到构建产物（可追溯的"实际冻结"证据）；
6. 运行：
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/run-tauri-webdriver-probe.ps1 -App rust-app\target\release\highlighter-r0-window.exe -NativeDriver <msedgedriver.exe> -AllowPrimaryScreen -OutDir ci-evidence`；
7. 断言 `probe summary.json`：`exitCode=0`、`browserVersion==driverVersion`、`windowHandles.length==1`、
   `readyPoll.state.state=="ready"`、`inputInjection.clickCount==1`、`negativeMissingApplication.status>=400`；
8. 上传证据（`probe-log.jsonl / summary.json / screenshot.png / tauri-driver.*.log`），失败时也上传；
9. 结尾强制清理并断言无残留 `tauri-driver/msedgedriver/highlighter-r0-window` 进程。

### 10.2 版本冻结策略（关键取舍）

- **tauri-driver 固定 2.1.0**（cargo install 指定版本，或缓存二进制 + 哈希校验）；
- **msedgedriver 不在仓库写死版本号**，而在运行时按 runner 的 WebView2 `pv` 解析：GitHub runner 的 WebView2
  会随镜像更新，写死版本必然失效；把"实际解析到的 pv + driver 版本 + 哈希"写入 CI 产物，视为"本次运行的冻结记录"。
  若要完全可复现，必须自托管 runner 镜像并固定 WebView2 版本（成本/维护写进 ADR 未解决限制）。
- 若 `<pv>` 404（driver 未发布该 build），退化到 `LATEST_RELEASE_<major>` 并**校验 major/build**；
  匹配失败就 fail 并打印 pv，**禁止静默用错版本**（版本不匹配行为未验证，见 §11）。

### 10.3 风险（必须进 R1-e 的验收）

| 风险 | 影响 | 缓解 |
|---|---|---|
| runner WebView2 每周更新 | 精确版本驱动可能晚发布/404 | 运行时解析 + 版本断言 + 明确失败信息；必要时固定 runner 镜像 |
| 无 GPU 的 runner | 透明窗口/Canvas 渲染差异（AGENTS.md 已有 CI 渲染测试先例 D-01） | 本探针只断言 DOM/状态/协议，不断言像素级合成；像素证据另走宿主截屏 |
| 无 WebView2 Runtime / Runtime 损坏 | 弹阻塞对话框、挂起 | CI 预装并校验 pv；先跑版本级健康检查再跑 WebDriver |
| 受限会话 TMP 不可写 | 500 cannot create temp dir | wrapper 强制 TMP/TEMP 到 workspace |
| 端口冲突/并发 job | session 创建失败 | 每个 runner 独占 4444/4445；本地串行；支持改端口 |
| 应用 stdout 不落盘 | 失败定位困难 | 应用侧结构化日志文件（R1 需求）；同时采集 driver stderr |
| 会话残留进程 | 后续 job 干扰 | wrapper finally 清理 + 进程断言 |
| 超时 | 卡死 CI | new session 60 s、ready 15 s、整个 job 5 min 上限 |

## 11. 未验证 / 未解决限制（不得当成已通过）

1. **GitHub-hosted Windows runner 未实测**（本机不是 CI；GUI session/版本更新/无 GPU 差异均未知）。
2. **msedgedriver 版本不匹配行为未实测**（只安装了精确匹配的 157.0.4341.46）。
3. **无 WebView2 Runtime 的机器上 tauri-driver 行为未实测**；仅引用 R0-07 用同栈 PDF 原型观察到的阻塞 #32770 对话框（跨任务证据，未在本任务复现）。
4. **多窗口 / 托盘 / 主窗口 / 文件对话框 / 系统权限弹窗**：原型只有单窗口、无托盘，未验证。
5. **透明窗口的桌面合成、首帧白闪、鼠标穿透**：WebDriver 截图是 Web 内容 alpha，不覆盖这些；需要宿主截屏/真机人工验收。
6. **混合 DPI / 100% / 200%**：本机单屏只有 150%，未验证（R0-03 的真机 DPI 矩阵仍未做）。
7. **长时/并发稳定性**：只做了单次 session 与 close/crash 各 1 次；未做 N 次循环、并发 session、长时间运行。
8. **CDP 回退路线（B）未评估**：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` + Playwright
   `connectOverCDP` 未实测；本轮主路线可用，故未进入实现。
9. **`@wdio/tauri-service` / WebdriverIO 客户端未评估**（官方 2026 文档推荐的 Tauri 上层集成；需要引入测试插件，
   属于 R1 技术选型）。
10. **attach-to-existing-app 模式未验证**：tauri-driver 2.1.0 的 Windows 路径是 launch 模式
    （`tauri:options.application` → `ms:edgeOptions.binary`，源码 `server.rs` `into_native_object`）；attach 未测。
11. **应用 stdout/渲染器 console 采集**：launch 模式下应用 stdout 不可见；console 采集未评估。
12. **NSIS 安装后目录清单/卸载注册项**：由 R0-07 最终验证（packager 进行中/以其证据为准），本文只验证了安装器载荷。

## 12. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-11 | 建立本文：环境/版本冻结表；tauri-driver 2.1.0 + msedgedriver 157.0.4341.46 获取与哈希；真实 WebDriver session 全流程（full/close/crash/负样本）；能力矩阵；生产隔离（release + 三种 NSIS 载荷 7z 清单 + 内嵌 exe 哈希）；CI 候选计划；未验证清单 | 本文件 + `.tmp-r07/driver/` |
| 2026-11-11 | 新增测试专用开关 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`（cli.rs/monitors.rs/main.rs）并登记；debug/release 行为验证；单测 17 passed | `cargo test -p highlighter-r0-window --locked`；§4.1 |
| 2026-11-11 | 新增探针脚本 `scripts/rust/probe-tauri-webdriver.js` 与一键 `run-tauri-webdriver-probe.ps1`（含清理） | §5；SHA256 见附录 |
| 2026-11-11 | 补跑质量门禁：`cargo clippy -p highlighter-r0-window --all-targets -- -D warnings`（0 warning）、`cargo fmt -p highlighter-r0-window -- --check`、`cargo test -p highlighter-r0-window --locked`（17 passed）、`scripts/rust/check-rust-app.ps1`（fmt+clippy+test 全 workspace OK）全部通过 | 本段；命令可在仓库根复跑 |
| 2026-11-11 20:05 | **工作区 Low 完整性标签缺陷修复后复跑**（handoff/g0 §8.4）：`run-tauri-webdriver-probe.ps1 -NativeDriver …157.0.4341.46… -AllowPrimaryScreen` **exit 0**，session/handles/execute(document.title/page state)/host_list_monitors(1 display 150%)/W3C click/ready 轮询/screenshot(102,740 B, sha256 19a6fe3d…)/delete session/负样本全部通过；`browserVersion=157.0.4341.46`。本文 §11 未验证清单不变（CI runner/版本不匹配/多窗口/托盘/混合 DPI/长时稳定性仍未验证） | `.tmp-r07/driver/webdriver-ci/`（本机，gitignore） |

## 附录 A：证据文件与哈希（2026-11-11）

| 文件 | 大小（B） | SHA256（前 12 位…后 6 位） |
|---|---|---|
| `.tmp-r07/driver/cargo-install-tauri-driver.log` | 4,071 | `88C728D1892E…5B17B` |
| `.tmp-r07/driver/self-test-no-env.log` | 641 | `7EE90F5706AC…4BC5F` |
| `.tmp-r07/driver/self-test-allow-primary.log` | 2,473 | `18D4A13CE639…BACA` |
| `.tmp-r07/driver/release-self-test-no-env.log` | 641 | `7EE90F5706AC…4BC5F`（与 debug 输出相同） |
| `.tmp-r07/driver/release-self-test-allow-primary.log` | 2,473 | `18D4A13CE639…BACA` |
| `.tmp-r07/driver/version-evidence.txt` | 1,424 | `5EEBE7AFCA09…6E93` |
| `.tmp-r07/driver/tauri-driver-noenv.log` | 168 | `2A4AAF0BF5A6…45DD` |
| `.tmp-r07/driver/webdriver-no-env-session.json` | 1,059 | `4E6C663D6657…B9ED` |
| `.tmp-r07/driver/probe-run-wrapper.log` | 2,586 | `07A79E41AD0B…6F43` |
| `.tmp-r07/driver/webdriver-wrapper/probe-log.jsonl` | 144,028 | `EF744D10FBE5…D798` |
| `.tmp-r07/driver/webdriver-wrapper/summary.json` | 5,909 | `D778465235D6…E93C` |
| `.tmp-r07/driver/webdriver-wrapper/screenshot.png` | 102,740 | `19A6FE3DC340…34D` |
| `.tmp-r07/driver/webdriver-full/probe-log.jsonl` | 144,026 | `5144D031399B…B8A4` |
| `.tmp-r07/driver/webdriver-full/summary.json` | 5,903 | `AB40276C4C1C…852B` |
| `.tmp-r07/driver/webdriver-close/summary.json` | 6,150 | `CD7487BA99FC…9E24` |
| `.tmp-r07/driver/webdriver-crash/summary.json` | 6,273 | `A1584F2276D7…D1E3` |
| `.tmp-r07/driver/tauri-driver.log` | 0 | `E3B0C44298FC…B855`（空文件，证明 launch 模式无 stdout/stderr 输出） |
| `.tmp-r07/driver/install-inspect/offlineInstaller/highlighter-r0-window.exe` | 8,928,768 | `36AE37CC447C…3ADB`（从 NSIS 独立提取） |
| `scripts/rust/probe-tauri-webdriver.js` | 16,626 | `12ECFE641A27…AE46` |
| `scripts/rust/run-tauri-webdriver-probe.ps1` | 5,673 | `77AF9180AC97…A7D9` |
| `rust-app/target/release/highlighter-r0-window.exe` | 8,928,768 | `7C1A3DAEBCF8…5715` |
| NSIS offlineInstaller setup | 219,793,431 | `97AD8212A07C…0F19` |
| msedgedriver zip | 11,706,112 | `AD94F3A90CB9…9420` |
| msedgedriver.exe | 24,141,184 | `6C3FDCB995CD…BD8F` |
| tauri-driver.exe | —（CARGO_HOME） | `F497C9B3508D…071B` |

> 哈希为 SHA256；"前 12 位…后 6 位"为文档可读性截断，完整值可用 `Get-FileHash` 复核。
> 证据目录本身 gitignore；如需复核，在仓库根用附录里的命令重新生成，不应把大日志提交进仓库。
