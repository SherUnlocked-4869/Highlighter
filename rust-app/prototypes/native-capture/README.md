# native-capture（R0-05 原生媒体采集原型）

日期：2026-11-10（初版）/ 2026-11-11（扩展：暂停续录、双音源、区域/窗口、30 分钟样例）。
状态：**R0 风险验证原型，不是产品代码**。
上位文档：[R0 媒体采集原生路径证据](../../../docs/plans/rust-migration/r0-media-native.md)、
[开发计划 §7 R0-05 / §9.2](../../../docs/plans/2026-11-10-rust-migration-development-plan.md)、
[R0 基线 §4.1 媒体后端](../../../docs/plans/rust-migration/r0-baseline.md)。

本工程独立于 `rust-app` 父 workspace（`Cargo.toml` 内自带空 `[workspace]` 表），
`Cargo.lock` 一并提交/锁定。R0 期间只在原型目录和 `.tmp-r0-media-native/` 产物目录内工作。

## 1. 回答什么问题

用最小 Rust 程序验证「原生媒体后端」是否可行，以及代价量级：

1. 桌面采集：显示器/区域/窗口三种目标；**Windows.Graphics.Capture（WGC）** 优先，GDI 回退；
2. 原始 BGRA 帧经**有界通道 + stdin 管道**交给 ffmpeg 编码 H.264 MP4；
3. **WASAPI loopback** 系统声音 + **任意 capture 端点（第二音源/麦克风）**；
   可混音（`--audio-mix`）或双路分别落盘，并对双路做互相关对齐测量；
4. **暂停/继续**：暂停期间媒体时间轴冻结（视频不采帧、音频包丢弃），恢复后时间轴连续；
5. **窗口采集与源目标变化**：PrintWindow / BitBlt(window DC) / BitBlt(screen DC) 三种方法，
   移动/遮挡/关闭/按标题重解析到另一窗口的行为与失败记录；
6. **30 分钟时钟样例**与资源峰值（`run-long-sample.ps1`，含电源方案 before/during/after）；
7. 逐帧时间戳/哈希/亮度，统计帧数、丢帧、帧间隔、全黑帧；`ffmpeg` 全量解码、
   `-debug_ts` 逐包时间轴连续性、A/V 首末偏移；
8. 失败分支保留原始错误；Debug/Release 必须分开标注。

## 2. 环境

- Windows 11 x64（本机 `10.0.26300`），Rust `1.97.1`（`rust-app/rust-toolchain.toml` 固定）；
- ffmpeg：`node_modules/ffmpeg-static/ffmpeg.exe`（6.1.1-essentials，含 libx264；**无 ffprobe**，
  容器/流信息用 `ffmpeg -i`、`-debug_ts`、`-progress` 解析）；
- 输出目录：`.tmp-r0-media-native/`（仓库 `.gitignore` 的 `.tmp*/` 忽略，不提交）。

## 3. 构建与运行

在仓库根目录（Windows PowerShell / bash 均可；工具链由 `rust-app/rust-toolchain.toml` 固定）：

```powershell
# debug（功能/失败分支调试；性能数字不能当 Release 基线）
cargo build --manifest-path rust-app/prototypes/native-capture/Cargo.toml

# release
cargo build --release --manifest-path rust-app/prototypes/native-capture/Cargo.toml
```

常用链路（默认 `--monitor 1` 副屏；本机只有主屏时显式 `--monitor 0`）：

```powershell
# 1) 端点枚举（render + capture，含默认端点与混音格式）
native-capture.exe --list-audio --out .tmp-r0-media-native/list-audio

# 2) 桌面 10s + 系统声音 + 合成测试音（让虚拟端点 loopback 有确定内容）+ mux
native-capture.exe --seconds 10 --fps 30 --capture gdi --monitor 0 --no-animate `
  --audio --tone --tone-amp 0.002 --out .tmp-r0-media-native/av-10s

# 3) 暂停/继续：媒体时间 3s 暂停 2s，7s 暂停 1s（媒体时长 12s）
native-capture.exe --seconds 12 --fps 30 --capture gdi --monitor 0 --no-animate `
  --audio --tone --pause-at 3,7 --pause-ms 2000,1000 --out .tmp-r0-media-native/pause-12s

# 4) 区域采集
native-capture.exe --seconds 5 --fps 30 --capture gdi --region 300,200,640,360 `
  --no-animate --out .tmp-r0-media-native/region-5s

# 5) 双音源（loopback + 麦克风，混音落盘；端点 ID 用 --list-audio 获取）
native-capture.exe --seconds 8 --fps 30 --capture gdi --monitor 0 --no-animate `
  --audio --audio-endpoint '<render-endpoint-id>' --audio2 '<capture-endpoint-id>' `
  --audio-mix --tone --tone-amp 0.03 --out .tmp-r0-media-native/dual-audio

# 6) 窗口目标变化场景（默认隐藏窗口；--scenario-visible 需要用户许可）
native-capture.exe --scenario window-target --out .tmp-r0-media-native/scenario-hidden
native-capture.exe --scenario window-target --scenario-visible --out .tmp-r0-media-native/scenario-visible

# 7) 30 分钟时钟样例 + 进程树资源峰值（切换高性能方案、结束后恢复）
pwsh -NoProfile -File rust-app/prototypes/native-capture/run-long-sample.ps1 `
  -OutDir .tmp-r0-media-native/long-30min -Seconds 1800
```

产物（`--out` 目录）：

| 文件 | 内容 |
|---|---|
| `video.mp4` | 视频-only H.264（libx264，yuv420p，CRF 23，GOP=2×fps，+faststart） |
| `audio.wav` / `audio2.wav` | loopback / 第二音源的 16-bit PCM WAV（流式写盘；短录保留内存副本用于分析） |
| `audio-mix.wav` | `--audio-mix` 时两路饱和相加混音（短录） |
| `capture.mp4` | A/V mux 结果（视频 copy + AAC 192 kb/s，按测量到的音频前导裁剪） |
| `pause-windows.txt` | 每次暂停的计划/实际时长、媒体起止、暂停前后视频槽位与恢复槽位差 |
| `window-events.txt` | 窗口目标事件时间线（移动/可见性/失效/重解析）与统计 |
| `audio-endpoints.txt` | `--list-audio` 的端点枚举证据 |
| `video-timeline.txt` | 输出视频逐包 pts 排序后的时间轴连续性（缺槽/最大间隔/有效 fps/B 帧重排） |
| `av-spans.txt` | `-debug_ts` 解析出的每路流首末包时间戳与偏移 |
| `run.log` / `summary.json` / `metrics.txt` | 完整日志与结构化指标（`k=v` 便于文档引用） |
| `probe-*.txt` | `ffmpeg -i` 原始输出 |

## 4. CLI

| 参数 | 默认 | 说明 |
|---|---|---|
| `--seconds` | `10` | 媒体时长（墙钟时长 = 媒体时长 + 暂停时长） |
| `--fps` | `30` | 目标输出帧率（帧按捕获时间重采样到该时间轴） |
| `--capture` | `auto` | `auto`=WGC 失败回退 GDI；`wgc`/`gdi` 强制；区域/窗口只支持 gdi |
| `--monitor` | `1` | 显示器索引（0=主屏；默认副屏以遵守仓库 AGENTS.md） |
| `--region` | — | `x,y,w,h`（虚拟桌面物理像素）固定区域采集 |
| `--window-title` / `--window-hwnd` | — | 窗口采集目标（标题子串/显式 hwnd） |
| `--window-method` | `printwindow` | `screen` / `window-dc` / `printwindow` |
| `--window-follow` | 关 | 目标失效时按标题重新解析到另一窗口 |
| `--window-exclude` | — | 标题排除子串（可重复） |
| `--audio` | 关 | 采集 WASAPI loopback 并 mux |
| `--audio-endpoint` / `--audio-endpoint-name` | 默认渲染端点 | loopback 的 render 端点 |
| `--audio2` | `off` | 第二音源：`auto`=默认采集端点；也可直接给 capture 端点 ID |
| `--audio2-name` | — | 第二音源按名称子串选择 |
| `--audio-mix` | 关 | loopback+第二音源混音（`--seconds <= 120` 的短录） |
| `--tone` / `--tone-freq` / `--tone-amp` | 关 / `440` / `0.02` | 合成正弦测试音（渲染到 `--tone-endpoint`，给 loopback 确定内容） |
| `--tone-endpoint` / `--tone-endpoint-name` | 同 loopback 端点 | 测试音渲染端点 |
| `--pause-at` / `--pause-ms` | — | 暂停触发媒体时间列表 / 每次暂停毫秒列表（单值广播） |
| `--no-captureblt` | 关 | GDI 不使用 `CAPTUREBLT`（不抓分层窗口，通常更快） |
| `--no-animate` | — | 不创建测试动画窗口 |
| `--queue` | `4` | ffmpeg 管道有界帧队列长度 |
| `--slow-consumer-ms` | `0` | 每帧人为延迟，复现慢盘/背压 |
| `--no-fallback` | — | `auto` 下 WGC 失败不回退 |
| `--codec` / `--preset` / `--crf` | `libx264` / `veryfast` / `23` | 编码参数 |
| `--list-audio` | — | 枚举 ACTIVE render/capture 端点后退出 |
| `--scenario` / `--scenario-visible` | — | `window-target` 场景（默认隐藏窗口；可见需许可） |
| `--probe-wgc` | — | 只探测 WGC 可用性矩阵 |
| `--fault-wgc-hmon` | — | 故障注入：无效 HMONITOR 触发真实 WGC 错误 |

退出码：`0=ok`、`1=partial`（视频通过但音频/mux 失败）、`2=失败`。

## 5. 实现要点

```text
src/main.rs            CLI、编排、指标落盘、场景模式（窗口目标变化）、Debug/Release 标注
src/capture/mod.rs     显示器枚举、目标解析（显示器/区域/窗口）、按时间轴重采样、暂停媒体时钟
src/capture/wgc.rs     WGC：D3D11 设备 → WinRT → CreateForMonitor → FramePool → staging
                       （surface 经 IDirect3DDxgiInterfaceAccess 取 ID3D11Texture2D）
src/capture/gdi.rs     GDI：屏幕矩形/窗口三方法 BitBlt；暂停检查、逐帧事件
src/capture/window.rs  窗口枚举/几何（DWM 扩展边框）、PrintWindow/WM_PRINT/GetWindowDC 抓取、
                       移动/失效/重解析事件与统计
src/testwin.rs         受控测试窗口（可见/隐藏、定时重绘、WM_PRINT，自绘内容）
src/ffmpeg.rs          有界通道写线程 → ffmpeg stdin；stderr 排空；帧哈希/亮度；mux
src/wasapi.rs          端点枚举、loopback/capture 采集、流式 WAV、暂停丢弃、合成测试音、
                       混音/重采样、WAV 读写
src/pause.rs           暂停调度状态机（媒体时钟、暂停窗口、恢复槽位差）+ 跨线程 PauseGate
src/sync.rs            双路对齐（降采样归一化互相关）、电平统计、测试音起点检测
src/verify.rs          ffmpeg -i / -xerror / -debug_ts / -progress 证据解析、时间轴连续性
src/anim.rs            测试动画窗口（只出现在被采集显示器）
src/cpumon.rs          GetProcessTimes：本进程 + ffmpeg 子进程 CPU
run-long-sample.ps1    30 分钟样例外壳：电源方案、进程树采样、解码/哈希/峰值汇总
```

- **帧时间轴重采样**：按捕获时间把帧映射到 `1/fps` 槽位：同槽多余帧丢弃（`pacing_drops`），
  跨槽缺口用上一帧复制补齐（`duplicated`，单次上限 10 帧），保证输出视频时长与采集墙钟一致。
- **暂停语义**：媒体时间 `= wall − t0 − paused_total`；暂停期间视频不采帧、音频取包后丢弃
  （`discarded_paused_frames`）。恢复后视频槽位差与暂停窗口一起写入 `pause-windows.txt`；
  音频时间轴不含暂停时长，两路换算到同一媒体时钟后做 A/V 偏差测量。
- **窗口目标**：每帧重新读取窗口矩形（DWM 扩展边框），因此移动可跟随；目标失效时若
  `--window-follow` 则按标题重解析到另一窗口；事件时间线写入 `window-events.txt`。
  输出尺寸在采集开始前固定，尺寸变化按左上角裁剪/补黑并记事件（R5 另定）。
- **音频**：loopback 默认端点在本机是虚拟设备，**无活跃渲染流时不出包**，因此长录/A-V 证据
  用 `--tone` 渲染持续测试音（幅度可极低，听感近静音）保证音频引擎持续工作；音频流式写
  WAV，长录不把整段 PCM 留在内存。
- **A/V 对齐**：音频先于视频启动并记录 `Instant`；首帧视频到达时测音频前导 `audio_lead_s`；
  mux 时用输入侧 `-ss` 裁掉前导；`-debug_ts` 解析两路首末包 pts 计算 `start_offset_ms` /
  `end_skew_ms`（AAC 1024 采样 ≈ 21.3 ms priming 必须扣除后解读）。
- **帧质量**：Release 对每帧全帧 BGRA 三字节做 FNV-1a 64 并统计精确亮度/全黑帧；
  Debug 为每 16 像素采样（`quality_mode` 字段记录口径）。

## 6. 本机已知限制（R0 证据，不是产品结论）

0. **环境缺陷已修复（2026-11-11）**：此前工作区目录树带 `Mandatory Label\Low Mandatory Level`
   继承，导致工作区内编译的 exe **以 Low IL(0x1000) 运行**；Lead 已把工作区 ACL 修复为
   Medium（61,767 文件 Low→Medium），本原型运行时日志现在输出
   `[env] process integrity level = Medium(0x2000)`。Low IL 时期的 `E_ACCESSDENIED` 等
   结论作废；证据与对照见
   [r0-media-native.md](../../../docs/plans/rust-migration/r0-media-native.md) §4.15。
1. **WGC 在本机 Medium IL 可用（2026-11-11 更正）**：`CreateForMonitor`/
   `CreateForWindow` 均成功；修复 `IDirect3DSurface→ID3D11Texture2D` 读取 bug（须经
   `IDirect3DDxgiInterfaceAccess`）后，WGC 10 s@30 fps 采集成功（送达 590 帧/56.77 fps、
   写入 300 帧、复制补齐 0、全量解码 exit 0）。仍**未验证**：打包身份（MSIX/能力声明）、
   同意 UI/采集指示、Win10/其它 build、多显示器/窗口/HDR/4K/60/长时 WGC。
2. **GDI 全屏采集在本机达不到 30fps 唯一内容**：2240×1400 全屏约 21–25 fps（CAPTUREBLT 开关
   无显著差异），输出时间轴仍按 30fps 均匀补齐（`duplicated_frames`）；640×360 区域可达
   30.1 fps（Low/Medium IL 一致）。分辨率越高 GDI 整帧读回成本越大。
3. **窗口方法差异**：隐藏窗口的 `printwindow`/`window-dc` 在本机全黑（196/196 帧），
   `screen` 采到桌面背景；可见窗口 `printwindow`/`window-dc` 可采到窗口内容（黑帧 1/262）。
   遮挡场景的逐帧内容对比（哪一路采到遮挡物）只做到事件/帧统计级，未做逐帧图像对照。
4. **双音源对齐未成立**：loopback（Realtek 扬声器）+ Intel 数字麦克风同时采集/混音通过，
   但麦克风未拾到本机渲染的测试音（互相关峰值 ≈0.01），无法测出有效声学延迟；
   虚拟麦克风端点全零。属本机声学/隐私路径限制，不是采集链路失败。
5. **暂停边界粒度**：音频暂停由 5 ms 轮询门控，边界样点归属误差 ≤~一个轮询周期；
   恢复后首个视频槽位与暂停前最后槽位差通常为 2（即 1 帧重复补齐），R5 需冻结时钟平滑策略。
6. 未验证：WGC 打包身份、设备热插拔/默认端点切换、真实慢盘、磁盘满、崩溃恢复、
   Windows 10/其它 build、长录中用户切换显示/会话锁屏、GPU 编码。
