# R0-05a：WebView2 媒体路径能力验证（ADR-0001 证据输入）

- 状态：**实测完成（R0 证据，不是生产合同；G0 未通过前不构成架构冻结）**
- 日期：2026-11-10
- 关联计划：[2026-11-10-rust-migration-development-plan.md](../2026-11-10-rust-migration-development-plan.md)
  §2 D05、§4.3、§7 R0-05、§8 G0；[ADR-0001](adr/0001-media-backend.md)；
  [r0-baseline.md](r0-baseline.md) §4.1
- 原型工程：`rust-app/prototypes/webview-media/`（独立 Cargo 工程，**未接入产品入口**）
- 任务：Team task-5（R0-05a WebView2 录屏路径能力验证）
- 并行产出（未合并、仅作对照路径）：`docs/plans/rust-migration/r0-media-native.md`（原生采集 spike，
  由另一并行任务产出；本文件不引用其结论）

## 1. 背景与问题

基线（Electron）录屏链路依赖 Electron 专属的“程序指定源 + loopback”能力：

- `main/domains/record/index.js:1367`：`session.setDisplayMediaRequestHandler`，在回调里
  `callback({ video: <picked source>, audio: 'loopback' })`，即**由宿主指定视频源并绑定系统音频**；
- `record/record.js:803`/`:820`：页面调用 `navigator.mediaDevices.getDisplayMedia(...)`；
- `record/audio-mixer.js:1`：Web Audio 把 `canvas.captureStream()` 与麦克风混音，MediaRecorder 编码 webm。

计划 §2 D05 要求 R0 决定“媒体后端由 R0 决定，不能预设 WebView2 录屏等价”。本原型回答四个问题：

| # | 问题 | 影响 |
|---|---|---|
| Q1 | WebView2 的 `getDisplayMedia` 是否弹原生选源对话框？无用户手势时的真实行为/错误名？ | 能否复刻“点开始即录”的 UX |
| Q2 | `ICoreWebView2ScreenCaptureStarting` 能否实现“程序指定源 / 跳过选源”？ | 决定 WebView 路径是否可行 |
| Q3 | `getDisplayMedia({audio:true})` 能否拿到系统音频（loopback）轨？video 约束/track settings 是否可观测？ | 双音源录制 |
| Q4 | MediaRecorder webm 闭环（录制→宿主写盘→ffmpeg 可解析）是否成立？透明浮层窗口/焦点是否影响采集？ | R5 编码/合成路径 |

## 2. 环境与版本（本轮实测）

| 项 | 值 |
|---|---|
| 机器/会话 | Windows，交互会话 session 1；主屏 `\\.\DISPLAY1` 3840x2160@150%，副屏 `\\.\DISPLAY2` 物理原点 (3840,-170) 1440x2560@125%（per-monitor aware v2 读数，与 r0-baseline §1.3 更正一致） |
| Rust / Cargo | 1.97.1（`rust-app/rust-toolchain.toml` 固定） |
| Tauri / wry | tauri 2.12.5、wry 0.57.2 |
| WebView2 bindings | webview2-com 0.39.1、webview2-com-sys 0.39.1、windows 0.62.2 |
| WebView2 Runtime | **157.0.4341.42**（注册表 `EdgeUpdate\Clients\{F3017226-...}` 与 `tauri::webview_version()` 一致） |
| ffmpeg / ffprobe | `node_modules/ffmpeg-static/ffmpeg.exe` 6.1.1；PATH 中 ffprobe 8.1.1 |
| 可见窗口 | 只创建在副屏（宿主 `screens.rs` 校验；无副屏直接退出，不退回主屏） |
| WebView2 数据目录 | 仓库根 `.tmp-r0-media-webview/webview2-data`（`.tmp*/` 已 gitignore） |

原型独立工程带自己的 `Cargo.lock`（`[workspace]` 空表，不并入 `rust-app/` 父 workspace）；
本轮**未修改**主 workspace 的 `Cargo.toml`/`Cargo.lock`/`src-tauri`。

## 3. 原型与复跑命令

### 3.1 结构（细节见工程 README）

```text
rust-app/prototypes/webview-media/
├── Cargo.toml / Cargo.lock / build.rs / tauri.conf.json / icons/
├── src/{main,screencapture,input,screens,wininfo,util}.rs
├── web/{index.html,main.js}
├── tools/capture-screen.ps1
└── run-matrix.ps1
```

关键实现：

- **SCS 注册**：`with_webview`（主线程）→ `controller.CoreWebView2()` → `cast::<ICoreWebView2_27>()`
  → `add_ScreenCaptureStarting(ScreenCaptureStartingEventHandler::create(...))`。四个模式：
  `none`（不注册）/`observe`（只观察）/`handled-allow`（`SetHandled(true)+SetCancel(false)`）/
  `handled-cancel`（两者 true）。
- **trusted activation**：优先真实 OS 输入（`SetCursorPos` + `SendInput` 点击窗口客户区中心），
  失败回退 Chromium CDP `Input.dispatchMouseEvent`（mousePressed/mouseReleased）；页面用
  `navigator.userActivation` 记录是否真的拿到 transient activation。
- **场景矩阵**（`R0_SCENARIO`）：`probe`（只测激活）/`nogesture`（零激活直接 getDisplayMedia）/
  `gesture`（激活+一次采集+可选录制+canvas-only 闭环）/`overlay`（主窗口+透明浮层各一次）。
- **证据落盘**：每个场景把完整 JSON 报告、NDJSON 事件流水、窗口/子窗口快照、整虚拟桌面截图、
  录屏 chunk 写进 `.tmp-r0-media-webview/`；看门狗强制退出；结束后无残留进程。

### 3.2 命令与真实输出

```powershell
# 构建（首次含依赖编译；增量构建输出）
cargo build --manifest-path rust-app/prototypes/webview-media/Cargo.toml
# =>   Compiling highlighter-r0-media-webview v0.1.0 (F:\workspace\Highlighter\rust-app\prototypes\webview-media)
# =>    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.99s

# 全量矩阵（7 个场景；每个场景一个进程）
powershell -NoProfile -ExecutionPolicy Bypass -File rust-app/prototypes/webview-media/run-matrix.ps1 -SkipBuild
# => [matrix] webview2Runtime=157.0.4341.42
# => [matrix] run=probe exitCode=0
# => [matrix] run=nogesture exitCode=0
# => [matrix] run=gesture-none exitCode=0
# => [matrix] run=gesture-observe exitCode=0
# => [matrix] run=gesture-handled-allow exitCode=0
# => [matrix] run=gesture-handled-cancel exitCode=0
# => [matrix] run=overlay-observe exitCode=0
# => [matrix] webm canvas-only.webm bytes=164839 decodeExit=0 format=matroska,webm streams=1

# 单场景复跑
powershell -NoProfile -ExecutionPolicy Bypass -File rust-app/prototypes/webview-media/run-matrix.ps1 -SkipBuild -Only gesture-observe
```

单次运行关键 stdout（`logs/run-gesture-observe.log`，原文）：

```text
[r0-media][start] tag=gesture-observe scenario=gesture scsMode=observe pid=13552 ...
[r0-media][monitor] index=1 name=Some("\\\\.\\DISPLAY2") primary=false scale=1.25 position=[3840, -170] size=[1440, 2560]
[r0-media][window] media-main requested=(3860, -150) size=[1250, 900]
[r0-media][window] media-overlay requested=(3860, 770) size=[1000, 525]
[r0-media][scs] {"event":"handler-installed","interface":"ICoreWebView2_27","mode":"observe","token":20,"window":"media-main"}
[r0-media][input] os-click label=media-main hwnd=917568 client=[1250, 900] point=[4494, 338]
[r0-media][input] cdp-click label=media-main x=500 y=360
[r0-media][scs] {"argsPresent":true,"cancelAfter":false,"cancelBefore":false,"epochMs":1794325748556,"event":"screen-capture-starting","frameName":"","frameSource":"http://tauri.localhost/","handledBefore":false,"mode":"observe","seq":0,"window":"media-main"}
[r0-media][windows] tag=gestureAudioVideo-during total=488 interesting=44 children=10
[r0-media][screenshot] tag=gestureAudioVideo-during path=...\gestureAudioVideo-during-media-main-1794325752076.png success=true
[r0-media][input] escape label=media-main
[r0-media][recording] saved ...\recordings\canvas-only.webm bytes=168238
[r0-media][report] ...\report-gesture-observe.json
[r0-media][finish] tag=gesture-observe report=Some("...")
```

> 说明：`run-matrix.ps1` 用 `.cmd` 包装子进程读取 `%ERRORLEVEL%`（本机 PowerShell 5.1
> `Start-Process -PassThru` 在重定向输出时取不到 `ExitCode`）；退出码原文见
> `.tmp-r0-media-webview/logs/exit-<tag>.txt`，7 次运行全部为 `0`。

## 4. 实测结果总表（7 次运行，全部 exitCode=0）

| 运行 | 场景 | SCS 模式 | getDisplayMedia 结果 | 选源 UI | 其它 |
|---|---|---|---|---|---|
| `probe` | 只测激活 | observe | 未调用 | — | OS 点击无效；CDP 点击后 `userActivation.isActive=true` |
| `nogesture` | 零 activation | observe | **timeout-pending 12002ms**（页面侧 12s 上限） | **出现** | `activationBefore={isActive:false,hasBeenActive:false}`，无任何错误返回 |
| `gesture-none` | 激活+采集 | none（不注册 SCS） | timeout-pending 12001ms | 出现 | 无 SCS 事件（未注册），行为与 observe 相同 |
| `gesture-observe` | 激活+采集 | observe | timeout-pending 12002ms | 出现 | SCS 事件 `cancelBefore=false,handledBefore=false,cancelAfter=false` |
| `gesture-handled-allow` | 激活+采集 | handled-allow | timeout-pending 12002ms | **仍出现** | `SetHandled(true)` 不抑制 UI |
| `gesture-handled-cancel` | 激活+采集 | handled-cancel | **rejected：`NotAllowedError` "Permission denied"（code 0），2ms** | 不出现 | SCS `cancelAfter=true`；宿主可静默拒绝 |
| `overlay-observe` | 透明浮层+采集 | observe | timeout-pending 12001ms | 出现（浮层内） | 浮层未聚焦时 CDP 激活成功；选源 UI 出现后再次 CDP 点击不再产生 activation |

每个 `gesture` 场景（4 次）都附带 `canvas-only.webm` 录制闭环（与 display 采集是否成功无关），
4/4 通过（见 §5.4）；`probe`/`nogesture`/`overlay` 场景不录制 canvas-only。

## 5. 四个问题的实测证据

### 5.1 Q1：是否弹原生选源 UI；无用户手势时的真实行为

**结论：会弹 WebView2 自带的选源 UI；无用户手势时不会报错，而是直接进入该 UI 并让
`getDisplayMedia` 一直挂起。** 页面侧唯一能记录的是我们自己的 12s 超时（`HarnessTimeout`），
这不是 WebView2 的错误——也就是说**没有 Chromium 浏览器里的 “requires transient activation”
这类真实错误名可记录**，因为 WebView2 的 `getDisplayMedia` 走的是“宿主事件 + 自带 UI”路径。

证据（页面内 3.5s 抓图，整虚拟桌面 5280x2560，per-monitor aware v2）：

- `.tmp-r0-media-webview/screenshots/nogestureAudioVideo-during-media-main-1794325718953.png`
  —— 零 activation 场景下，UI 仍出现在测试窗口内；
- `.tmp-r0-media-webview/screenshots/crop-picker-nogesture.png`（同一图的副屏裁剪，1440x900）：
  标题 **“选择要与 http://tauri.localhost 共享的内容”**，标签页 **窗口 / 整个屏幕**，
  源缩略图列表（含本原型窗口与其它桌面窗口），底部 **“使用系统音频共享”开关（默认关闭）**，
  以及 **共享 / 取消** 按钮；
- 其它模式同款抓图：`gestureAudioVideo-during-media-main-*.png`（none / observe / handled-allow），
  `overlayCdpAudioVideo-during-media-overlay-*.png`（透明浮层）；
- `handled-cancel` 无 UI，直接 `NotAllowedError`（日志原文）：

```text
[r0-media][scs] {"argsPresent":true,"cancelAfter":true,"cancelBefore":false,...,"mode":"handled-cancel",...}
report: capture.status="rejected", error={"name":"NotAllowedError","message":"Permission denied","code":0}, elapsedMs=2
```

- 选源 UI 由 WebView2 浏览器进程绘制在 webview 表面之上（截图可见它覆盖在页面内容上）；
  枚举我们的两个顶层窗口时，子窗口只有标准 WebView2 子窗口（`WRY_WEBVIEW`/`Chrome_WidgetWin_0`/
  `Chrome_WidgetWin_1`/`Chrome_RenderWidgetHostHWND`/`Intermediate D3D Window`，共 10 个），
  没有可与该 UI 一一对应的独立子窗口 HWND；因此 CDP（renderer 层输入）无法操作它，见 §5.2。

**失败分支**：`handled-cancel` 证明宿主可以让请求立即失败（无 UI、`NotAllowedError`），
但这只是“拒绝”，不是“指定源”。

### 5.2 Q2：能否用 `ScreenCaptureStarting` “程序指定源 / 跳过选源”

**结论：不能。宿主 API 只有“允许/拒绝/延迟”，没有指定源的方法；即使 `SetHandled(true)`
也不能跳过选源 UI。** 与 Electron `setDisplayMediaRequestHandler(callback({video,audio}))`
不等价。

代码级证据（本机 bindings 实测，`webview2-com-sys 0.39.1/src/bindings.rs`）：

- 事件只挂在 `ICoreWebView2_27::add_ScreenCaptureStarting`（另有面向 iframe 的
  `ICoreWebView2Frame6` 变体）；
- `ICoreWebView2ScreenCaptureStartingEventArgs` 的全部方法：
  `Cancel` / `SetCancel`、`Handled` / `SetHandled`、`OriginalSourceFrameInfo`、`GetDeferral`
  ——**没有** `SetSource` / `SetVideo` / `SetAudio` 之类的方法（0.39.1 是本机可获取的最新
  bindings，接口集合与官方文档一致；Runtime 157.0.4341.42 远高于接口引入版本 1.0.2903.40）。

官方文档语义（[ICoreWebView2ScreenCaptureStartingEventArgs](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2screencapturestartingeventargs)）：

- `put_Cancel`：“If canceled, the screen capture UI is not displayed regardless of the `Handled`
  property. On the script side, it will return with a `NotAllowedError` as Permission denied.”
- `GetDeferral`：“Use this deferral to defer the decision to **show the Screen Capture UI**.”
  —— 官方明确存在由 WebView2 显示的 Screen Capture UI；
- `put_Handled`：只用于“阻止更下游的 frame/CoreWebView2 事件处理器”，语义不是“跳过 UI”。

实测与文档一致：

- `observe`/`none`/`handled-allow` 都出现选源 UI 并挂起（`handled-allow` 证明 `Handled` 不抑制 UI）；
- `handled-cancel` 立即 `NotAllowedError`（证明 `Cancel` 生效、UI 不显示）。

**附加 Chromium 参数实验（未成功，记录失败分支）**：通过
`R0_EXTRA_BROWSER_ARGS` + `.additional_browser_args()` 传入 Chromium 内部开关
（`--auto-select-desktop-capture-source="Entire screen" --enable-usermedia-screen-capturing`，
以及本地化名 `"整个屏幕"`）各跑一次 `gesture` 场景：两次仍为 `timeout-pending`（12,002ms），
选源 UI 照常出现（`report-autoselect-1.json`/`report-autoselect-2.json` 与
`logs/autoselect-1.log`/`autoselect-2.log` 保留，未纳入矩阵汇总）。即使该内部开关在其它版本可用，
它也只能在 WebView2 环境创建时静态指定一个源，无法覆盖“全屏/区域/窗口动态选择”，仍不等价。

### 5.3 Q3：系统音频 loopback / track settings

**结论：未验证（既不能证明可行，也不能证明不可行）。** 采集请求在选源 UI 处挂起，
`getDisplayMedia` 从未 resolve，因此没有拿到任何 `MediaStreamTrack`，audio track 数量、
`getSettings()`/`getCapabilities()`、video 约束是否生效均**无法观测**。

可观测的间接证据：选源 UI 内存在 **“使用系统音频共享”开关（默认关闭）**，说明 WebView2/Chromium
具备把系统音频作为可选音轨提供给页面的能力，但该开关只能由用户在 UI 中打开，宿主没有 API
设置它（§5.2），因此无人值守无法验证。真实用户操作下能否拿到 loopback 轨，需要真机人工验证。

### 5.4 Q4：MediaRecorder webm 闭环 + 透明浮层/焦点

**MediaRecorder webm 闭环：通过（4/4 次 `gesture` 场景运行，canvas 合成路径）。** 这与产品现有
pipeline 的编码路径一致（`record/record.js:1124` 用 `canvas.captureStream(frameRate)`，
`:1149` 用 MediaRecorder）：

```text
实际 mimeType        video/webm;codecs=vp9,opus（MediaRecorder.isTypeSupported 全部为 true，
                     含 vp9/vp8/opus 与 mp4/avc1 变体；canvas-only 请求本身无音轨，mime 串里的
                     opus 是 MediaRecorder 对请求 mimeType 的原样回显）
canvas               640x360 @30fps（本场景）
录制时长             约 3.0s；ondataavailable 3 个事件（其中 1 个空），2 个非空 chunk 分块上传
分块交回宿主         base64 chunk → invoke recording_chunk → 宿主追加 .part → recording_finish 重命名
文件                 .tmp-r0-media-webview/recordings/canvas-only.webm，168,566 bytes
ffprobe              format=matroska,webm；stream#0 codec=vp9 640x360（duration 元数据为 N/A，
                     这是 MediaRecorder webm 的已知特性，用解码计时代替）
ffmpeg 解码          ffmpeg -v error -i canvas-only.webm -f null -  => exit 0
解码统计             frame=86, time=00:00:02.96（可播放、时长正确）
抽帧                 screenshots/frame-canvas-only.png（640x360，画面文字 “R0-05a canvas-only frame 1”）
```

→ “MediaRecorder 录 webm → 分块 IPC → 宿主写盘 → ffmpeg 可解析/可播放”的闭环成立。
**display 采集流的录制未发生**（采集从未 resolve，见 Q1/Q2）。

**透明浮层窗口 / 焦点：**

- 透明、无边框、跳过任务栏、`always_on_top` 的副屏浮层窗口（`media-overlay`）可见但未聚焦：
  `hasFocusBeforeActivation=false`；用 CDP 注入点击后 `userActivation={isActive:true,hasBeenActive:true}`
  → **采集不要求 OS 焦点/前台**；
- 浮层窗口里调用 `getDisplayMedia` 仍出现选源 UI（`overlayCdpAudioVideo-during-media-overlay-*.png`）
  并挂起 → 透明窗口类型**不阻止**采集，也不是失败原因；
- 观察到的副作用：一旦选源 UI 处于等待状态，同一 webview 内后续 CDP 点击不再产生 activation
  （`afterCdp={isActive:false}`），但页面 JS/定时器/IPC 仍正常（canvas 录制随后成功）——
  该 UI 是浏览器 UI，会挡住 renderer 的输入激活。

**OS 输入注入（本机限制，如实记录）**：原型实现了 `SetCursorPos` + `SendInput` 的真实点击，
但本机受限宿主里：

```text
cursorProbe: setCursorPosOk=false, setCursorPosError="句柄无效。 (0x80070006)"（另一次为
"操作成功完成。 (0x00000000)"），cursorBefore=cursorAfter=[4020,120]，目标点 [4494,338]
os-click: sendInputMoveCount=1, clickDownCount=1, clickUpCount=1，但 cursor 未移动，
页面 userActivation 仍为 {isActive:false,hasBeenActive:false}
```

→ **本机无法用 OS 注入提供 trusted activation**（推断与宿主沙箱/桌面输入限制有关，未继续深究）。
最终 activation 由 Chromium CDP `Input.dispatchMouseEvent` 提供并实测成功
（`probe` 报告：`afterCdp={hasBeenActive:true,isActive:true}`，x=500,y=360 为客户区中心 CSS 坐标）。
这是可复跑的 trusted activation 方法；真实桌面上 OS 输入路径**未验证**。

## 6. 与 Electron `setDisplayMediaRequestHandler` 的差异表

| 维度 | Electron（基线，`main/domains/record/index.js:1367`） | WebView2（本原型实测） |
|---|---|---|
| 宿主 API | `setDisplayMediaRequestHandler((request, callback) => callback({video, audio}))` | 只有 `ScreenCaptureStarting` 事件：`Cancel/Handled/GetDeferral/OriginalSourceFrameInfo` |
| 指定视频源 | 是：`desktopCapturer.getSources` 后按 display/window 绑定，或窗口模式绑定窗口源 | **否**：无任何设置源的方法 |
| 指定系统音频 | 是：`audio: 'loopback'`（Win32） | **否**：只能由自带选源 UI 的“使用系统音频共享”开关决定（未验证实际音轨） |
| 是否弹选源对话框 | 否（handler 直接回调，无 UI） | **是**：每次请求都弹 WebView2 自带选源 UI 并等待人工选择 |
| 无用户手势行为 | handler 仍会被调用（Electron 不强制 transient activation；基线页面由按钮点击触发） | 不报错、直接进入选源 UI 并挂起（本机实测；无 activation 也弹） |
| 拒绝语义 | `callback({})` → `NotAllowedError` | `SetCancel(true)` → `NotAllowedError` "Permission denied"（2ms，实测） |
| 窗口/区域/全屏模式 | 均可在宿主侧按需绑定源 | 只能由用户在 UI 里选择（窗口/整个屏幕），宿主无法指定区域裁剪源 |
| 多窗口隔离 | 可按 frame 校验请求来源（基线已校验 `request.frame`） | 事件带 `OriginalSourceFrameInfo`（本机 `frameSource=http://tauri.localhost/`、`frameName` 为空），可做来源校验，但**不能**决定共享内容 |
| 生命周期/权限模型 | 宿主显式授权 | 宿主可静默拒绝；允许时依赖浏览器 UI |

## 7. 结论（ADR-0001 建议，不冻结）

**置信度：高**（“无程序指定源、必弹选源 UI”）——由 bindings、官方文档、7 次实测（含零激活、
四种 SCS 模式、透明浮层）与选源 UI 截图共同支撑；**中**（其余行为细节）——单机单 Runtime 版本、
部分项无法无人值守观测。

建议（供 ADR-0001 采用/驳回）：

1. **WebView2 + 现有 MediaRecorder 链路不能作为 R5 录屏后端的唯一方案**：它无法复刻
   Electron 的“程序指定源 + loopback + 无选源对话框”，这是产品“点开始即录/自动录指定屏幕或窗口”
   的硬性前提（D05 失败分支）。
2. R5 媒体后端按“**视频与系统音频由原生层采集**”重估（WGC/DXGI + WASAPI loopback + Media Foundation
   或 FFmpeg），并与并行原生采集 spike 的证据合并评估（路径见文首“并行产出”）。
3. **混合方案 C 仍值得保留**：WebView 只做 UI/合成/编码（canvas 合成 + MediaRecorder webm 闭环
   已实测通过，且分块 IPC 写盘可行），视频/系统音频帧由原生层送入页面（R0-06/R1 资源通道）。
4. 若坚持纯 WebView 路径，必须接受“每次录制弹选源 UI、用户手动选窗口/屏幕、系统音频由用户勾选”，
   与基线 UX 和“自动录制指定源”能力不等价——这需要产品/计划层面显式降级决定，不能默认成立。

**G0 前仍需补的实测**（见 §8）未完成，因此本文件不写“已冻结/已选定”。

## 8. 未验证 / 不可行清单（不得当作已通过）

| 项 | 状态 | 原因 |
|---|---|---|
| 系统音频 loopback 实际拿到音轨 | **未验证** | 采集在选源 UI 挂起，无 track 可观测 |
| 选定源后的 track settings / 约束（width/height/frameRate）是否生效 | **未验证** | 同上 |
| 全屏 / 区域 / 窗口三种采集模式、源目标变化 | **未验证** | 选源 UI 无法程序化完成 |
| 30 分钟时钟、暂停/继续、长录写入背压 | **未验证** | 本原型只做能力/闭环，不做长时 |
| 真实 OS 输入激活路径 | **未验证** | 本机 `SetCursorPos`/`SendInput` 不生效（宿主限制），改用 CDP |
| 人工在选源 UI 中选择后的完整链路 | **未验证** | 需要真机人工操作 |
| 透明浮层视觉/白闪/鼠标穿透/焦点策略 | **未验证** | R0-03 范畴，本原型只测采集调用 |
| WebView2 Runtime 多版本矩阵（有/无/离线） | **未验证** | 仅 157.0.4341.42；R0-07 |
| 进程树完整计数 / 性能 | **未验证** | G3/R0-07 |
| Chromium `--auto-select-desktop-capture-source` 的可用性 | **未验证（两次实验均仍弹 UI）** | 内部开关、未文档化；即使可用也只覆盖启动时静态源 |

## 9. 责任批次与退出验收

| 批次 | 事项 | 退出验收 |
|---|---|---|
| R0-05（后续 spike）/ R5 | 原生采集最小闭环（WGC 视频 + WASAPI loopback + 麦克风混音、同一媒体时钟、暂停/继续、可播放原片、30 分钟、源目标变化） | 计划 §7 R0-05 验收项全部可演示；与 ADR-0001 合并 |
| R0-06 / R1 | 原生帧 → 页面/编码器二进制资源通道（本原型的 chunked IPC 只作参考，不是生产协议） | 成功/失败/恢复用例 |
| R1-04 | 媒体命令的角色权限与窗口归属校验（本原型只有 `window-owner-mismatch` 标签校验，非权限映射） | 计划 §4.3 |
| R0-07 / G0 | 本证据 + 原生证据 + 版本矩阵汇总进 G0 决策报告 | G0 放行结论 |
| 回退 | 本原型代码不接入产品；媒体后端未决前保留 Electron 稳定版 | 不改变产品行为 |

## 10. 证据路径与哈希

证据全部在 `.tmp-r0-media-webview/`（`.tmp*/` 已 gitignore；正式结论以本文件 + 复跑命令为准）。

| 证据 | 路径 | 大小/哈希 |
|---|---|---|
| 7 份场景报告 | `.tmp-r0-media-webview/report-<tag>.json` | 例：`report-gesture-observe.json` 49,887 B，sha256 `f69c22661560cac6b159de614a2244a6c28597d1e6bc7661e396b12491712446` |
| 选源 UI 截图（零激活） | `.tmp-r0-media-webview/screenshots/nogestureAudioVideo-during-media-main-*.png` | 整虚拟桌面 5280x2560（本轮文件名带 Unix 毫秒时间戳，见 `events-nogesture.ndjson` 记录） |
| 选源 UI 裁剪图 | `.tmp-r0-media-webview/screenshots/crop-picker-nogesture.png` | 93,750 B，sha256 `c559e510b55593470a6c45f4859750550dfff8ea29e5334b332284df6f409f0d` |
| 其余模式/浮层选源 UI | `screenshots/gestureAudioVideo-during-media-main-*.png`、`screenshots/overlayCdpAudioVideo-during-media-overlay-*.png` | — |
| MediaRecorder webm | `.tmp-r0-media-webview/recordings/canvas-only.webm` | 168,566 B，sha256 `f8afd4d980f1e87022dcbc9477696786c53cc6d02c774095fdd4611b37704320` |
| ffprobe 元数据 | `.tmp-r0-media-webview/logs/ffprobe-canvas-only.json` | 2,262 B，sha256 `a7c65681ab97d510a18548afde5cb9531ac53503b598ccb8d8cd8963a5add5a7` |
| 抽帧 | `.tmp-r0-media-webview/screenshots/frame-canvas-only.png` | 23,082 B，sha256 `b113b123ba1993ce4c3ba25b02d4b910168a56a0ce3472f69fcbc49b86d6b87e` |
| 矩阵汇总（含解码结果） | `.tmp-r0-media-webview/logs/matrix-summary.json` | 7,041 B，sha256 `f4fb04b24743ec31ad51248d3b41ad96e3e8bb7f7c84ce5f6d1b02ccd979b5b3` |
| 每次运行日志 / 退出码 | `.tmp-r0-media-webview/logs/run-<tag>.log`、`logs/exit-<tag>.txt` | 7/7 exit 0 |
| 页面事件流水 | `.tmp-r0-media-webview/events-<tag>.ndjson` | 含 SCS 事件、窗口快照、截图记录 |

> 哈希/大小取自 2026-11-10 最后一次完整矩阵运行之后；`canvas-only.webm` 在每次 `gesture`
> 场景运行都会被重写（本轮最终内容来自 `gesture-handled-cancel` 那次运行的 canvas 录制），
> 复跑后哈希会变，属正常。

复跑：见 §3.2。复跑会覆盖同名报告/日志/录屏（时间戳文件名保留旧图）；如需保留证据先复制 `.tmp-r0-media-webview/`。
`R0_EXTRA_BROWSER_ARGS` 的两次 auto-select 实验为临时运行（`R0_RUN_TAG=autoselect-1/2`，
数据目录后缀 `-autoselect1/2`），其 `report-autoselect-*.json` 与 `logs/autoselect-*.log` 在同目录、
未纳入矩阵汇总，结论仅作失败分支记录。

**边界声明**：本任务只改动 `rust-app/prototypes/webview-media/` 与本文件；未改主 workspace
Cargo 文件、未改 `src-tauri`、未 `git add/commit/checkout`、未 `npm install`、未改 `package.json`。

## 11. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 新建 R0-05a 独立 Tauri 2 原型（7 场景 × 4 SCS 模式矩阵、CDP/OS 激活、截图/窗口/录屏证据链） | `.tmp-r0-media-webview/` 本轮运行；`cargo build` 通过 |
| 2026-11-10 | 完成四问实测：选源 UI 必弹且无法程序指定源；handled-cancel 可静默拒绝；零激活也弹 UI；MediaRecorder webm 闭环通过；透明浮层不阻止采集但弹 UI | `report-*.json`、`crop-picker-nogesture.png`、`matrix-summary.json`、`ffprobe-canvas-only.json` |
| 2026-11-10 | 本文件作为 ADR-0001 证据输入提交（不冻结） | 本文件 |
