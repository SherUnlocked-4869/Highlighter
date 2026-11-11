# R0-03 Tauri 透明窗口 / 截图浮层原型报告

日期：2026-11-10。状态：**R0 风险验证脚手架（不是生产宿主）**。上位文档：
[Rust 改造方案与开发计划](../2026-11-10-rust-migration-development-plan.md) §3.1、§4.3、§7 R0-03、§12；
[合同与夹具格式](contract-format.md)；[rust-app/README.md](../../../rust-app/README.md)。

对应共享任务：`task-4`（R0-03 Tauri 透明窗口/截图浮层原型）。

## 1. 目的与边界

本原型只回答 R0-03 中“最危险的窗口链路”能否在 Tauri 2 + WebView2 上成立：

1. 无窗口启动（配置文件不预建窗口），由 Rust 侧按需创建透明浮层；
2. 副屏定位（本机副屏在主屏上方，坐标为负），物理像素与 DIP 两种定位方式；
3. 页面 ready → 宿主 init（**只发一次**）→ 页面回报 `devicePixelRatio` / Canvas 尺寸的握手；
4. 显示器枚举（名称/缩放/物理与 DIP 位置尺寸）；
5. `--self-test` 无人值守自检：可见窗口**只允许出现在副屏**，打印验证行后 2~5 秒自动退出。

明确不是本任务范围（后续批次）：

- 托盘/单实例/自启/主窗口（R1-02）；
- 角色权限映射、CSP 收口、命令 ACL、窗口归属的完整校验（R1-04）；
- 真实截屏采集/遮罩编辑/保存（R4）、焦点与鼠标穿透策略（R3/R4）；
- 安装包、WebView2 分发方案、性能结论（R0-07/R8）。

## 2. 代码结构与启动

```text
rust-app/src-tauri/
  Cargo.toml                  # package: highlighter-r0-window；tauri 2 + tauri-build 2
  build.rs                    # tauri_build::build()
  tauri.conf.json             # app.windows=[]（无窗口启动）、frontendDist=prototype-ui、transparent 相关只由代码设置
  capabilities/prototype-overlay.json  # 最小 capability：只给浮层窗口 core:event:allow-listen
  icons/icon.ico              # 复制自 assets/icon.ico；tauri-build 在 Windows 上强制要求 .ico
  src/main.rs                 # 命令面、setup、--self-test 驱动、日志
  src/cli.rs                  # 参数解析（纯函数，单测）
  src/handshake.rs            # ready/init 单次握手与指标状态机（单测）
  src/monitors.rs             # 显示器快照/副屏选择/物理与 DIP 放置计算（纯算术单测）
  src/overlay.rs              # 创建/定位/显隐/销毁窗口，读回实际几何
  prototype-ui/index.html     # 受控原型页面（不引用 main/preload/node_modules）
  prototype-ui/canvas.js      # 先监听 init、再 ready，画自检图案并回报 DPR/Canvas 尺寸
```

`tauri.conf.json` 关键点：

- `app.windows: []`：**无窗口启动**，浮层由 `src/main.rs` 的 setup 钩子创建；
- `build.frontendDist: "prototype-ui"`：只嵌入受控原型目录；不收集 `main/`、`preload*.js`、
  `test/`、`node_modules/` 或用户数据；
- `withGlobalTauri: true`：原型页面只用 `window.__TAURI__`，不引入 npm 依赖；
- 最小 CSP（`default-src 'self'` 等，见文件）；
- `bundle.active: false`：不产出安装包。

浮层窗口属性（`src/overlay.rs`，创建时设置）：`transparent=true`、`decorations=false`、
`skip_taskbar=true`、`always_on_top=true`、`resizable=false`、`shadow=false`、
初始 `visible=false`、`focused=false`、`no_redirection_bitmap=true`（Windows 防白闪实验项）、
WebView2 数据目录固定到 `rust-app/target/r0-window-webview2-data`（gitignore，不碰真实数据根）。

## 3. 构建与运行命令

在仓库根目录执行（Windows；工具链由 `rust-app/rust-toolchain.toml` 固定到 1.97.1）：

```powershell
# 只编译本原型
cargo check --manifest-path rust-app/Cargo.toml -p highlighter-r0-window

# fmt / clippy / 单测（--locked 保证 Cargo.lock 与源码一致）
cargo fmt --manifest-path rust-app/Cargo.toml --all -- --check
cargo clippy --manifest-path rust-app/Cargo.toml -p highlighter-r0-window --all-targets -- -D warnings
cargo test --manifest-path rust-app/Cargo.toml -p highlighter-r0-window --locked

# 不破坏既有 crate 的门禁（fmt + clippy workspace + test workspace --locked）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1
```

运行（首次运行会编译 tauri/wry/WebView2 绑定，耗时较长）：

```powershell
# 人工模式：在副屏显示透明浮层 + Canvas 自检图案；关闭窗口即退出
cargo run --manifest-path rust-app/Cargo.toml -p highlighter-r0-window -- --self-test  # 见下
cargo run --manifest-path rust-app/Cargo.toml -p highlighter-r0-window                # 人工交互模式

# 无人值守自检：列显示器 -> 副屏铺满浮层 -> 等 ready/init/metrics -> 打印验证行 -> 2~5 秒退出
cargo run --manifest-path rust-app/Cargo.toml -p highlighter-r0-window -- --self-test
cargo run --manifest-path rust-app/Cargo.toml -p highlighter-r0-window -- --self-test --hold-ms 5000
cargo run --manifest-path rust-app/Cargo.toml -p highlighter-r0-window -- --self-test --monitor 1
```

参数：

| 参数 | 说明 |
|---|---|
| `--self-test` | 无人值守自检；成功打印 `[PASS] ...` 后按 `--hold-ms` 停留再退出 |
| `--hold-ms <ms>` | 自检/人工窗口停留毫秒数，**只允许 2000..=5000**，默认 3000 |
| `--monitor <index>` | 指定目标副屏序号（0 起；指向主屏会被拒绝） |
| `--help` / `-h` | 打印用法后退出 |

退出码：`0` 自检通过/正常退出；`2` 启动前失败（无副屏、无法识别主屏、参数错误、
窗口创建失败等，此时**不显示**可见窗口）；`3` 自检失败（握手超时、几何校验失败、
Canvas DPR 不符等，失败路径由运行时回收窗口后退出）。

安全约定（工作区 `AGENTS.md`）：**可见自动化窗口默认只放副屏**。未检测到副屏或无法识别
主显示器时，原型直接报错退出，不回退到主屏。人工验收若需要单屏情况，应先询问用户。

## 4. 自检做了哪些校验

`--self-test` 的流程与打印行（示例格式）：

```text
[r0-window] mode=self-test hold_ms=3000 protocol=r0-prototype-1
[r0-window] monitors=2
[monitors] monitor[0] name=... primary=true scale=1.50 dpi=144.0 position_physical=(0, 0) size_physical=... position_dip=(...) ...
[monitors] monitor[1] name=... primary=false ... negative_y=true
[monitors] target_index=1 ... negative_x=false negative_y=true
[overlay] created label=prototype-overlay role=capture-overlay ... transparent=true decorations=false skip_taskbar=true always_on_top=true visible=false
[overlay] dip_probe scale_source=primary primary_scale=1.50 rect_dip=(80, 80) 640x480 -> requested_position=(...) requested_size=960x720
[overlay] place_physical monitor_index=1 requested_position=(-?, -?) requested_size=...
[overlay] shown actual_position=(...) actual_inner_size=... actual_outer_size=... scale_factor=... visible=true
[handshake] ready window=prototype-overlay count=1
[handshake] init sent once window=prototype-overlay event=prototype:init protocol=r0-prototype-1 generation=1
[metrics] window=prototype-overlay dpr=1.5 canvas_css=...x... canvas_px=...x... inner=...x... screen=(...) paint_count=1 user_agent="..."
[self-test] ready_received count=1 init_sent_once=true metrics_reports=1
[self-test] metrics dpr=1.5 ...
[self-test] canvas_pixel_matches_dpr=true
[self-test] overlay actual_position=(...) requested_position=(...) actual_inner_size=... visible=true
[self-test] overlay inside_target_monitor=true target_index=1 target_origin=... target_size=...
[PASS] r0-03 self-test: secondary_monitor_index=1 negative_y=true ready/init_once ok dpr=1.5 canvas_dpr_ok=true
[self-test] result exit_code=0 primary_scale=1.50 monitors=2
[self-test] hold_ms=3000; overlay stays on the secondary display for inspection, then exits
[self-test] closing overlay
[r0-window] event loop exited code=0
```

通过条件（任一失败即 `[FAIL]` + 退出码 3）：

1. 存在非主显示器，且目标副屏不是主屏；
2. 浮层实际可见，实际位置与请求位置相差 ≤ 8px（DWM/DPI 允许的微调），且落在目标副屏 bounds 内；
3. 至少收到一次页面 ready，init 恰好发送一次（重复 ready 不重发）；
4. 收到页面指标回报，`devicePixelRatio > 0`，`paint_count ≥ 1`；
5. Canvas 像素缓冲尺寸 ≈ CSS 尺寸 × `devicePixelRatio`（±1px 舍入）。

自检**只验证几何/握手/DPI 数值**；窗口外观（透明合成、首帧白闪、清晰度）需要人工目视，
见 §7 与 §9 的“未实测”登记。

## 5. 原型隔离缺口（计划 §4.3）

Tauri 官方文档明确：**应用通过 `invoke_handler` 注册的命令默认不经过 capability ACL**，
任何窗口/页面都可以调用（capability 文件主要约束插件与核心权限）。因此本原型的隔离现状是：

- `capabilities/prototype-overlay.json` 只授予 `core:event:allow-listen`，且只匹配窗口标签
  `prototype-overlay`；它**不能**阻止其他窗口调用 `host_*` / `prototype_*` 应用命令；
- 命令入口做了**纵深防御**：`prototype_ready` / `prototype_report_metrics` 校验调用窗口标签
  必须是 `prototype-overlay`，否则返回 `window-owner-mismatch`（沿用 host-contracts 里的
  错误码名）；创建/定位/显隐命令也校验目标显示器必须是副屏（`secondary-monitor-required`）；
- 但这只是“单窗口原型里的标签校验”，不等价于 R1-04 要做的角色/命令/资源归属权限映射。
  R1 必须用应用命令 ACL（`tauri_build` 的 `app_manifest` 生成 `allow-*` 权限）或命令内
  角色能力登记来真正隔离，并补“低权限窗口调用高权限命令失败”的测试（计划 R1-04/R1-06）；
- 原型未实现 CSP 之外的资源代理/自定义协议鉴权，也没有托盘、主窗口、多窗口场景；
- `window.__TAURI__` 全局可用（`withGlobalTauri: true`）只为了让原型页面不引入前端构建链，
  正式页面应走受控 bridge，不能把全局 API 当作安全边界。

## 6. WebView2 透明窗口已知限制

以下为 R0 观察与官方/社区已知限制，**R3/R4 必须真机逐项复核**：

1. **透明与合成**：`transparent=true` 要求页面 `html/body` 背景透明，否则 WebView2 铺白底；
   透明区域仍接收鼠标/键盘命中，原型**没有**实现点击穿透（`WS_EX_TRANSPARENT`）或
   逐像素命中，真实截图遮罩的鼠标策略在 R3/R4 另行验证；
2. **首帧白闪**：透明窗口创建/显示顺序不当会闪白。原型用“隐藏创建 → 定位 → show”+
   `no_redirection_bitmap(true)`（`WS_EX_NOREDIRECTIONBITMAP`）规避；该选项在部分机器/
   显卡驱动组合上可能有副作用，属于待真机矩阵验证项；
3. **焦点/激活**：`focused=false` 创建后 `show()` 可能仍抢占前台；`always_on_top` 与
   焦点关系、屏幕阅读器/输入法行为未验证，R1-02 需要托盘启动与焦点策略；
4. **DPI**：WebView2 的 `devicePixelRatio` 随窗口所在显示器缩放变化；跨屏拖动时
   `devicePixelRatio` 与窗口重排时机需要真机确认（本原型只在启动时读取一次）；
5. **进程模型**：WebView2 会派生子进程组（`msedgewebview2.exe`），进程组归属/回收在
   R0-03 验收项里记录，但本原型自检不强制校验子进程数；
6. **CSP**：原型配了最小 CSP，但 `withGlobalTauri` 需要 Tauri 注入初始化脚本；若后续收紧
   CSP，需要按 Tauri 的非ce/hash 注入规则验证，R1-04 统一处理；
7. **无边框窗口**：`decorations=false` 后没有系统拖拽/缩放；遮罩类窗口不应拖拽，但
   R1 的主窗口/辅助窗口需要各自的窗口装饰策略。

## 7. 人工验收步骤（100 / 150 / 200% DPI、负坐标/副屏）

前置：确认显示器拓扑；**可见窗口只允许放副屏**。本机（2026-11-10，`--self-test` 实测）环境：

- `monitor[0]`：`\\.\DISPLAY1`，主屏，3840x2160 物理像素，**150%** 缩放，原点 (0, 0)；
- `monitor[1]`：`\\.\DISPLAY2`，副屏，**竖屏 1440x2560** 物理像素，**125%** 缩放，
  原点 **(3840, -170)**（在主屏右侧、且上方越出主屏 170px，因此 y 为负）；
- 虚拟桌面物理范围 5280x2560；WebView2 Runtime 157.0.4341.42。

注意：环境并非“两块屏都 150%”，而是**混合 DPI（150% + 125%）**。这反而覆盖了更关键的
“目标屏缩放与主屏缩放不同”的情况；150% 下 DIP 定位命令使用主屏缩放（任务措辞），目标屏
实际缩放为 125%，两者的差异已登记为 R3 待冻结项（见 §6/§10）。若机器没有副屏，先询问用户，
不要在主屏开窗。

### 7.1 基线（本机 150% + 125%）

1. 运行 `cargo run --manifest-path rust-app/Cargo.toml -p highlighter-r0-window -- --self-test --hold-ms 5000`；
2. 核对 stdout：
   - `monitors=2`，目标副屏 `primary=false`、`origin_physical=(3840, -170)`、`negative_y=true`；
   - `[overlay] shown ... visible=true`，`requested_position` 与 `actual_position` 一致（≤8px）；
   - `[handshake] ready count=1`、`init sent once`、重复 ready 不重发；
   - `[metrics] dpr=1.25`（目标屏 125%），`canvas_px = canvas_css × 1.25`；
   - `[PASS] ... negative_y=true ...`，退出码 0；进程退出后无残留窗口/进程（§7.4）。
3. 目视检查副屏（窗口停留 5 秒）：
   - 只出现在副屏，主屏无任何窗口/任务栏按钮；
   - 透明区域能看到桌面色，棋盘格半透明；四角标记与边框贴合副屏边缘；
   - 中心十字/圆/100px 刻度与文字清晰、无拉伸错位，无白闪/黑帧。

### 7.2 DPI 矩阵（100 / 150 / 200%）

1. Windows 设置 → 系统 → 显示 → 选中副屏 → 缩放，依次设为 100% / 150% / 200%
   （必要时注销再登录，让 WebView2 重新读取缩放）；
2. 每次重跑 §7.1 的自检，核对：
   - 100%：`dpr=1.0`，`canvas_px == canvas_css`，窗口物理尺寸 == 副屏分辨率；
   - 150%：`dpr=1.5`，`canvas_px ≈ 1.5 × canvas_css`；
   - 200%：`dpr=2.0`，`canvas_px ≈ 2 × canvas_css`；
   - 三种缩放下 `actual_position == monitor origin`（含负值）、图案无模糊/拉伸；
3. 记录每档的 `[metrics]` 行与人工目视结论到本文件 §9。

### 7.3 负坐标/副屏

1. 确认副屏位置：Windows 显示设置里把副屏拖到主屏**上方/左侧**（本机为上方，副屏 y 为负），
   应用后重跑自检；
2. 核对 `[monitors]` 中目标副屏 `position_physical` 为负、`negative_x/negative_y` 标志正确，
   `[overlay] requested_position` 等于副屏原点且为负；
3. 目视确认窗口完整出现在副屏（不允许半截落在主屏或屏幕外）；
4. 无副屏场景：在**用户确认**后临时只保留一块显示器（或远程桌面单屏），重跑自检，预期
   `[FAIL] startup code=no-secondary-monitor...`、退出码 2、主屏**不出现**窗口。
   不要在未确认时改动用户显示配置。

### 7.4 退出与残留检查

自检退出后：

```powershell
Get-Process highlighter-r0-window -ErrorAction SilentlyContinue    # 应无输出
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
  Where-Object { $_.CommandLine -like '*r0-window-webview2-data*' }   # 应无输出
```

再确认桌面副屏上无残留可见窗口、任务栏无图标。人工模式下关闭窗口应等价退出（退出码 0）。

## 8. 已实测 / 未实测清单

**实测方式**：命令输出（stdout/stderr）、进程与窗口残留检查、必要时副屏截屏核对。
不伪造 GUI 目视结论。

### 8.1 已实测

实测命令均在 `F:\workspace\Highlighter`（工作区 root，2026-11-10）执行，真实输出见 §9。

- [x] `cargo check -p highlighter-r0-window`：通过（首次含依赖编译，`Finished dev profile ... in 1m 01s`）。
- [x] `cargo clippy -p highlighter-r0-window --all-targets -- -D warnings`：通过（0 warning，2s 增量）。
- [x] `cargo test -p highlighter-r0-window --locked`：**15 passed, 0 failed**（cli 5 + handshake 3 + monitors 7）。
- [x] `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust/check-rust-app.ps1`：
      通过（fmt + workspace clippy + workspace test --locked 全绿，未破坏既有 crate；耗时见 §9.1）。
- [x] `--self-test`（`--hold-ms 5000`）：**PASS**，退出码 0；真实 stdout 见 §9.2。
- [x] 运行后无残留进程/可见窗口：`highlighter-r0-window` 进程 0、本原型数据目录的
      `msedgewebview2.exe` 进程 0；退出后虚拟桌面截图确认副屏恢复原状。
- [x] 无人值守外观核对：运行中抓取整个虚拟桌面物理像素截图（per-monitor DPI aware v2），
      确认浮层覆盖副屏、透明区域可见桌面色、Canvas 图案与文字清晰、主屏无窗口；截图在
      `.tmp-r0/virtual-screen.png` / `.tmp-r0/virtual-screen-after.png`（scratch，不提交）。
- [x] WebView2 进程组观察：运行时本原型数据目录下 `msedgewebview2.exe` 共 **6 个**（1 个直接子进程 + 5 个其子进程），退出后归零。

### 8.2 未实测 / 需要人工验收

- [ ] 100% / 200% 两档 DPI 的真机视觉验收（本机只观察到 150% + 125% 混合 DPI；未改系统缩放）
- [ ] 125% 之外目标屏缩放下的 DIP 定位语义（本原型按任务要求用**主屏**缩放换算；目标屏 125%，
      两者差异属于 R3 待冻结项）
- [ ] 首帧白闪的逐帧录像（只做了运行中的静态截图，未证明“无闪”）
- [x] 单屏/无副屏场景：2026-11-11 在单屏主机实测，无副屏时拒绝建窗、退出码 2、无残留（见 §11.1）
- [ ] 混合 DPI 跨屏拖动、`devicePixelRatio` 动态变化（本原型只在启动时读取一次；
      实测页面 `screenX/screenY` 为 (2560,-136)，宿主物理坐标为 (3840,-170)，
      说明 WebView2 的 `window.screenX/screenY` 在混合 DPI 下不可直接当物理坐标用）
- [ ] 鼠标穿透/焦点/输入法行为（原型未实现点击穿透；`focused=false` 后 `show()` 是否抢焦点未断言）
- [ ] 200% 下 4K 分辨率、GPU/软渲染差异、远程桌面/多显卡场景
- [ ] 安装包/WebView2 分发（R0-07/R8）

## 9. 证据与测量

### 9.1 构建

- 工具链：rustc/cargo 1.97.1（`rust-app/rust-toolchain.toml` 固定）。
- 依赖：`tauri 2.12.5`、`tauri-build 2.7.4`、`wry 0.57.2`、`tao 0.37.2`、
  `webview2-com 0.39.1`（以 `rust-app/Cargo.lock` 为准）。
- `rust-app/Cargo.lock`：`[[package]]` 由 **18 → 427**（新增 **409** 个包，tauri 依赖树）。
- 体积：`rust-app/target` 由 **289 MiB（加 tauri 前）→ 1.1 GiB（cargo check 后）→
  2.5 GiB（cargo test 后）→ 2.9 GiB（cargo build + 门禁后）**；debug 可执行文件
  `rust-app/target/debug/highlighter-r0-window.exe` 约 **13.3 MB**。target 在 `.gitignore` 内。
- 耗时（本机，cargo 报告，依赖已下载到 `~/.cargo` 后）：
  - 首次 `cargo check -p highlighter-r0-window`：**1m 01s**（同时编译 tauri 全量依赖；
    下载 crates.io 依赖的时间未单独计时）；
  - `cargo clippy -p ... --all-targets -- -D warnings`：增量 **2s**，0 warning；
  - `cargo test -p ... --locked`：增量 **29s**（首次编译 test profile），15 tests passed；
  - `cargo build -p ...`：增量 **6s**；
  - `scripts/rust/check-rust-app.ps1`：增量 **6s** 通过（fmt + workspace clippy +
    workspace test --locked；全量测试合计 **107 passed / 0 failed**，含既有 crate 的 92 项）。
- 注意：仓库没有把 `cargo tauri build` 作为门禁；本原型用裸 `cargo run` 启动（未启用
  `custom-protocol` 特性也会嵌入 `frontendDist` 静态资源，见 tauri-codegen 逻辑）。

### 9.2 自检运行（真实输出，2026-11-10）

命令：`rust-app/target/debug/highlighter-r0-window.exe --self-test --hold-ms 5000`
（等价 `cargo run -p highlighter-r0-window -- --self-test --hold-ms 5000`）。退出码 **0**。

关键 stdout 行（原样摘录）：

```text
[r0-window] mode=self-test hold_ms=5000 protocol=r0-prototype-1
[r0-window] monitors=2
[monitors] monitor[0] name=\\.\DISPLAY1 primary=true scale=1.50 dpi=144.0 position_physical=(0, 0) size_physical=3840x2160 position_dip=(0, 0) size_dip=2560x1440 work_area_physical=(0, 0) 3840x2112
[monitors] monitor[1] name=\\.\DISPLAY2 primary=false scale=1.25 dpi=120.0 position_physical=(3840, -170) size_physical=1440x2560 position_dip=(3072, -136) size_dip=1152x2048 work_area_physical=(3840, -170) 1440x2520
[monitors] target_index=1 name=\\.\DISPLAY2 primary=false scale=1.25 origin_physical=(3840, -170) size_physical=1440x2560 negative_x=false negative_y=true
[overlay] created label=prototype-overlay role=capture-overlay title="Highlighter R0-03 capture overlay prototype" transparent=true decorations=false skip_taskbar=true always_on_top=true visible=false
[overlay] dip_probe scale_source=primary primary_scale=1.50 rect_dip=(80, 80) 640x480 -> requested_position=(3960, -50) requested_size=960x720
[overlay] place_physical monitor_index=1 requested_position=(3840, -170) requested_size=1440x2560
[overlay] shown actual_position=(3840, -170) actual_inner_size=1440x2560 actual_outer_size=1440x2560 scale_factor=1.25 visible=true
[handshake] ready window=prototype-overlay count=1
[handshake] init sent once window=prototype-overlay event=prototype:init protocol=r0-prototype-1 generation=1
[metrics] window=prototype-overlay dpr=1.25 canvas_css=1152x2048 canvas_px=1440x2560 inner=1152x2048 screen=(2560, -136) paint_count=1 user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0"
[self-test] ready_received count=1 init_sent_once=true metrics_reports=1
[self-test] canvas_pixel_matches_dpr=true
[self-test] overlay actual_position=(3840, -170) requested_position=(3840, -170) actual_inner_size=1440x2560 visible=true
[self-test] overlay inside_target_monitor=true target_index=1 target_origin=(3840, -170) target_size=1440x2560
[PASS] r0-03 self-test: secondary_monitor_index=1 negative_y=true ready/init_once ok dpr=1.25 canvas_dpr_ok=true
[self-test] result exit_code=0 primary_scale=1.5 monitors=2
[self-test] hold_ms=5000; overlay stays on the secondary display for inspection, then exits
[self-test] closing overlay
[r0-window] event loop exited code=0
```

按受控实验读取到的结论：

1. 副屏是竖屏 1440x2560、125%，原点 (3840, **-170**)（负 y）；
2. 全屏物理放置请求 = 实际（逐像素相等），窗口完全落在副屏内、`visible=true`；
3. `devicePixelRatio=1.25` 与目标屏 125% 一致；Canvas CSS 1152x2048 → 像素缓冲
   1440x2560（`canvas_matches_dpr=true`），证明页面按 DPR 放大正确；
4. ready 1 次、init 恰好发送 1 次，指标回报 1 次；
5. 运行中虚拟桌面截图（`.tmp-r0/virtual-screen.png`，per-monitor DPI aware v2、物理像素
   5280x2560）确认：浮层只覆盖副屏，透明区域可见桌面色，Canvas 边框/四角标记/中心十字/
   刻度/文字清晰，主屏未被遮挡；退出后截图（`...-after.png`）确认副屏恢复、无残留窗口；
6. 进程清理：运行中本原型 WebView2 数据目录下 `msedgewebview2.exe` 6 个（父 PID 链到
   本进程），退出后 `highlighter-r0-window` 与相关 `msedgewebview2.exe` 均为 0。

同时观察到 2 个**待 R3 核对**的现象（已登记 §6/§8.2，不作为 R0 通过条件）：

- 页面 `window.screenX/screenY` 报 (2560, -136)，而宿主物理坐标是 (3840, -170)；
  `3840/1.5=2560`、`-170/1.25=-136` 说明 WebView2 在混合 DPI 下对 `screenX/screenY` 的
  折算不统一，页面侧不能把 `screenX/Y` 当物理坐标用；
- DIP 定位命令按任务措辞用**主屏**缩放（1.5）换算，而目标屏实际 125%；目标屏 125% 时
  若按目标屏缩放应得 (3940, -70)/(800x600)，两种语义须在 R3 决定（计划 §4.2 `WindowHost`）。

### 9.3 已知风险/回退

- 原型窗口创建失败或 --self-test 失败时，不会留下可见窗口在主屏；退出码非 0 便于 CI/脚本判定。
- 若 `no_redirection_bitmap` 在目标机器导致透明失效，先回退该选项（保留“隐藏创建→定位→show”
  的防闪顺序），再复测；该实验项不影响命令面与握手链路。
- 回退方式：删除 `rust-app/src-tauri/` 并从 `rust-app/Cargo.toml` 的 `members` 移除 `src-tauri`，
  重新生成 `rust-app/Cargo.lock`；既有 crate 与 Electron 入口不受影响。

## 10. 与后续批次的衔接

| 本原型结论 | 后续动作 |
|---|---|
| 无窗口启动 + 运行时创建透明浮层可行 | R1-02 `WindowHost` 角色注册、generation、托盘/单实例 |
| 显示器枚举与负坐标物理定位可行（仅单屏一次读取） | R3 真机 DPI 矩阵、跨屏/焦点、Win32 DIP 坐标核对 |
| ready/init 单次握手链路成立 | R1-02/R1-06 事件定向、丢消息/越权/旧事件回流测试 |
| `invoke_handler` 命令默认全窗口可调用的缺口 | R1-04 命令 ACL/角色能力登记 + 入口二次校验 |
| WebView2 透明窗口存在首帧/焦点/鼠标穿透限制 | R4 截图遮罩交互策略，必要时原生遮罩/输入方案 |

> 本文件是 R0 原型证据，不构成生产合同；生产协议的冻结在 R1。
## 11. 续作轮（2026-11-11，当前机器）：单屏拒绝路径与测试开关实测

> 背景：续作会话运行在另一台机器（仅 1 块 2240×1400@150% 屏，无副屏；环境事实见
> [r0-baseline.md](r0-baseline.md) §9）。原机的副屏/负坐标矩阵本机无法重跑；本轮只验证
> **单屏拒绝路径**与**测试开关下的主屏建窗链路**，不替代 §7 的 DPI/副屏矩阵，也不改变 §8.2 的未验证项。

### 11.1 单屏拒绝路径（不创建可见窗口）

命令（仓库根，debug 构建，2026-11-11 12:50）：

```powershell
rust-app\target\debug\highlighter-r0-window.exe --self-test --hold-ms 3000
```

真实结果：退出码 **2**，耗时约 33 ms，窗口从未创建（日志显示在创建前失败），无残留进程。
关键 stdout/stderr 摘录：

```text
[r0-window] mode=self-test hold_ms=3000 protocol=r0-prototype-1
[r0-window] monitors=1
[monitors] monitor[0] name=\\.\DISPLAY1 primary=true scale=1.50 dpi=144.0 position_physical=(0, 0) size_physical=2240x1400 position_dip=(0, 0) size_dip=1493x933 work_area_physical=(0, 0) 2240x1352
[FAIL] startup code=secondary-monitor-required message=no-secondary-monitor: 未检测到副屏；原型拒绝在主屏创建可见窗口（不创建、不显示）
（stderr）[r0-window] startup failed: secondary-monitor-required (...)
```

核对：`Get-Process highlighter-r0-window` 无输出；关联本原型 WebView2 数据目录的
`msedgewebview2.exe` 为 0；任务栏/桌面无窗口。结论与 §7.3 第 4 条预期一致：**无副屏时不回退主屏、不创建窗口**。
该项从"需用户确认后才能测试"变为"本机（原生单屏环境）实测"。
证据（scratch，gitignore）：`.tmp-r07/window/single-screen.stdout.txt`、`.tmp-r07/window/single-screen.stderr.txt`。

### 11.2 测试专用开关 HIGHLIGHTER_R0_ALLOW_PRIMARY

单屏主机上 ADR-0006 的 WebDriver 探针与 R0-07 性能对照需要真实建窗；为此新增一个**测试专用、显式 opt-in**
的环境开关（`rust-app/src-tauri/src/cli.rs`、`monitors.rs`、`main.rs`）：

- 只认 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1`（去空白后严格等于 `1`），默认未设置；
- `select_target`：默认路径**直接委托原 `select_secondary`**（零语义变化）；开关打开时优先副屏、无副屏才退回主屏；
- 命令面的 `require_secondary`、`--self-test` 的通过条件都按开关区分，日志如实打印
  `allow_primary=true` 与 "NOT a secondary-monitor verification"，**不会**把主屏结果伪装成副屏通过；
- 新增 3 个单测；`cargo test -p highlighter-r0-window --locked` 为 **17 passed / 0 failed**（原 15 + 新增 2）；
- 生产包不应依赖该 env；它只存在于 R0 原型，用于单屏自动化。

实测（Release 构建，2026-11-11 13:14，`rust-app\target\release\highlighter-r0-window.exe`）：

| 场景 | 结果 |
|---|---|
| 未设置 env + `--self-test` | 退出码 **2**，`[FAIL] secondary-monitor-required`，无窗口、无残留（与改动前完全一致） |
| `HIGHLIGHTER_R0_ALLOW_PRIMARY=1` + `--self-test --hold-ms 2000` | 退出码 **0**；`target_index=0 primary=true`；overlay `requested_position=(0,0) size=2240x1400`，`actual_position=(0,0)`、`actual_inner_size=2240x1400`（逐像素相等）；`dpr=1.5`；`canvas_css=1494x934` → `canvas_px=2241x1401`（= css×1.5 ±1）；ready=1、init=1、metrics=1；`[PASS] ... target_primary=true allow_primary=true`；无残留进程 |

关键输出摘录：

```text
[self-test] allow_primary=true target_primary=true source=HIGHLIGHTER_R0_ALLOW_PRIMARY (test-only switch; NOT a secondary-monitor verification)
[PASS] r0-03 self-test: secondary_monitor_index=0 target_primary=true allow_primary=true negative_y=false ready/init_once ok dpr=1.5 canvas_dpr_ok=true
[self-test] result exit_code=0 primary_scale=1.5 monitors=1 target_primary=true allow_primary=true
```

**该 PASS 不是副屏验证**：它只证明单屏主机上透明浮层创建、物理定位、ready/init 单次握手、
Canvas DPR 换算与退出清理链路可用；副屏覆盖、负坐标、混合 DPI 语义仍需原机/真实双屏复核。
证据（scratch，gitignore）：`.tmp-r07/window/release-allow-primary.stdout.txt`、`.tmp-r07/window/release-noenv.stdout.txt`。

### 11.3 本机仍不可覆盖的项

- 100% / 200% DPI 视觉矩阵（需改系统缩放并重新登录，属用户操作）；
- 副屏覆盖、负坐标放置、混合 DPI 跨屏拖动（本机无副屏）；
- 首帧白闪逐帧录像、鼠标穿透/焦点/输入法行为；
- 4K/200% 与独显/软渲染差异（本机为 2240×1400 核显）。

> 本节结论只补充"单屏拒绝路径可实测"与"测试开关可用"两点；§7 的矩阵与 §8.2 的其余未验证项状态不变。

## 12. 2026-11-11 晚：回到原机（双屏、混合 DPI、负 Y 原点）复验

**机器**：handoff §8 记的“原机”（SHERUNLOCK / MSN）：Ryzen 7 9850X3D、47.15 GiB、RTX 5070 Ti 独显；
双屏 `DISPLAY1` 主屏 3840×2160@**150%** 原点 (0,0)、`DISPLAY2` **竖屏 1440×2560@125%** 物理原点
**(3840, −170)**（负 Y；虚拟桌面 5280×2560）；Windows 11 专业版 26300；WebView2 157.0.4341.46。
工作区完整性标签在本机二次复现为 Low 并由 Lead 修复为 Medium（命令与取证见
[r0-media-native.md](r0-media-native.md) §4.16 与 `.tmp-r0-acl/`）。修复后工作区内 exe 标签为 Medium，
`whoami.exe` 副本实测以 **Medium IL** 运行；native-capture 自报 `Medium(0x2000)`。
（R0-03 原型本身不打印进程 IL，属同目录同标签推断，未单独取证。）

### 12.1 自检复跑（4 次，全部 PASS）

命令（仓库根）：

```powershell
cargo build --manifest-path rust-app/Cargo.toml -p highlighter-r0-window --release --locked
.\rust-app\target\release\highlighter-r0-window.exe --self-test --hold-ms 2000   # run1..run3
.\rust-app\target\release\highlighter-r0-window.exe --self-test --hold-ms 5000   # run4（截图用）
```

4 次运行的 `[monitors]/[overlay]/[metrics]/[PASS]` 关键行完全一致（原文）：

```text
[r0-window] monitors=2
[monitors] monitor[0] name=\\.\DISPLAY1 primary=true scale=1.50 dpi=144.0 position_physical=(0, 0) size_physical=3840x2160 position_dip=(0, 0) size_dip=2560x1440 work_area_physical=(0, 0) 3840x2112
[monitors] monitor[1] name=\\.\DISPLAY2 primary=false scale=1.25 dpi=120.0 position_physical=(3840, -170) size_physical=1440x2560 position_dip=(3072, -136) size_dip=1152x2048 work_area_physical=(3840, -170) 1440x2520
[monitors] target_index=1 name=\\.\DISPLAY2 primary=false scale=1.25 origin_physical=(3840, -170) size_physical=1440x2560 negative_x=false negative_y=true
[overlay] shown actual_position=(3840, -170) actual_inner_size=1440x2560 actual_outer_size=1440x2560 scale_factor=1.25 visible=true
[metrics] window=prototype-overlay dpr=1.25 canvas_css=1152x2048 canvas_px=1440x2560 inner=1152x2048 screen=(2560, -136) paint_count=1
[self-test] overlay inside_target_monitor=true target_index=1 target_origin=(3840, -170) target_size=1440x2560
[PASS] r0-03 self-test: secondary_monitor_index=1 target_primary=false allow_primary=false negative_y=true ready/init_once ok dpr=1.25 canvas_dpr_ok=true
[self-test] result exit_code=0 primary_scale=1.5 monitors=2 target_primary=false allow_primary=false
```

即：目标=副屏（非主屏、非测试开关）、负 Y 原点定位正确、requested == actual 位置一致、
ready/init 各一次、`dpr=1.25` 与 `canvas_px = canvas_css × 1.25` 一致、`exit_code=0`。
与 2026-11-10 本机基线对比：除 WebView2 .42→.46 与 ACL 修复外无差异，属可重复复现。

### 12.2 画面核对（副屏截图 + 主屏无窗）

运行中抓取整虚拟桌面物理像素（per-monitor DPI aware v2，`.tmp-r0/capture-screen.ps1`，只读），
再按副屏区域 (3840,−170,1440×2560) 与主屏区域裁剪：

- 副屏 during：透明浮层覆盖整个副屏，能看到桌面色；棋盘格半透明、四角/边框标记贴合副屏边缘；
  中央十字+圆+100px 刻度与左下 `R0-03 原型 ready … devicePixelRatio = 1.25 / canvas CSS = 1152 x 2048 /
  canvas 像素 = 1440 x 2560 / window.screen = (2560, -136) / 握手 = ready → init（单次）` 文字清晰、无拉伸；
- 副屏 after：浮层已退出，桌面恢复原状（无残留窗口）；
- 主屏 during：只有用户自己的窗口，**主屏没有任何浮层/任务栏按钮**。

证据（scratch，gitignore）：`.tmp-r0/round3/{virtual-screen-before,during,after}.png`、
`{secondary,primary}-during.png`、`secondary-after.png`、`capture-*.log`、`env.log`（exe sha256）。

### 12.3 负样本与残留

| 检查 | 结果 |
|---|---|
| `--monitor 0`（指向主屏） | 拒绝建窗：`[FAIL] startup code=secondary-monitor-required`，**exit 2**，主屏无窗口 |
| 运行期进程 | `highlighter-r0-window` 1 个、本原型数据目录 `msedgewebview2.exe` **6** 个（与 §8.1 一致） |
| 退出后残留（4 次全部） | `highlighter-r0-window` = 0、`msedgewebview2`（r0-window-webview2-data）= 0 |

证据：`.tmp-r0/round3/self-test-monitor0.log`、`residue.log`。

### 12.4 本轮仍未覆盖（不得写成已验证）

1. **100% / 200% DPI 视觉矩阵**：需要改系统缩放（可能需注销重登）。本轮用户明确选择**不改系统缩放**，
   因此只有主屏 150% + 副屏 125% 的混合 DPI 一档；
2. 首帧白闪的逐帧录像、鼠标穿透/焦点/输入法行为（原型未实现穿透）；
3. 混合 DPI 跨屏拖动与运行中 DPI 变化（原型只在启动时读一次）、RDP/锁屏、200%@4K；
4. 除“右侧 + 负 Y”之外的其它显示器拓扑（本轮与 2026-11-10 拓扑相同）。

> 本节是对 §7/§8.2 的**复验补充**，不改变其未验证项的状态；G0 仍未通过。
