# native-capture（R0-05b 原生媒体采集最小闭环原型）

日期：2026-11-10。状态：**R0 风险验证原型，不是产品代码**。
上位文档：[R0 媒体采集原生路径证据](../../../docs/plans/rust-migration/r0-media-native.md)、
[开发计划 §7 R0-05 / §8 G0](../../../docs/plans/2026-11-10-rust-migration-development-plan.md)、
[R0 基线 §4.1 媒体后端](../../../docs/plans/rust-migration/r0-baseline.md)。

本工程独立于 `rust-app` 父 workspace（`Cargo.toml` 内自带空 `[workspace]` 表），
`Cargo.lock` 一并提交/锁定。R0 期间只在原型目录和 `.tmp-r0-media-native/` 产物目录内工作。

## 1. 回答什么问题

用最小 Rust 程序验证「原生媒体后端」是否可行，以及代价量级：

1. 桌面采集：**Windows.Graphics.Capture（WGC）** 优先，失败/不可用时 **GDI BitBlt** 回退；
2. 原始 BGRA 帧经**有界通道 + stdin 管道**交给 ffmpeg 编码 H.264 MP4；
3. **WASAPI loopback** 采系统声音 → 16-bit PCM WAV → 与视频 mux 成 MP4，并测量 A/V 偏差；
4. Rust 侧逐帧记录时间戳/哈希/亮度，统计帧数、丢帧、帧间隔、全黑帧；
5. 失败分支（无 WGC、无 loopback 设备、管道背压、ffmpeg 失败）保留原始错误；
6. 输出 CPU、耗时、文件大小、编码参数；Debug/Release 必须分开标注。

**不做**（后续批次）：区域/窗口/多显示器组合、双音源混音、麦克风、暂停/继续、
30 分钟长录、设备热插拔、编码队列/取消、项目契约、产品宿主集成（R5）。

## 2. 环境

- Windows 11 x64（本机 `10.0.26300`），Rust `1.97.1`（`rust-app/rust-toolchain.toml` 固定）；
- ffmpeg：`node_modules/ffmpeg-static/ffmpeg.exe`（6.1.1-essentials，含 libx264；**无 ffprobe**，
  容器/流信息用 `ffmpeg -i`、`-debug_ts`、`-progress` 解析）；
- 输出目录：`.tmp-r0-media-native/`（仓库 `.gitignore` 的 `.tmp*/` 忽略，不提交）。

## 3. 构建与运行

在仓库根目录（Windows，bash 或 PowerShell 均可；工具链由 `rust-app/rust-toolchain.toml` 固定）：

```bash
# debug（功能/失败分支调试；性能数字不能当 Release 基线）
cargo build --manifest-path rust-app/prototypes/native-capture/Cargo.toml

# release
cargo build --release --manifest-path rust-app/prototypes/native-capture/Cargo.toml
```

一键 10 秒 30fps 桌面采集 + 系统声音 + mux（默认采副屏 `--monitor 1`，测试动画窗口也只放副屏）：

```bash
mkdir -p .tmp-r0-media-native/release-av
rust-app/prototypes/native-capture/target/release/native-capture.exe \
  --seconds 10 --fps 30 --capture auto --audio --monitor 1 \
  --out .tmp-r0-media-native/release-av
```

产物（`--out` 目录）：

| 文件 | 内容 |
|---|---|
| `video.mp4` | 视频-only H.264（libx264，yuv420p，CRF 23，GOP=2×fps，+faststart） |
| `audio.wav` | loopback 16-bit PCM WAV（48 kHz，取混音格式前 2 声道） |
| `capture.mp4` | A/V mux 结果（视频 copy + AAC 192 kb/s，按测量到的音频前导裁剪） |
| `run.log` | 完整运行日志（含原始 HRESULT、ffmpeg argv、逐帧统计） |
| `summary.json` / `metrics.txt` | 结构化指标（`k=v` 便于文档引用） |
| `probe-video.txt` / `probe-audio.txt` / `probe-mux.txt` | `ffmpeg -i` 原始输出 |
| `av-spans.txt` | `-debug_ts` 解析出的每路流首末包时间戳与偏移 |

## 4. CLI

| 参数 | 默认 | 说明 |
|---|---|---|
| `--seconds` | `10` | 采集时长（墙钟秒） |
| `--fps` | `30` | 目标输出帧率（帧按捕获时间重采样到该时间轴） |
| `--capture` | `auto` | `auto`=WGC 失败回退 GDI；`wgc`/`gdi` 强制 |
| `--audio` | 关 | 采集 WASAPI loopback 并 mux |
| `--no-mux` | — | 只采音频不 mux |
| `--out` | `.tmp-r0-media-native/latest` | 产物目录 |
| `--ffmpeg` | `node_modules/ffmpeg-static/ffmpeg.exe` | ffmpeg 路径 |
| `--monitor` | `1` | 显示器索引（0=主屏；默认副屏以遵守仓库 AGENTS.md） |
| `--no-animate` | — | 不创建测试动画窗口（静止桌面下 WGC 可能零帧） |
| `--animate` | 开 | 在被采集显示器上创建 480×270 动画窗口制造内容变化 |
| `--queue` | `4` | ffmpeg 管道有界帧队列长度（背压设计点） |
| `--slow-consumer-ms` | `0` | 每帧人为延迟，复现慢盘/背压 |
| `--no-fallback` | — | `auto` 下 WGC 失败不回退 |
| `--codec` / `--preset` / `--crf` | `libx264` / `veryfast` / `23` | 编码参数 |
| `--audio-endpoint` | 默认渲染端点 | 指定端点 ID（无效 ID 用于失败分支证据） |
| `--fault-wgc-hmon` | — | 故障注入：无效 HMONITOR 触发真实 WGC 错误 |
| `--probe-wgc` | — | 只探测 WGC 可用性矩阵（逐显示器 + 前台窗口），不采集 |

退出码：`0=ok`、`1=partial`（视频通过但音频/mux 失败）、`2=失败`。

## 5. 实现要点

```text
src/main.rs          CLI、编排、指标落盘（Debug/Release 标注）
src/capture/mod.rs   显示器枚举、后端解析（编码前确定 WGC 真实尺寸）、按时间轴重采样、统计
src/capture/wgc.rs   WGC：D3D11 设备 → WinRT IDirect3DDevice → CreateForMonitor → FramePool(FreeThreaded)
                     → FrameArrived 回调 CopyResource 到 staging → Map/逐行拷贝 BGRA
src/capture/gdi.rs   GDI：CreateDIBSection(top-down BGRA) + BitBlt(SRCCOPY|CAPTUREBLT)
src/ffmpeg.rs        有界通道写线程 → ffmpeg stdin；stderr 排空；帧哈希/亮度；mux
src/wasapi.rs        IMMDeviceEnumerator → 默认渲染端点 → IAudioClient(LOOPBACK) → IAudioCaptureClient
src/verify.rs        ffmpeg -i / -xerror 全量解码 / -debug_ts 逐包时间戳
src/anim.rs          测试动画窗口（只出现在被采集显示器）
src/cpumon.rs        GetProcessTimes：本进程 + ffmpeg 子进程 CPU
```

- **帧时间轴重采样**：WGC 帧到达速率取决于桌面内容变化，不一定等于目标 fps。本原型按
  捕获时间把帧映射到 `1/fps` 槽位：同槽多余帧丢弃（`pacing_drops`），跨槽缺口用上一帧
  复制补齐（`duplicated`，单次上限 30 帧），保证输出视频时长与采集墙钟一致，并为 A/V
  对齐保留统一时间基准。
- **背压**：`sync_channel(queue)` + 写线程阻塞写 stdin。编码/写盘慢时采集侧 `send()` 阻塞，
  WGC 帧池随后丢帧（GDI 则采样节拍滑移），不会出现无界内存增长；阻塞时长计入
  `backpressure_*` 指标。
- **WGC 失败**：`probe_size()` 在启动 ffmpeg 前创建 `GraphicsCaptureItem` 探测尺寸与可用性，
  失败时 `auto` 回退 GDI 并保留原始 HRESULT；`wgc` 严格模式直接失败。
- **A/V 对齐**：音频先于 `StartCapture` 启动并记录 `Instant`；首帧视频到达时测音频前导
  `audio_lead_s`；mux 时用输入侧 `-ss` 裁掉前导；用 `-debug_ts` 解析两路首末包 pts 计算
  `start_offset_ms` / `end_skew_ms`（AAC 有 1024 采样 ≈ 21.3 ms priming，见证据文档）。
- **帧质量**：Release 对每帧全帧 BGRA 的 B/G/R 三字节做 FNV-1a 64 并统计精确亮度/全黑帧；
  Debug 为每 16 像素采样（`quality_mode` 字段记录口径）。全黑帧 = 所有像素亮度 ≤1。

## 6. 本机已知限制（R0 证据，不是产品结论）

1. **WGC 在本机被系统拒绝**：`CreateForMonitor` 与 `CreateForWindow` 均返回
   `E_ACCESSDENIED (0x80070005)`（"You do not have permission to capture the given
   monitor/window"）。本机 ConsentStore 的 `graphicsCaptureProgrammatic` 全局值=Allow，
   但进程是未打包的 Win32 exe；详见证据文档 §WGC。桌面采集因此实际走 GDI 回退。
2. GDI 与 WGC 的差异（光标、D3D/叠加层、CPU 拷贝、DWM 合成、隐私指示/权限语义）见证据文档 §差异。
3. loopback 采集的是默认渲染端点系统混音；本机混音格式为 8 声道 float32，本原型只取前
   2 声道；系统无音频播放时收到的是 SILENT 包（本次证据中音频内容是静音，字节/时长可验）。
4. 未验证：暂停/继续、设备切换、麦克风、双音源混音、30 分钟长录、慢盘真实 IO、
   Windows 10/不同 build、打包应用（MSIX）下的 WGC 权限。
