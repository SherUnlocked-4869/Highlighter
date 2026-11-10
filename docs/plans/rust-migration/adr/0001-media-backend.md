# ADR-0001：录屏媒体后端（WebView2 vs 原生采集）

- 状态：**候选（两路 spike 有实测证据；G0 未通过，未冻结）**
- 决定批次：R0-05；实施批次：R5
- 日期：2026-11-10
- 关联计划：§2 D05、§4.3、§7 R0-05、§8 G0、§9.2
- 证据文档：[r0-media-webview.md](../r0-media-webview.md)（WebView 路径）、
  [r0-media-native.md](../r0-media-native.md)（原生路径）、
  [`rust-app/prototypes/webview-media/`](../../../rust-app/prototypes/webview-media/)、
  [`rust-app/prototypes/native-capture/`](../../../rust-app/prototypes/native-capture/)
- 证据目录：`.tmp-r0-media-webview/`、`.tmp-r0-media-native/`（gitignore）

## 1. 背景与问题

基线（Electron）用 `session.setDisplayMediaRequestHandler` 在宿主侧**指定视频源并绑定系统音频
loopback**，页面 `getDisplayMedia` 不弹选源框（`main/domains/record/index.js:1367`、
`record/record.js:803`、`record/audio-mixer.js`）。计划 D05 要求 R0 决定媒体后端，不能预设
WebView2 录屏等价。本 ADR 汇总两条实测路线，回答：**Tauri/WebView2 能否复刻基线的采集能力；
若不能，原生采集的最小可行边界与剩余风险是什么。**

## 2. 备选方案

| 方案 | 描述 | 优点 | 代价/风险 |
|---|---|---|---|
| A WebView2 采集 | 页面 `getDisplayMedia` + WebView2 `ScreenCaptureStarting` 事件 | 复用现有 Canvas/MediaRecorder 链路 | 无法程序指定源、必弹选源 UI、loopback 不可程序控制（见 §4） |
| B 原生采集 | Rust（WGC/DXGI 视频 + WASAPI loopback + 麦克风）→ 帧/音轨送入页面或编码器 | 可程序指定源与 loopback；与基线 UX 等价 | WGC 权限/打包身份、GDI 非等价、混音/时钟/编码成本；R5 工时要重估 |
| C 混合 | 视频与系统音频原生采集；WebView 只做 UI/合成/编码（canvas + MediaRecorder） | 保留已验证的 webm 编码闭环；采集走原生 | 需原生帧 → 页面的资源通道（R0-06 ADR-0005）与同一媒体时钟 |

## 3. 实测条件与命令

- 环境：Windows 11 build 26300.9711；WebView2 Runtime 157.0.4341.42；Tauri 2.12.5 / wry 0.57.2；
  rustc/cargo 1.97.1；副屏 `\\.\DISPLAY2` 物理 `(3840,-170) 1440×2560@125%`；本机无 DXGI 桌面复制、
  WGC 被系统拒绝（见 §4）。
- WebView 路径：`rust-app/prototypes/webview-media/run-matrix.ps1 -SkipBuild`（7 次运行，exit 0）；
  Chromium CDP `Input.dispatchMouseEvent` 提供 trusted activation。
- 原生路径：`rust-app/prototypes/native-capture/`（`--probe-wgc`、`--capture auto|gdi`、
  `--audio`、A/V mux、背压、失败注入），Release 10 s@30 fps + WASAPI loopback 10 s。
- 两路证据各自独立采集；**未做同条件并发对照**（计划 §9.2 的 p50/p95/CPU/GPU/内存对照仍缺）。

## 4. 证据

### 4.1 WebView2 路径（A）

| 问题 | 实测结果 | 判定 |
|---|---|---|
| 是否弹选源 UI | **必弹** WebView2 自带“选择要与 http://tauri.localhost 共享的内容”（窗口/整个屏幕、系统音频开关、共享/取消）；零用户手势也弹，请求挂起无真实错误名 | 与基线 UX 不等价 |
| `ScreenCaptureStarting` 能否指定源 | **不能**：args 仅 `Cancel/SetCancel/Handled/SetHandled/OriginalSourceFrameInfo/GetDeferral`，无 `SetSource` 类方法；`SetHandled(true)` 不抑制 UI；`SetCancel(true)` 2ms 内 `NotAllowedError` | **不可行（置信度高）** |
| 系统音频 loopback / track settings | **未验证**：采集在选源 UI 挂起，从未 resolve，拿不到 track；UI 内“使用系统音频共享”默认关闭且宿主无 API 控制 | 未验证 |
| MediaRecorder webm 闭环 | **通过**（4/4）：canvas.captureStream 640×360@30 → MediaRecorder vp9/opus → base64 分块 invoke 写盘 → ffprobe `matroska,webm` vp9，ffmpeg 解码 exit 0（86 帧/2.96s），抽帧正确 | 通过（合成路径） |
| 透明浮层/焦点 | 浮层不阻止采集、不要求 OS 焦点（CDP activation 成功）；但仍弹选源 UI | 部分通过 |

附加失败分支：Chromium `--auto-select-desktop-capture-source` 内部参数两次实验仍弹 UI 并超时
（未纳入矩阵汇总），即使可用也只能静态指定一个源，不能覆盖区域/窗口动态选择。

### 4.2 原生路径（B）

| 验证项 | 实测结果 | 判定 |
|---|---|---|
| WGC 可用性 | `CreateForMonitor`（主/副屏）与 `CreateForWindow` 均 `E_ACCESSDENIED 0x80070005`（“You do not have permission…”）；activation factory 成功、非 D3D 失败点；per-app `graphicsCaptureProgrammatic` Allow 注入后仍拒绝（已回滚） | **本机不可用（真实失败分支）**；不能外推为“WGC 普遍不可用” |
| 桌面采集（GDI 回退，Release） | 10 s@30 fps、1440×2560：**301/301 帧**、0 丢弃/0 缺口、帧间隔 p50 31.67ms / p95 37.92ms、全黑帧 0、唯一哈希 301/301；`video.mp4` 1,742,387 B、10.03s、h264 High、全量解码 exit 0；原始 BGRA 4.438 GB、管道 418 MiB/s；CPU ≈1.45 核（含 ffmpeg） | **可行下限成立** |
| 4K@30 抽样 | 3 s：87/90 帧、28.8fps、CPU ≈2.88 核 | GDI 整帧拷贝在 4K@30 接近上限 |
| WASAPI loopback | 48kHz/8ch float32（取前 2 声道）：480,960 帧/10.020s/1,923,840 B 与期望完全一致；静音/非静音包语义验证 | 通过 |
| A/V mux | 视频 copy + AAC 192k → `capture.mp4` 1,989,344 B、10.03s、全量解码通过；`start_offset=-21.33ms`（=AAC 1024 采样 priming，扣除后≈0）、`end_skew=-44.33ms` | 通过；时钟裁齐/容差需 R5 冻结 |
| 背压（慢消费者） | 有界队列无无界内存；但输出 6.80s < 墙钟 10.03s → 反压会截短时间轴 | 需 R5 冻结丢帧/暂停/限载语义 |
| 失败分支 | WGC 严格模式 exit 2 且无半成品；ffmpeg 缺失 (os error 2)、编码器缺失（`Unknown encoder` + 管道关闭 232）、音频端点无效 `0x80070057` 均逐字记录 | 可诊断 |
| Debug/Release 口径 | Debug 仅功能对照；Release 也是本机单次、非隔离、电源方案未冻结 | 不是产品基线 |

## 5. 结论（建议）

**建议候选 C（混合）：视频与系统音频由原生层采集，WebView 只做 UI/合成/编码。**
WebView2 路径**不能**作为 R5 唯一后端（无法程序指定源、必弹选源 UI、loopback 不可程序控制，
与基线“点开始即录指定屏幕/窗口”不等价）。原生路径的**可行下限已实测成立**（GDI 采集 + 有界管道
+ ffmpeg 编码、WASAPI loopback、A/V mux、背压与失败诊断），但：

1. **WGC 的可行性置信度低**：本机被系统权限模型拒绝；若 R5 选 WGC，必须把“打包身份 /
   `graphicsCaptureProgrammatic` 能力声明 / 用户同意 / 采集指示 / 目标 Windows build 复验”
   纳入产品方案，并在目标环境实测；GDI 不是等价物（无光标、无采集指示、叠加层/D3D 内容风险、
   整帧 CPU 拷贝，4K@30 已接近上限）。
2. R5 需要新增“原生采集 + 混音 + 同一媒体时钟 + 编码/发布”的工作量与风险；原 8–14 人周估算需按
   本证据重估（计划 §11 要求 R0 后重估），在 G0 报告中给出修正区间。
3. WebView 保留为 UI/合成/编码：canvas + MediaRecorder webm 闭环已实测通过，分块 IPC 写盘可行，
   但该 chunked IPC 只是原型参考，生产协议另设计（ADR-0005）。
4. **G0 前仍缺**：两路同条件对照（§9.2）、30 分钟/双音源/暂停续录、真实源目标变化、WGC 打包身份
   实测、Runtime 版本矩阵；因此本 ADR 不写“已选定/已冻结”。

## 6. 未解决限制

- WGC 在本机不可用，成功路径无运行证据；打包身份/同意流程/采集指示未验证。
- WebView 路径的系统音频轨、track settings、人工选源后的完整链路未验证。
- 30 分钟时钟、暂停/继续、源目标变化、慢盘/磁盘满、设备丢失、长录恢复未验证。
- 两路未做同条件性能/资源对照（计划 §9.2 的固定 Release/设备/电源/数据集）。
- 编码器选择（libx264/Media Foundation/FFmpeg）与发布流程、原片 lease 属 R5-05/R5-02。

## 7. 责任批次与退出验收

- R5-01：原生采集后端（WGC 优先 + GDI 回退或明确目标 build）、目标/音源枚举与权限预检。
- R5-02：混音、编码、暂停时间、写入背压与 checkpoint；同一媒体时钟；慢盘/设备丢失失败路径。
- R5-07：30/60FPS、双音源、30 分钟与长时录制；输出 probe/音画同步/性能报告；G2 媒体关口。
- 退出验收：G0 前补两路同条件对照与 WGC 打包身份实测；G2 前完成长时/真机矩阵。

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 初稿：WebView2 不可作唯一后端；建议混合 C（原生采集 + WebView UI/合成/编码）；原生可行下限成立、WGC 待打包身份验证 | [r0-media-webview.md](../r0-media-webview.md)、[r0-media-native.md](../r0-media-native.md) |
