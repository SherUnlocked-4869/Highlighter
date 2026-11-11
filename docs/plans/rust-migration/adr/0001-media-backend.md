# ADR-0001：录屏媒体后端（WebView2 vs 原生采集）

- 状态：**候选（两路 spike 有实测证据；G0 未通过，未冻结）**
- 决定批次：R0-05；实施批次：R5
- 日期：2026-11-10（初版）；**2026-11-11 扩展**：当前机 `SHERUNLOCK02` 上补暂停/继续、
  双音源、区域/窗口与源目标变化、30 分钟时钟样例、T4 媒体阈值候选
- 关联计划：§2 D05、§4.3、§7 R0-05、§8 G0、§9.2
- 证据文档：[r0-media-webview.md](../r0-media-webview.md)（WebView 路径）、
  [r0-media-native.md](../r0-media-native.md)（原生路径）、
  [`rust-app/prototypes/webview-media/`](../../../../rust-app/prototypes/webview-media/)、
  [`rust-app/prototypes/native-capture/`](../../../../rust-app/prototypes/native-capture/)
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
- **2026-11-11 扩展（当前机 SHERUNLOCK02：i5-13500H / Iris Xe / 单屏 2240×1400@150%）**：
  GDI 路径补暂停/继续（12 s 样例，2 次暂停）、双音源（loopback+Intel 麦克风阵列，
  混音+mux）、区域（640×360@30.1 fps）与窗口三方法 + 源目标变化场景（隐藏/可见、
  移动/遮挡/关闭/按标题重解析）、30 分钟时钟样例与进程树资源峰值（Release、高性能电源方案、
  记录 power before/during/after），并补 T4 媒体阈值候选（未冻结）。详细数字见
  [r0-media-native.md](../r0-media-native.md) §4.11～§4.14。
- **2026-11-11 19:40–20:25 Medium IL 复验（ACL 修复后）**：工作区 ACL Low→Medium（61,767 文件，
  Lead 执行），原型运行时日志 `[env] process integrity level = Medium(0x2000)`。
  **WGC 更正为可用**：`CreateForMonitor`/`CreateForWindow` 均 OK，WGC 10 s@30 fps 采集成功
  （送达 590 帧/56.77 fps、写入 300 帧、复制补齐 0、视频 300 帧/10.000 s、全量解码 exit 0，
  `auto` 已选 WGC 无回退）；同时修复原型 `IDirect3DSurface→ID3D11Texture2D` 读取 bug
  （须经 `IDirect3DDxgiInterfaceAccess`）。区域 30.06 fps/0 复制、窗口 hidden/visible
  与 Low IL 逐项一致（隐藏窗口全黑非 IL 造成）。10 分钟 Medium IL 时钟/资源样例见
  [r0-media-native.md](../r0-media-native.md) §4.14.5。

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

> **2026-11-11 更正的 WGC 结论**：2026-11-11 早段工作区 ACL 的 Low Mandatory Label 使
> `native-capture.exe` 以 **Low IL(0x1000)** 运行，导致 WGC `E_ACCESSDENIED`；19:40 ACL
> 修复为 Medium 后复验，**WGC 两路径创建 item 均成功、10 s@30 fps 采集可解码**（详见
> [r0-media-native.md](../r0-media-native.md) §4.1/§4.15）。因此“本机 WGC 不可用”的旧结论
> 作废；**未验证**的仍是打包身份（MSIX/`uap11:Capability`）/同意 UI/采集指示、目标 build、
> 多显示器/窗口/HDR/4K/长时 WGC。音频、暂停/时间轴、A-V 偏差指标不受 IL 影响。

| 验证项 | 实测结果 | 判定 |
|---|---|---|
| WGC 可用性 | **Medium IL（2026-11-11 19:45 复验）**：activation factory OK；`CreateForMonitor(#0 DISPLAY1)` → OK 2240×1400；`CreateForWindow(前台 Chrome 窗口)` → OK 1557×1314；`SetIsCursorCaptureEnabled(true)`/`SetIsBorderRequired(false)` 未报错。**Low IL 时期**（修复前）：两路径 `E_ACCESSDENIED 0x80070005`，per-app Allow 注入亦无效——已归因 Low IL 环境缺陷 | **WGC 本机可用（Medium IL）**；旧“不可用”结论作废。打包身份/同意/真机矩阵仍未验证 |
| WGC 10 s@30 fps 采集（2026-11-11 Medium IL） | `--capture wgc --monitor 0 --animate`：送达 **590 帧（56.77 fps）**、写入 **300 帧**、同槽丢弃 290、**复制补齐 0**、到达缺口 0；帧间隔 p50 16.65/p95 18.82 ms；视频 300 帧/**10.000 s**/1,055,818 B、h264 High 2240×1400；唯一哈希 300/300、全黑 0；全量解码 **exit 0**；时间轴缺槽 0/有效 30.0000 fps；`auto` 亦选 WGC 无回退。首次运行曾因 `IDirect3DSurface→ID3D11Texture2D` 直接 QI 得到 `E_NOINTERFACE 0x80004002`，改经 `IDirect3DDxgiInterfaceAccess::GetInterface` 后成功 | **WGC 采集链路成立（本机/Medium IL）**；CPU/内存与 GDI 的同条件对照、长时/4K/HDR/多显示器属 R5 |
| 桌面采集（GDI） | 当前机 2240×1400@30：送达约 **25.3 fps**（30 min 45,597 帧）、复制补齐 15.7%、时间轴缺槽 0、有效 30 fps；Low IL 与 Medium IL 区域对照一致（30.1 vs 30.06 fps）。11-10 首机 1440×2560@30 通过（301/301 帧、0 丢帧、p50 31.67 ms）。 | **可行下限成立**；GDI 全屏达不到 30 fps 唯一内容，WGC 才是全屏/4K 正路 |
| 4K@30 抽样 | 3 s：87/90 帧、28.8fps、CPU ≈2.88 核 | GDI 整帧拷贝在 4K@30 接近上限 |
| WASAPI loopback | 48kHz/8ch float32（取前 2 声道）：480,960 帧/10.020s/1,923,840 B 与期望完全一致；静音/非静音包语义验证 | 通过 |
| A/V mux | 视频 copy + AAC 192k → `capture.mp4` 1,989,344 B、10.03s、全量解码通过；`start_offset=-21.33ms`（=AAC 1024 采样 priming，扣除后≈0）、`end_skew=-44.33ms` | 通过；时钟裁齐/容差需 R5 冻结 |
| 背压（慢消费者） | 有界队列无无界内存；但输出 6.80s < 墙钟 10.03s → 反压会截短时间轴 | 需 R5 冻结丢帧/暂停/限载语义 |
| 失败分支 | WGC 严格模式 exit 2 且无半成品；ffmpeg 缺失 (os error 2)、编码器缺失（`Unknown encoder` + 管道关闭 232）、音频端点无效 `0x80070057` 均逐字记录 | 可诊断 |
| Debug/Release 口径 | Debug 仅功能对照；Release 也是本机单次、非隔离、电源方案未冻结（初版）；扩展长测固定高性能并登记并行负载 | 不是产品基线 |
| 暂停/继续（扩展，GDI） | 12 s 媒体、暂停 2 s+1 s：视频 360 帧/12.000 s/时间轴缺槽 0/有效 30.000 fps；音频暂停丢弃 144,000 帧=3.000 s×48 kHz；mux start_offset −21.33 ms（AAC priming）、end_skew −27～−34 ms（无暂停基线 −49.3 ms）；恢复槽位差 2/3（每边界约 1 帧复制） | **成立**；恢复相位/边界容差需 R5 冻结 |
| 双音源（扩展） | 端点枚举 2 render + 2 capture；loopback(Realtek 扬声器)+Intel 麦克风阵列同时采集 8.16/8.05 s，混音 1,545,644 B、clipped=0、mux 可解码；互相关峰值 0.011（放大测试音后 0.006） | **采集/混音成立；双路时间对齐本机不可测（环境限制）** |
| 区域/窗口/源目标变化（扩展） | 区域 640×360@30.1 fps、0 丢帧；窗口三方法：隐藏窗口 printwindow/window-dc 196/196 全黑、screen 采背景；可见窗口 printwindow/window-dc 仅 1/262 全黑；场景移动/关闭/重解析事件完整；目标丢失约 1 s 时输出视频 9.07 s < 媒体 9.5 s（max_fill 截短）。**窗口部分运行在 Low IL，须修复后重验** | 行为证据成立（待 Medium IL 复验）；逐帧内容对照/真实应用窗口/丢失期语义待 R5 |
| 30 分钟时钟样例 + 资源峰值（扩展） | 当前机 Release GDI：**54,000 帧 / 1800.000 s / 时间轴缺槽 0 / 有效 29.9999 fps**；视频 107.4 MB 全量解码 exit 0；采集侧送达 45,597 帧（25.33 fps）、复制补齐 15.7%；音频 1800.020 s、WAV 345.6 MB；mux 1800.000 s/151.9 MB/decode 0；A/V start −21.33 ms（AAC priming）、end −32.67 ms/30 min（无累积漂移证据）；进程树峰值 Private 1,219.6 MB、CPU 2.28 核（2 s 峰值）/1.55 核均值；T4 候选见 [r0-media-native.md](../r0-media-native.md) §4.14（Low IL 环境数据） | **R0 完成、阈值未冻结**；Medium IL 与多次运行待补 |

## 5. 结论（建议）

**建议候选 C（混合）：视频与系统音频由原生层采集，WebView 只做 UI/合成/编码。**
WebView2 路径**不能**作为 R5 唯一后端（无法程序指定源、必弹选源 UI、loopback 不可程序控制，
与基线“点开始即录指定屏幕/窗口”不等价）。原生路径的**可行下限已实测成立**（GDI 采集 + 有界管道
+ ffmpeg 编码、WASAPI loopback、A/V mux、背压与失败诊断），但：

1. **WGC 可行性置信度=中（2026-11-11 Medium IL 更正）**：旧 `E_ACCESSDENIED` 是工作区 ACL
   的 Low IL 环境缺陷（§4.2），ACL 修复后本机 Medium IL 下 WGC 两路径可创建 item，且
   **WGC 10 s@30 fps 采集成功、可播放**（送达 56.77 fps、复制补齐 0）。R5 若选 WGC，
   仍必须把“打包身份 / `graphicsCaptureProgrammatic` 能力声明 / 用户同意 / 采集指示 /
   目标 Windows build（含 Win10 22H2 与近期 `CreateForMonitor` 回归报告）/ 多显示器 /
   HDR / 4K / 长时复验”纳入产品方案并在目标环境实测；GDI 不是等价物（无光标、无采集指示、
   叠加层/D3D 内容风险、整帧 CPU 拷贝；当前机全屏 2240×1400 只有 21–25 fps 唯一内容，
   WGC 同期 56.8 fps）。
2. R5 需要新增“原生采集 + 混音 + 同一媒体时钟 + 编码/发布”的工作量与风险；原 8–14 人周估算需按
   本证据重估（计划 §11 要求 R0 后重估），在 G0 报告中给出修正区间。
3. WebView 保留为 UI/合成/编码：canvas + MediaRecorder webm 闭环已实测通过，分块 IPC 写盘可行，
   但该 chunked IPC 只是原型参考，生产协议另设计（ADR-0005）。
4. **G0 前仍缺**：两路同条件对照（§9.2）、WGC 打包身份/同意实测、Runtime 版本矩阵、
   真实测试机矩阵。2026-11-11 扩展已补：30 分钟 Low IL + 10 分钟 Medium IL 时钟样例、
   暂停/继续、双音源采集/混音、区域/窗口与源目标变化、WGC 10 s 采集、T4 候选；
   **仍未验证**：WGC 打包身份/同意 UI/采集指示、Win10/其它 build、多显示器/HDR/4K/长时 WGC；
   双路时间对齐（本机麦克风拾不到渲染音）、逐帧内容等价性、目标丢失期间时间轴语义。
   因此本 ADR 不写“已选定/已冻结”。
5. **对 R5 的附加含义（扩展证据）**：
   - 暂停/继续可以用“媒体时钟扣除暂停时长 + 音频丢弃暂停期样本”实现，但恢复帧相位、
     音频边界（5 ms 轮询）需要统一定义并冻结容差；
   - 双音源混音链路可复用（任意 capture 端点 + 饱和相加），但**端点预检**必不可少
     （本机默认输出/输入均为虚拟设备：无活跃渲染流时 loopback 0 包、默认虚拟麦克风全零）；
   - 窗口采集必须区分可见性/遮挡/目标丢失：隐藏窗口 PrintWindow 在本机全黑、
     GDI 屏幕路径只能采背景（该行为在 Low IL 与 Medium IL 下**逐项一致**，非环境造成）；
     产品目标选择应禁止“不可见窗口”或明确降级语义；
   - GDI 全屏 2240×1400 在当前机只有约 21–25 fps 唯一内容（CAPTUREBLT 开关无显著差异），
     30 fps 只能靠复制帧补齐；**WGC 在 Medium IL 下 10 s 送达 56.8 fps、复制补齐 0**，
     仍是全屏/4K/高帧率的正路（打包身份/同意/真机矩阵待 R5）。
   - **T4 媒体阈值候选（未冻结，Low IL 30 min + Medium IL 10 min 数据；§4.14.5）**：
     P1 profile（2240×1400@30 GDI + libx264 veryfast CRF23 + AAC mux）下进程树峰值
     Private Bytes ≤1.35 GB、采集进程 ≤64 MB、Working Set ≤1.1 GB、CPU 均值/p95/峰值
     ≤2.0/2.5/3.0 核、输出时间轴
     `missing_slots=0`、A/V end_skew ≤50 ms/30 min；mux/解码后处理另立口径
     （CPU 峰值 11.2 核、Private ≤250 MB）。须在 ACL 修复后 Medium IL、至少 2–3 次运行、
     固定媒体 profile 后重测，由 G0 决策，登记到 r0-performance-baseline.md T4 行。

## 6. 未解决限制

- **WGC 已在本机 Medium IL 取得成功采集证据（2026-11-11 更正）**，但仅覆盖
  Win11 26H2/单屏 2240×1400/10 s/未打包 exe；打包身份（MSIX/`uap11:Capability`）、
  同意 UI/采集指示/企业策略、Win10 22H2 与其它 build、多显示器/窗口/HDR/4K/60/长时 WGC
  均未验证。旧 `E_ACCESSDENIED` 已归因工作区 Low IL 环境缺陷（已修复）。
- WebView 路径的系统音频轨、track settings、人工选源后的完整链路未验证。
- 双音源时间对齐在本机不可测（麦克风拾不到渲染音，互相关峰值 ≈0.01）；虚拟麦克风全零；
  多声道（>2）混音、设备热插拔/默认端点切换未验证。
- 窗口采集只到行为/统计级：隐藏窗口不可采内容、遮挡未做逐帧内容对照、
  `--window-follow` 只按标题重解析；真实应用窗口（浏览器/Office/独占全屏）、多显示器/DPI
  矩阵未验证。
- 暂停恢复相位（每边界约 1 帧复制）与音频暂停边界（5 ms 轮询）未冻结；
  源目标丢失期间的时间轴语义（当前 max_fill 会截短视频）未冻结。
- 长时样例为单次运行（Low IL 30 min + Medium IL 10 min）；Medium IL 10 min 样例受同机并行
  负载影响（见 r0-media-native.md §4.14.5 的异常说明），T4 只有候选区间，未冻结；
  Registry/性能仍不能当产品基线。
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
| 2026-11-11 | 扩展证据（当前机 SHERUNLOCK02）：暂停/继续成立（视频 0 缺槽、音频丢弃=暂停时长）；双音源采集/混音成立、双路对齐本机不可测；区域 30 fps、窗口三方法可见/隐藏/遮挡/移动/关闭/重解析行为；30 分钟时钟样例与进程树峰值；T4 媒体阈值候选（未冻结）；补充 R5 端点预检/窗口可见性/时间轴语义要求 | [r0-media-native.md](../r0-media-native.md) §4.11～§4.14、`.tmp-r0-media-native/` |
| 2026-11-11（同日后补） | **环境缺陷**：工作区 ACL 的 Low Mandatory Label 使原型 exe/ffmpeg 以 Low IL 运行；WGC `E_ACCESSDENIED` 与窗口采集隐藏/遮挡结论标注“待修复后重验”，音频/暂停/时间轴/A-V 指标不受影响；新增重验清单 | [r0-media-native.md](../r0-media-native.md) §4.15、`.tmp-r0-media-native/env-integrity/` |
| 2026-11-11（19:40–20:25，ACL 修复后） | **WGC 结论更正**：ACL Low→Medium 后 `CreateForMonitor`/`CreateForWindow` 均 OK；修复原型 surface→texture 读取 bug 后 **WGC 10 s@30 fps 采集成功、可解码**（送达 56.77 fps、复制补齐 0），`auto` 无回退 → “本机 WGC 不可用”作废，置信度低→中；区域/窗口 hidden/visible 在 Medium IL 逐项复现（非 IL 造成）；新增 Medium IL 10 分钟时钟/资源样例（受并行负载扰动，见 §4.14.5 说明）；未验证项（打包身份/同意/采集指示/目标 build/多显示器/HDR/4K/长时 WGC）保留 | [r0-media-native.md](../r0-media-native.md) §4.1/§4.13.1/§4.14.5/§4.15、`.tmp-r0-media-native/{probe-wgc-medium,wgc-10s-medium,auto-wgc-5s-medium,long-10min-medium,long-10min-medium-r2}/` |
