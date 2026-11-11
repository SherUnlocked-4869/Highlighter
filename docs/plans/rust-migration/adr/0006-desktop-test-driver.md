# ADR-0006：桌面 E2E 测试驱动与版本

- 状态：**候选 A（tauri-driver 2.1.0 + 精确匹配 msedgedriver + 应用侧断言），待验证；G0 前不冻结**
- 决定批次：R0 / S0-3（task-2）；实施批次：R1-e（桌面 E2E 接入 CI，计划 §6.3）
- 日期：2026-11-11
- 关联计划：迁移计划 §2 决策表、§7 R0-03、§8 门禁、§10 测试驱动、§12；[r0-baseline.md](../r0-baseline.md) §4.7 / §6.2 S0-3
- 证据文档：[r0-test-driver.md](../r0-test-driver.md)；原始证据 `.tmp-r07/driver/`（gitignore）

## 1. 背景与问题

Tauri 替代 Electron 后，现有桌面 E2E（`e2e/electron-app.js`：Playwright `_electron.launch` 启动 Electron 主进程并注入测试桩）
**不能复用**：Tauri 没有 Electron 主进程。计划 §10 要求 R0 从官方 WebDriver 路径选定并锁版本，否则 R1/R5/R8 的桌面 E2E
（启动→窗口→ready/init→关闭、隔离根、崩溃恢复）没有落点，G0 报告的 D-02/D-03 等"真实桌面链路未自动化"缺口也无法关闭。

要回答的问题：官方 WebDriver 路径（tauri-driver → msedgedriver → WebView2）能否驱动**真实 Tauri 进程**完成
启动/窗口/脚本/IPC/输入/截图/关闭/崩溃观测；版本如何冻结；测试端点/驱动如何不进入生产包；CI 是否可行。

基线行为（源码证据）：R0-03 原型 `rust-app/src-tauri/` 用 `tauri.conf.json` 的 `app.windows=[]` 无窗口启动，
setup 钩子创建透明浮层、单次 ready/init 握手、`--self-test` 自检；默认只在副屏出窗（单屏 exit 2）。
本机为单屏，因此新增了**测试专用**开关 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`（见 §3 与 r0-test-driver.md §4.1）。

## 2. 备选方案

| 方案 | 描述 | 优点 | 代价/风险 |
|---|---|---|---|
| **A1 tauri-driver 直连（候选）** | `cargo install tauri-driver --locked`；Windows 用与 WebView2 Runtime 精确同版本的 msedgedriver；Node/Selenium 客户端发 W3C 协议 | 官方路径；无需改产品入口；本机**实测全流程通过**；无 npm 依赖探针即可跑 | tauri-driver 官方 README 标 "pre-alpha"；msedgedriver 版本必须精确匹配；launch 模式无主进程通道/应用 stdout |
| A2 webdriverio + @wdio/tauri-service | 官方 2026 文档推荐的上层封装（内嵌 WebDriver server 插件或外部 tauri-driver provider），跨平台含 macOS | 生态完整（console/log 采集、IPC mock、multiremote）；macOS 支持 | **本轮未评估**；需要给应用加测试插件（构建形态/依赖决策），macOS 需付费 CrabNebula fork；属 R1 选型 |
| B WebView2 CDP + Playwright | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` + Playwright `connectOverCDP` | 复用现有 Playwright 断言/截图生态 | **未验证**；需要应用侧调试参数/端口管理；Port/生命周期与产品安全边界更复杂；作为回退候选 |
| C 自研宿主 harness | spawn 宿主 + IPC/命令探针（R0-03 的 `--self-test` 已是雏形） | 简单、稳定，适合启动/退出/几何/进程树烟测 | 不能驱动 DOM/输入/页面状态；不能替代真实 E2E |
| D 无桌面自动化 | 只做单测/契约测试 + 真机人工清单 | 成本最低 | 不满足计划 §10 与 G0 的"真实桌面链路"要求，D-02/D-03 缺口无法关闭 |

## 3. 实测条件与命令

- 机器：SHERUNLOCK02，Windows 11 build 26300，i5-13500H 12C/16T，15.75 GiB，Intel Iris Xe；**单屏** 2240x1400@150%；
- 工具链：rustc/cargo 1.97.1（`rust-app/rust-toolchain.toml` 固定）；Node 24.15.0 / npm 11.17.0；CARGO_HOME=`D:\DevCache\cargo`；
- Tauri 栈：tauri 2.12.5 / tauri-build 2.7.4 / tauri-runtime-wry 2.12.3 / wry 0.57.2 / webview2-com 0.39.1；
- WebView2 Runtime：**157.0.4341.46**（注册表 Clients {F3017226-…} 的 `pv`）；
- 驱动：tauri-driver **2.1.0**（cargo install --locked；exe SHA256 `F497C9B3508D…071B`）；
  msedgedriver **157.0.4341.46**（官方 `https://msedgedriver.microsoft.com/157.0.4341.46/edgedriver_win64.zip`，
  zip SHA256 `AD94F3A9…9420`，exe SHA256 `6C3FDCB9…BD8F`）；
- 构建：`cargo build --manifest-path rust-app/Cargo.toml -p highlighter-r0-window`（debug 13.83 s；release 由 R0-07 产出，
  exe SHA256 `7C1A3DAE…5715`）；单测 `cargo test -p highlighter-r0-window --locked` → 17 passed；
- 探针：`scripts/rust/run-tauri-webdriver-probe.ps1` 一键启动/清理 `tauri-driver --port 4444 --native-port 4445
  --native-driver <msedgedriver.exe>`，Node 探针 `scripts/rust/probe-tauri-webdriver.js` 走原始 W3C 协议；
  单屏主机需 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1` 与仓库内可写 `TMP/TEMP`（受限宿主陷阱，见证据文档 §4）；
- 数据/样本：R0-03 原型 `prototype-ui` 受控页面（Canvas 自检图案），无真实用户数据/凭据。

## 4. 证据

| 验证项 | 命令/操作 | 结果 | 判定 |
|---|---|---|---|
| new session（真实 Tauri 进程） | `POST /session` + `tauri:options.application` | 200，565 ms，browserName=webview2，debuggerAddress 存在 | **通过** |
| 版本一致性 | capabilities | browserVersion = msedgedriverVersion = 157.0.4341.46 | **通过** |
| 窗口句柄 / 窗口矩形 | `GET /window/handles` / `/window/rect` | 1 句柄；rect 1494x934 @ (0,0)（CSS/DIP，非物理 2240x1400） | **通过（有限制）** |
| 脚本与 Tauri IPC | `/execute/sync`、`/execute/async` → `host_list_monitors` | title/DPR/HUD 可读；返回真实显示器 JSON | **通过** |
| 输入注入 | `POST /actions`（pointer move/down/up） | 页面 pointerdown 计数 = 1 | **通过** |
| ready/init 握手观察 | 轮询 HUD `data-state` | booting → ready；文案含 "ready -> init（单次）"（冷启动 259 ms） | **通过** |
| 截图 | `GET /screenshot` | PNG 2241x1401、带 alpha（半透明像素 A=41），**Web 内容而非桌面合成** | **通过（有限制）** |
| 关闭窗口 | `DELETE /session/{id}/window` | 200 `{"value":[]}` → 应用退出、session invalid、DELETE session 仍 200 | **通过（设计边界）** |
| 崩溃观测 | 强杀 `goog:processID` 进程 | 后续命令 404 `invalid session id`；驱动自身不崩 | **通过** |
| 失败分支：缺可执行文件 | 负样本 session | 500 `no msedge binary at <path>` | **通过（失败可观测）** |
| 失败分支：应用启动即退出 | 单屏不设开关 | session 500（`crashed / DevToolsActivePort`）+ driver stderr 有应用真实错误行（165 ms） | **通过（失败可观测）** |
| 失败分支：TMP 不可写 | 默认 TMP | 500 `cannot create temp dir for user data dir` | **通过（失败可观测）** |
| 生产隔离 | Release/NSIS 二进制扫描 + 7-Zip 载荷清单 | Release exe 与三种安装器内嵌 exe 均无 `msedgedriver/tauri-driver/webdriver/remote-debugging-port` 字符串；安装器载荷仅 应用 exe + WebView2 安装器 + NSIS 插件 | **通过** |
| 测试开关默认行为 | debug/release 各有/无 env | 无 env exit 2 无窗口；env=1 主屏出窗且自检如实打印 `target_primary=true allow_primary=true` | **通过** |
| msedgedriver 版本不匹配 | — | 只有精确匹配版本可用 | **未验证** |
| 无 WebView2 Runtime 机器 | — | 本机已安装；R0-07 用同栈原型观察到阻塞 #32770 对话框 | **未验证（跨任务证据）** |
| 多窗口/托盘/文件对话框 | — | 原型单窗口、无托盘 | **未验证（R1）** |
| 透明合成/白闪/鼠标穿透 | — | WebDriver 截图不覆盖桌面合成 | **未验证（需宿主截屏）** |
| 混合 DPI / 100%/200% | — | 本机单屏仅 150% | **未验证** |
| GitHub runner CI | — | 本机不是 CI | **未验证** |

**失败分支与负样本**（原始 JSON 见 [r0-test-driver.md](../r0-test-driver.md) §7）：缺可执行文件 → 500；单屏未开开关 →
应用 exit 2 + session 500（驱动文案归因 "msedge crashed"，需应用日志定位）；关窗 → session 立即失效；强杀 → 404 invalid session id。
上述均记录真实响应，未做美化。

## 5. 结论（建议）

1. **建议候选 A1**：R1-e 采用 **tauri-driver 2.1.0 + 与 WebView2 Runtime 精确同版本的 msedgedriver** 作为桌面 E2E 主驱动；
   冻结 `tauri-driver` 版本，msedgedriver 在运行时按 runner 的 `pv` 解析并记录（写死版本会随 runner 更新失效）。
2. **C（宿主 --self-test/进程探针）保留**为启动/退出/几何/进程树烟测（快、无外部驱动依赖），与 A1 互补，不作为唯一 E2E。
3. **A2（@wdio/tauri-service）在 R1 选型时评估**：如果 R1 需要 console/log 采集、IPC mock 或 macOS，A2 的价值明显；
   但引入测试插件会改变应用的构建形态，必须"仅测试构建"。
4. **B（CDP）作为回退候选**：若 tauri-driver/msedgedriver 在 CI 上不稳定（版本漂移、无 WebView2、驱动停更），
   再评估 `connectOverCDP`；本轮主路线可用，未投入实现。
5. **置信度**：本机真实 session 全流程通过（含 close/crash/负样本），驱动/版本/哈希/生产隔离证据完整；但 **CI runner、
   版本不匹配、无 Runtime、多窗口/托盘、混合 DPI、长时稳定性均未验证**，因此状态保持"候选/待验证"，G0 前不写冻结。
6. **测试开关登记**：单屏主机自动化用 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`（只在原型 `rust-app/src-tauri/src/`；
   默认关闭、未设置时行为与改动前完全一致、release 可用但生产不依赖）；R1 若需同类开关必须只进测试构建。

## 6. 未解决限制

1. GitHub-hosted Windows runner 未实测：WebView2 版本随镜像更新 → msedgedriver 精确匹配是**持续维护成本**；
   完全可复现需要自托管固定镜像。
2. msedgedriver 版本不匹配行为未知（可能报错、也可能部分可用），CI 失败信息需可诊断。
3. 无 WebView2 Runtime 的机器：会弹阻塞对话框/挂起（R0-07 跨任务观察），CI 必须预装并校验。
4. launch 模式**没有主进程通道**：无法像 Playwright Electron 那样 stub 原生对话框/注入主进程逻辑；
   应用 stdout 也不落盘（tauri-driver 把 native driver stdout 置 null）。R1 需要应用侧结构化日志/测试钩子。
5. 透明窗口的桌面合成/白闪/鼠标穿透、多窗口/托盘/主窗口、文件对话框、混合 DPI、长时/并发稳定性未验证。
6. tauri-driver 官方 README 标 "pre-alpha"；仅 Windows/Linux 有官方 native driver（macOS 需 A2/CrabNebula）。
7. CDP 回退与 WebdriverIO/A2 均未评估。

## 7. 责任批次与退出验收

- **决定批次**：R0（task-2，本 ADR + r0-test-driver.md）；**实施批次**：R1-e（计划 §6.3 "桌面 E2E 接入 CI"）。
- **退出验收（R1-e 必须全部满足才可把本 ADR 从"候选"改为"已选定"）**：
  1. GitHub Windows runner 上 `run-tauri-webdriver-probe.ps1` 连续 ≥ 5 次绿灯（new session / handles / execute+IPC /
     actions / ready / screenshot / delete 全通过，且无残留进程）；
  2. CI 产物记录本次实际 WebView2 `pv`、msedgedriver 版本与 zip sha256（可追溯冻结）；
  3. 版本解析失败/不匹配时 CI 明确 fail（不允许静默用错版本）；
  4. 失败分支（缺 exe / 启动即退出 / 关闭 / 崩溃）在 CI 上可观测，错误信息能定位到应用日志；
  5. 生产隔离复核：Release/NSIS 产物不含驱动/测试端点，测试开关只在测试构建；
  6. 至少 1 条"真实产品链路"用例（R1 的窗口角色/命令）经该驱动跑通，且不依赖 mock。
- **回退方式**：若 1 无法满足（例如 runner 环境限制），回退到 B（CDP+Playwright）或 C（宿主探针+人工清单），
  并保留"真实 Tauri 启动"证据；回退决定需重开 ADR。
- **变更记录中的"已选定"不得在本轮写入**；G0 判定以 [r0-g0-report.md](../r0-g0-report.md) 为准。

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-11 | 新建 ADR-0006：备选 A1/A2/B/C/D；本机实测 tauri-driver 2.1.0 + msedgedriver 157.0.4341.46（与 WebView2 Runtime 精确匹配）全流程通过；close/crash/负样本失败分支；生产隔离（Release exe + 三种 NSIS 载荷 + 内嵌 exe 哈希）；CI 候选计划与未验证项；状态=候选/待验证 | [r0-test-driver.md](../r0-test-driver.md)、`.tmp-r07/driver/`、`.tmp-r07/install/` |
| 2026-11-11 | 新增测试专用开关 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`（原型内，默认关闭）并在证据文档 §4.1 登记 | 本 ADR §3/§5.6；证据文档 §4.1 |
