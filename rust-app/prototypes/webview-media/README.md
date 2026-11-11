# R0-05a：WebView2 媒体采集能力原型

**这不是产品宿主，只是 R0 风险验证。** 目的：为计划 §2 D05 / §7 R0-05 / §8 G0 的
“媒体后端（WebView2 vs 原生采集）”决策提供可复核证据。产出文档：
[docs/plans/rust-migration/r0-media-webview.md](../../../docs/plans/rust-migration/r0-media-webview.md)。

## 它回答什么

1. WebView2/Chromium 的 `getDisplayMedia` 是否弹原生选源 UI；无用户手势时真实错误/行为；
   `ICoreWebView2ScreenCaptureStarting` 能否“程序指定源 / 跳过选源”（文档 + 实测）。
2. `getDisplayMedia({audio:true})` 能否拿到系统音频（loopback）轨；video/audio 约束与
   track settings 能否观测。
3. MediaRecorder 录 webm → 宿主写盘 → ffmpeg 解析/解码的最小闭环。
4. 透明浮层窗口下 `getDisplayMedia` 是否受窗口类型/焦点影响。
5. 与 Electron `session.setDisplayMediaRequestHandler` 的差异（`main/domains/record/index.js:1367`）。

## 工程边界

- 独立 Cargo 工程（`Cargo.toml` 里空 `[workspace]` 表），**不属于** `rust-app/` 父 workspace，
  自带 `Cargo.lock`；不修改主 workspace 的 `Cargo.toml`/`Cargo.lock`，不接入产品入口。
- 可见窗口只创建在副屏（宿主 `screens.rs` 校验；无副屏直接失败退出，绝不退回主屏）。
- WebView2 用户数据目录固定到仓库根 `.tmp-r0-media-webview/webview2-data`（`.tmp*/` 已 gitignore）。
- 所有日志/报告/录屏/截图落在 `.tmp-r0-media-webview/`；不写 `%LOCALAPPDATA%`。
- 命令入口做窗口标签归属校验（`window-owner-mismatch`），但这只是原型纵深防御，
  **不等于** R1-04 的角色权限映射（Tauri 应用命令默认不受 capability ACL 约束）。

## 目录

```text
rust-app/prototypes/webview-media/
├── Cargo.toml / Cargo.lock / build.rs
├── tauri.conf.json            # app.windows=[]，无 devUrl，frontendDist=web/，withGlobalTauri
├── icons/icon.ico
├── src/
│   ├── main.rs                # setup 建窗、命令面、报告落盘、看门狗
│   ├── screencapture.rs       # ICoreWebView2_27 ScreenCaptureStarting 注册/模式判定（unsafe 集中区）
│   ├── input.rs               # SetCursorPos/SendInput OS 输入 + CDP Input.dispatchMouseEvent 激活
│   ├── screens.rs             # 显示器枚举/副屏校验/物理像素放置
│   ├── wininfo.rs             # 顶层/子窗口枚举（选源 UI 证据）
│   └── util.rs                # 路径/Base64/NDJSON
├── web/                       # 测试页（无产品 UI）；index.html + main.js
└── tools/capture-screen.ps1   # 整虚拟桌面截图（per-monitor aware v2）
```

## 构建 / 运行

```powershell
# 一次性构建（首次含依赖下载/编译；本机约 1~3 分钟）
cargo build --manifest-path rust-app/prototypes/webview-media/Cargo.toml

# 全量场景矩阵（会在副屏短暂显示测试窗口；结束后清理 msedgewebview2 子进程）
powershell -NoProfile -ExecutionPolicy Bypass -File rust-app/prototypes/webview-media/run-matrix.ps1 -SkipBuild

# 只跑一个场景
powershell -NoProfile -ExecutionPolicy Bypass -File rust-app/prototypes/webview-media/run-matrix.ps1 -SkipBuild -Only gesture-observe
```

每次运行 = 一种 `R0_SCENARIO`：

| 场景 | 内容 | 对应问题 |
|---|---|---|
| `probe` | 只测 OS/CDP 两条 trusted activation 路径 | 激活方式可行性 |
| `nogesture` | 全新页面、零 activation，直接 `getDisplayMedia({video,audio})` | 无手势行为/错误 |
| `gesture` | 激活 + 一次 `getDisplayMedia` + 可选录制 + canvas-only 闭环 | 主探测 |
| `overlay` | 主窗口 + 透明浮层各一次采集，测未聚焦/CDP 激活 | 透明窗口/焦点 |

`R0_SCS_MODE` 控制 ScreenCaptureStarting 处理：`none`（不注册）/ `observe`（只观察）/
`handled-allow`（`SetHandled(true)+SetCancel(false)`）/ `handled-cancel`（两者都 true）。

`R0_EXTRA_BROWSER_ARGS` 是附加 Chromium 参数实验入口（例如
`--auto-select-desktop-capture-source="Entire screen"`），实验时须同时设置不同的
`R0_DATA_DIR_SUFFIX`（同 data dir 的 webview 参数必须一致）。

## 产物

`.tmp-r0-media-webview/` 下：

- `report-<tag>.json`：每个场景的完整实测报告（含 `userActivation` 快照、track settings、
  SCS 事件、窗口/子窗口快照、截图路径）。
- `events-<tag>.ndjson`：页面 → 宿主的事件流水。
- `recordings/*.webm`：MediaRecorder（canvas-only 闭环；display 采集因选源 UI 挂起不会产生）。
- `screenshots/live-*.png`（run-matrix 外部抓图）与 `screenshots/*-during-*.png`（页面内抓图）：
  选源 UI 证据；`frames/frame-*.png`：从 webm 抽帧。
- `logs/run-<tag>.log|err.log`、`logs/exit-<tag>.txt`、`logs/matrix-summary.json`、
  `logs/ffprobe-*.json`（ffprobe 元数据）。

## 收尾 / 清理

`run-matrix.ps1` 每次运行前后按命令行匹配 `.tmp-r0-media-webview` 清理本原型的
`msedgewebview2.exe` 子进程，并结束残留的 `highlighter-r0-media-webview.exe`。
手动运行 `target/debug/highlighter-r0-media-webview.exe` 后如异常退出，可：

```powershell
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
  Where-Object { $_.CommandLine -like '*.tmp-r0-media-webview*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## 已知限制（原型阶段）

- 只验证**能力/行为**，不验证 30 分钟时钟、双音源混音、区域/窗口采集、源目标变化。
- OS 输入注入在本机受宿主限制（`SetCursorPos` 返回 FALSE、光标不动），因此 activation
  由 Chromium CDP 提供；这是本机环境下可复跑的 trusted activation 方式。
- 无法程序化完成 WebView2 的选源 UI，所以“选定源之后的 track settings / 系统音频轨”
  在本原型里观测不到（见主文档“未验证项”）。
