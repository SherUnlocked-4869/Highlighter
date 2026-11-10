# R0-05b 原生媒体采集最小闭环证据（ADR-0001 第二路）

- 状态：**R0 证据文档（草案）；ADR-0001 仍为“待验证”，G0 未通过前不构成架构冻结**
- 决定批次：R0-05（计划 §2 D05、§7 R0-05、§8 G0）；实施批次：R5
- 日期：2026-11-10（Asia/Hong_Kong）
- 关联计划：[Rust 改造计划](../2026-11-10-rust-migration-development-plan.md) §2 D05、§7 R0-05、§8 G0、§9.2；
  [R0 基线](r0-baseline.md) §4.1；[可行性调研](../../research/2026-11-10-rust-migration-feasibility.md) §6.2；
  [ADR 模板](adr/0000-template.md)、[ADR 索引](adr/README.md)
- 对应共享任务：`task-6`（R0-05b 原生采集最小闭环）
- 代码：[rust-app/prototypes/native-capture/](../../../rust-app/prototypes/native-capture/README.md)
  （独立 Cargo 工程，自带空 `[workspace]` 表；未改主 workspace 的 `Cargo.toml`/`Cargo.lock`）
- 产物与原始日志：`.tmp-r0-media-native/`（仓库 `.gitignore` 的 `.tmp*/` 忽略，不提交）

## 0. 结论摘要

1. **原生采集 + ffmpeg 管道编码的最小闭环在原型层面成立**：本机以 GDI BitBlt 路径
   完成 10 s@30 fps、1440×2560 桌面采集 → 原始 BGRA（301 帧、4.44 GB）经有界队列
   管道给 ffmpeg → H.264 MP4（10.03 s、1.74 MB、30 fps），`ffmpeg -i` 与全量解码
   均通过；Rust 侧记录到 301/301 帧无丢帧、帧间隔 p50 31.67 ms / p95 37.92 ms、
   全黑帧 0。
2. **WGC 在本机不可用（真实失败分支）**：`IGraphicsCaptureItemInterop::CreateForMonitor`
   与 `CreateForWindow` 均返回 `E_ACCESSDENIED (0x80070005)`（原话
   “You do not have permission to capture the given monitor/window”）。
   因此“WGC 桌面采集 10 s@30 fps”**未取得成功证据**；原型按设计回退 GDI 并保留原始
   HRESULT。WGC 的 Rust 侧代码路径（D3D11 设备 → WinRT device → frame pool →
   `FrameArrived` → staging 拷贝）已完整实现并可编译，但无法在本机取得运行证据。
3. **WASAPI loopback 与 A/V mux 成立**：48 kHz/8 声道 float32 混音格式下采集
   10.02 s（480,960 帧、1,923,840 B，与期望字节数完全一致），WAV 校验通过；
   mux 后 MP4 可解码，视频 301 包/10.033 s、音频 470 包/10.010 s。
   测得流起点偏移 −21.33 ms（恰为 AAC 1024 采样 priming），扣除 priming 后
   **起点约 0 ms**；尾部偏差 −44.33 ms，其中 priming 21.33 ms、真实尾部差 23.0 ms
   （音频在采集结束点停止，视频时间轴按 301 帧扩张到 10.033 s）。
4. **背压行为可诊断**：人为 40 ms/帧慢消费者时，192 次阻塞共 9,230.83 ms（单次最大
   54.48 ms）、20 次到达缺口、输出 6.80 s < 墙钟 10.03 s；有界队列没有无界内存增长，
   但**不能靠复制补帧掩盖编码落后**——R5 必须冻结明确的丢帧/暂停/限载策略。
5. 性能数字（Release）只代表**本机 + 本原型**量级：1440×2560@30 的整条链路
   （GDI + 全帧哈希 + 管道 + libx264）合计约 **12.5～15.1 CPU 秒 / 10.4 s 墙钟**
   （≈1.2～1.5 核），4K@30 的 3 s 抽样为 ≈2.5 核且 28.8 fps 未完全达标。
   **不得当作产品 Release 基线**；计划 §9.2 的目标阈值未冻结，本机电源方案仍为
   “平衡”（[r0-baseline.md](r0-baseline.md) §1.2），且采集期间副屏上有并行任务窗口。

## 1. 背景与问题

计划 **D05** 要求“媒体后端由 R0 决定，不能预设 WebView2 录屏等价”；失败分支为
“WebView 路径未通过选源、声音和时钟验证，转原生采集验证并重估”。可行性调研 §6.2
把录屏列为“决定能否去 Electron 的首要关口”，并列出原生后端要补齐的能力：
WGC/DXGI 视频、WASAPI 系统回环/麦克风、混音/时间戳/编码、暂停、丢帧、设备切换与异常恢复。

本路（ADR-0001 的“原生后端”候选）只回答最小问题：

1. Windows.Graphics.Capture（WGC）与 GDI BitBlt 在本机能否提供可播放的桌面视频流？
2. 原始帧经有界管道交给 ffmpeg 编码是否可行，背压/失败是否可诊断？
3. WASAPI loopback 能否与视频同窗口采集并 mux 成可解码 MP4？偏差能否测量？
4. Rust 侧能否逐帧记录时间戳/哈希/亮度，给出帧数、丢帧、帧间隔、全黑帧？
5. 上述链路的 CPU/耗时/文件大小量级，以及失败分支的原始错误是什么？

**不在本路范围**（R5）：区域/窗口/多显示器组合、双音源混音、麦克风、暂停/继续、
30 分钟长录、设备热插拔、编码队列/取消、项目契约、产品宿主/WebView 集成、
打包（MSIX）身份下的 WGC 权限。

## 2. 备选方案（本路只实测 B1/B2，B3 未测）

| 方案 | 描述 | 本路证据 | 代价/风险 |
|---|---|---|---|
| A. WebView2 采集 + Canvas/MediaRecorder | 保留现有前端路径，宿主提供“指定源 + loopback”等价绑定 | 不在本路（并行 R0-05 另一路） | 选源/loopback/时钟等价性未证明（可行性 §6.2） |
| **B1. WGC + FFmpeg 管道** | D3D11 帧池 → staging 读回 → 有界通道 → `ffmpeg -f rawvideo` | **代码完成，本机被系统拒绝（E_ACCESSDENIED），无成功运行证据** | 需查清 programmatic capture 同意/包身份；高分辨率读回与拷贝成本 |
| **B2. GDI BitBlt + FFmpeg 管道** | 屏幕 DC → DIB Section（top-down BGRA）→ 同上 | **10 s@30 fps 通过**（1440×2560）；4K@30 3 s 抽样 28.8 fps | 无光标、D3D/叠加层风险、整帧 CPU 拷贝、无系统采集指示；高分辨率/高帧率成本更高 |
| B3. Media Foundation / 自研编码 | 进程内编码（MF 或 openh264 等） | 未测 | 与产品既有 ffmpeg 导出链路重复；R5 可评估 NVENC/AMF/MF |

选 B1/B2 的编码端先用**外部 ffmpeg**：产品已有 FFmpeg 导出链路（R5-05），R0 不新造编码器，
只需验证“原始帧管道”这一段。ffmpeg-static 6.1.1 自带 `libx264`，同时也能看到
`h264_nvenc`/`h264_amf`（本路未用，作为 R5 候选）。

## 3. 实测条件与命令

### 3.1 机器与工具链（本机实测）

| 项 | 值 |
|---|---|
| OS | Windows 11 10.0.26300（`DisplayVersion=26H2`；UBR 见 r0-baseline §1.2） |
| CPU / 内存 | AMD Ryzen 7 9850X3D 8C/16T / 47.2 GiB |
| GPU | NVIDIA RTX 5070 Ti（驱动 32.0.16.1742）+ AMD 核显 |
| 显示器 | 主屏 `\\.\DISPLAY1` 3840×2160 @150%（144 dpi）；副屏 `\\.\DISPLAY2` 1440×2560 @125%（120 dpi），物理原点 `(3840, -170)`（按 R0-03 更正后的 per-monitor v2 读数） |
| 电源方案 | 平衡（未冻结，见 r0-baseline §1.2） |
| rustc / cargo | 1.97.1（`rust-toolchain.toml` 固定；windows crate **0.62.2**，features 见 `Cargo.toml`） |
| ffmpeg | `node_modules/ffmpeg-static/ffmpeg.exe`，**6.1.1-essentials_build-www.gyan.dev**，含 libx264；**无 ffprobe** |
| 构建类型 | Release（性能/验收数字）与 Debug（仅功能对照，见 §4.10） |
| 采集目标 | 默认 `--monitor 1`（副屏）：避免在用户主屏长时间显示测试窗口（仓库 AGENTS.md）；分辨率 1440×2560 |

证据完整性与噪声：采集期间副屏还有**并行任务**的窗口/浏览器页面在动（这是真实桌面），
因此帧内容会变化、编码 CPU 有波动；这不是隔离 benchmark。产物视频第 1 帧解出
`frame.png`（1440×2560，sha256 `ff563be1…3e6ee`）已人工核对是真实副屏桌面内容（非全黑/非
DPI 虚拟化的小图）。4K 抽样（§4.9）用 `--no-animate`，没有在可见屏创建窗口。

### 3.2 一键复跑命令（仓库根目录，Windows）

```bash
# 0) 构建（Prototype 独立 workspace；release 用于性能数字）
cargo build --release --manifest-path rust-app/prototypes/native-capture/Cargo.toml

# 1) WGC 可用性矩阵（只探测，不采集；逐显示器 + 前台窗口）
rust-app/prototypes/native-capture/target/release/native-capture.exe --probe-wgc --animate \
  --monitor 1 --out .tmp-r0-media-native/probe-wgc-rerun

# 2) 桌面采集 10 s@30 fps（auto：WGC 失败回退 GDI —— 本机实际走 GDI）
rust-app/prototypes/native-capture/target/release/native-capture.exe --seconds 10 --fps 30 \
  --capture auto --monitor 1 --out .tmp-r0-media-native/release-auto-10s

# 3) 强制 GDI
... --capture gdi --monitor 1 --out .tmp-r0-media-native/release-gdi-10s

# 4) A/V：loopback + mux（非静音样本见 §4.5 的 440 Hz 低幅音源）
... --seconds 10 --fps 30 --capture auto --audio --monitor 1 \
  --out .tmp-r0-media-native/release-av-10s

# 5) 背压（慢消费者 40 ms/帧）
... --capture gdi --slow-consumer-ms 40 --monitor 1 \
  --out .tmp-r0-media-native/release-backpressure-10s

# 6) 失败分支
... --ffmpeg .tmp-r0-media-native/no-such-ffmpeg.exe ...           # ffmpeg 不存在
... --codec definitely_not_a_codec ...                            # 编码器不存在
... --audio --audio-endpoint MMDEVAPI-invalid-endpoint-id ...     # 无效/无 loopback 端点
... --capture wgc ...                                             # 严格 WGC（不落回 GDI）

# 7) Debug 对照
cargo run --manifest-path rust-app/prototypes/native-capture/Cargo.toml -- \
  --seconds 10 --fps 30 --capture auto --monitor 1 --out .tmp-r0-media-native/debug-auto-10s
```

非静音音频样本的准备与播放（工作目录 = 仓库根）：

```bash
node_modules/ffmpeg-static/ffmpeg.exe -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=12" -af volume=0.002 -ac 2 \
  .tmp-r0-media-native/tone-440.wav
# 另一个终端/进程播放（PlaySync 阻塞到 12 s 结束；采集在 1 s 后启动）：
powershell -NoProfile -Command \
  "(New-Object System.Media.SoundPlayer 'F:\workspace\Highlighter\.tmp-r0-media-native\tone-440.wav').PlaySync()"
```

### 3.3 验证方法（没有 ffprobe）

| 验证项 | 方法 |
|---|---|
| 容器/流信息 | `ffmpeg -hide_banner -i <file>` 文本解析（注意：`-i` 不带输出时 ffmpeg 6.1 以 exit 1 结束，不能按退出码判失败） |
| 可解码 | `ffmpeg -v error -xerror -i <file> -f null -`，exit 0 视为全量解码通过 |
| 每路流首末时间戳 | `ffmpeg -debug_ts -i <file> -map 0:v:0 -c copy -f null -` 解析 `pkt_pts_time`/`duration_time`（见 `av-spans.txt`） |
| 交叉口径 | `ffmpeg -nostats -progress pipe:1 ... -map 0:v:0 -c copy -f null -` 的 `out_time_us` |
| 帧质量 | Rust 侧：Release 全帧 BGRA 的 B/G/R 三字节 FNV-1a 64 + 逐像素亮度；Debug 每 16 像素采样 |

## 4. 证据

### 4.1 WGC 可用性（真实失败分支，原始 HRESULT）

命令：`native-capture.exe --probe-wgc --animate --monitor 1`（先创建可见动画窗口，再探测；
另有不带窗口的 `probe-wgc` 与“写 per-app 同意项”复测，结论相同）。原始日志：
`.tmp-r0-media-native/probe-wgc/run.log`、`.tmp-r0-media-native/probe-wgc3/run.log`。

| 探测 | 结果 | 原始错误 |
|---|---|---|
| `RoGetActivationFactory("Windows.Graphics.Capture.GraphicsCaptureItem")` | **成功** | — |
| `IGraphicsCaptureItemInterop::CreateForMonitor(#0 DISPLAY1, hmon=196795)` | 失败 | `You do not have permission to capture the given monitor. (0x80070005)` |
| `CreateForMonitor(#1 DISPLAY2, hmon=196748)` | 失败 | 同上 |
| `CreateForWindow(前台窗口 HWND(0x4094c))` | 失败 | `You do not have permission to capture the given window. (0x80070005)` |
| 同一进程先创建可见窗口再探测 | 失败 | 同上（`probe-wgc3`） |
| HKCU 写入 per-app `graphicsCaptureProgrammatic\NonPackaged\<exe>` = `Allow` 后复测（测试后已删除该键） | 失败 | 同上（`probe-wgc2`） |

系统侧只读证据（`reg query`）：

```text
HKCU\...\CapabilityAccessManager\ConsentStore\graphicsCaptureProgrammatic
    Value    REG_SZ    Allow          # 全局“让应用截屏/录屏”= 允许
    ...\Microsoft.ScreenSketch_8wekyb3d8bbwe   Value=Prompt
    ...\OpenAI.Codex_2p2nqsd0c76g0             Value=Prompt
（本原型是未打包 Win32 exe；全局 Allow 下仍被拒绝）
```

判断与边界：

- 失败发生在**创建 capture item** 之前，与 D3D11 设备/帧池/StartCapture 无关；Rust 绑定
  本身正常（activation factory 成功、HRESULT 原样透传）。
- 该 Windows 版本存在 **programmatic graphics capture 的用户同意模型**（ConsentStore
  的 `graphicsCaptureProgrammatic`、ADMX 策略 `LetAppsAccessGraphicsCaptureProgrammatic`，
  设置页 URI `ms-settings:privacy-graphicscaptureprogrammatic`；打包应用需
  `<uap11:Capability Name="graphicsCaptureProgrammatic"/>`）。
  本机全局值=Allow、但本原型为未打包 exe，**无论是否写 per-app 允许项都被拒绝**；
  另一个候选原因是 agent 宿主进程的受限 token/会话上下文（未能从进程内证明）。
- 外部资料：微软 Q&A 报告 Windows 11 `26100.7623` 起 `CreateForMonitor` 在部分机器上
  开始失败（那里是 `E_INVALIDARG`），建议改用 `TryCreateFromDisplayId` + Windows App SDK
  的 `GetDisplayIdFromMonitor`——与本机现象（E_ACCESSDENIED）不同，但都说明**该 API
  在近期 Windows 版本上存在版本/权限回归面**，R5 必须锁定最低 build 并在目标机复验。
  参考：[Microsoft Q&A 26100.7623 CreateForMonitor](https://learn.microsoft.com/en-us/answers/questions/5772548/igraphicscaptureiteminterop-createformonitor-fails)、
  [uap11:Capability](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap11-capability)、
  [Privacy Policy CSP](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-privacy)。
- **未验证**：WGC 成功采集的画面/帧率/CPU 对比；打包身份或目标机上授予同意后的行为；
  `TryCreateFromDisplayId` 路径。R0 不据此下“WGC 不可用”的普遍结论，只记录本机事实。

### 4.2 桌面采集 10 s@30 fps（Release，实际后端 GDI）

两次 10 s 运行结果（`metrics.txt`）：

| 指标 | `release-auto-10s`（WGC 失败→GDI） | `release-gdi-10s`（强制 GDI） |
|---|---:|---:|
| 解析后端/实际后端 | `Gdi` / `gdi` | `Gdi` |
| 捕获尺寸 | 1440×2560 | 1440×2560 |
| 期望帧数（10 s×30） | 300 | 300 |
| 送达帧数 / 写入帧数 | **301 / 301** | **301 / 301** |
| 同槽丢弃 / 缺口复制 | 0 / 0 | 0 / 0 |
| 到达间隔 >1.5/fps 次数 | 0 | 0 |
| 实测采集墙钟 / 送达 fps | 10.021 s / **30.036** | 10.017 s / **30.048** |
| 帧间隔 mean / p50 / p95 / max | 33.32 / 31.67 / 37.92 / 39.86 ms | 33.31 / 31.63 / 37.97 / 38.90 ms |
| 背压事件（>1 ms 阻塞） | 4 次，共 11.43 ms，max 3.83 ms | 0 次 |
| 编码写入失败 | 0 | 0 |
| WGC 原始错误（fallback_reason） | `CreateForMonitor(hmon=196748) failed: You do not have permission to capture the given monitor. (0x80070005)` | —（未尝试 WGC） |

说明：

- 帧数比期望多 1（301）是时间轴重采样把首帧落在槽 0、末帧落在槽 300 的结果；
  输出视频 duration `10.03 s`、`30 fps`、301 包，与墙钟一致。
- 301 帧全部唯一（`unique_hashes=301/301`）、全黑帧 0（全帧口径），
  说明 GDI 路径在负坐标副屏（`(3840,-170)`）上确实采到了持续变化的真实桌面内容。
- 帧间隔 p50 31.67 ms 说明 GDI+定时器的采样节拍在 30 Hz 附近抖动（p95 约 38 ms）；
  **这不等于媒体时间轴抖动**（输出按捕获时间重采样到 30 fps），但说明采集侧没有硬实时保证。

### 4.3 编码、产物与 CPU（Release）

编码参数（`ffmpeg.args` 原文）：

```text
-hide_banner -loglevel warning -y -f rawvideo -pix_fmt bgra -s 1440x2560 -framerate 30
-i pipe:0 -an -c:v libx264 -preset veryfast -crf 23 -g 60 -pix_fmt yuv420p
-movflags +faststart <out>/video.mp4
```

产物验证（`probe-video.txt` / 解码检查）：

```text
Duration: 00:00:10.03, start: 0.000000, bitrate: 1406 kb/s
Stream #0:0[0x1]: Video: h264 (High) (avc1), yuv420p(progressive), 1440x2560, 1402 kb/s,
                     30 fps, 30 tbr, 15360 tbn
ffmpeg -v error -xerror -i video.mp4 -f null -   → exit 0（全量解码通过，0.24~0.25 s）
```

| 指标 | auto（GDI 回退） | gdi 强制 | 单位/说明 |
|---|---:|---:|---|
| 视频大小 | 1,742,387 | 1,742,851 | B（约 1.74 MB / 10 s） |
| 原始帧入管道 | 4,438,425,600 | 4,438,425,600 | B（301×14,745,600 B = 4.13 GiB） |
| 管道吞吐 | 418.4 | 418.5 | MiB/s（写线程 `write_all` 计） |
| 编码墙钟 | 10.117 | 10.113 | s（capture 10.02 s，编码 ≈ 实时） |
| 本进程 CPU | 5.359（user 3.047 / kernel 2.312） | 5.219（2.812 / 2.406） | s |
| ffmpeg 子进程 CPU | 9.766（5.391 / 4.375） | 7.328（4.297 / 3.031） | s |
| 合计 CPU / 运行墙钟 | 15.125 / 10.426 | 12.547 / 10.405 | s |
| 合计 ≈ 单核占用 | **145.1%** | **120.6%** | CPU 秒/墙钟（ffmpeg 多线程） |

- 两次运行的 ffmpeg CPU 差异（9.77 vs 7.33 s）主要来自**副屏并行任务导致的内容变化与
  编码复杂度波动**（同参数、同分辨率），说明本数据只能作量级参考。
- Rust 侧（本进程）CPU 中约 2 s 来自 Release 的**全帧哈希/亮度分析**（4.44 GB 的数据被
  逐像素扫描）；Debug 用 1/16 采样所以本进程 CPU 反而更低（§4.10）。
- 线程模型：采集线程（GDI 主循环）/ 写线程（stdin）/ ffmpeg 子进程 / 音频线程 / WGC 回调
  线程（本机未进入）/ 动画窗口线程。有界通道 `--queue 4` 是唯一的帧缓冲。

### 4.4 帧质量（哈希/亮度/全黑帧）

| 指标 | auto | gdi | 说明 |
|---|---:|---:|---|
| 写入帧数 | 301 | 301 | — |
| 唯一哈希数 | 301 | 301 | 每帧都不同（真实内容变化） |
| 重复哈希数 | 0 | 0 | — |
| 全黑帧数 | **0** | **0** | Release 全帧口径（所有像素亮度 ≤1 才算黑） |
| 平均亮度 min / mean / max | 27.03 / 27.29 / 27.35 | 27.01 / 27.29 / 27.36 | 0..255（BT.601 近似） |
| 质量口径 | `full-frame` | `full-frame` | Debug 为 `sampled-1of16` |

亮度均值约 27 说明副屏当时是深色 UI 内容（含并行任务窗口），不是黑屏；
`frame.png` 人工核对与 luma/hash 一致。全黑帧检测在本机没有真实黑屏样本可对照，
是“无黑帧”的观测，不是检测器自测（见 §6）。

### 4.5 WASAPI loopback（10 s，两组合成音源）

采集格式与端点（`audio.*` 指标）：

```text
device_id = {0.0.0.00000000}.{fcb9e5b4-7d4e-4711-ba90-512158c02467}   （默认渲染端点 eRender/eConsole）
mix_format = WAVEFORMATEXTENSIBLE, float32, 8 声道, 48000 Hz, 32 bit, block_align=32
```

| 指标 | 有 440 Hz 低幅音源（`release-av-10s`） | 系统静音（`release-audio-silent-3s`，3 s） |
|---|---:|---:|
| loopback 帧数 | 480,960 | 144,960 |
| 设备时长（帧数/采样率） | 10.020 s | 3.020 s |
| 包数 / 其中 SILENT 包 | 1,002 / **0** | 302 / **302** |
| PCM 字节（s16，2 声道） | 1,923,840 | 579,840 |
| 期望字节（帧数×声道×2） | 1,923,840 | 579,840 |
| 字节一致性 | **1.0000** | **1.0000** |
| 最大幅度 / 非零采样数 | 5 / 800,120 | 0 / 0 |
| WAV 文件 | 1,923,884 B（44 B 头 + PCM） | — |
| `ffmpeg -i audio.wav` | `pcm_s16le, 48000 Hz, 2 channels, s16, 1536 kb/s`，Duration 10.02 s | — |

结论与语义边界：

- loopback 在“系统无音频播放”时**仍然产出包，但全部带 `AUDCLNT_BUFFERFLAGS_SILENT`**，
  帧数/字节数与墙钟一致；静音不是丢数据，必须按静音处理而不是丢弃（本原型填零并计数）。
- 有低幅音源时 `silent_packets=0`、非零采样 80 万，证明**非静音系统混音确实被采到**。
- 本机混音格式为 **8 声道**；原型只取前两声道（L/R），不满足 R5 的多声道/双音源要求；
  混音器（系统声 + 麦克风）、重采样、设备切换均未做。

### 4.6 A/V mux 与音画偏差（`release-av-10s`）

mux 命令（`mux.args` 原文）：

```text
-hide_banner -loglevel warning -y -i <out>/video.mp4 -ss 0.030937 -i <out>/audio.wav
-map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -movflags +faststart <out>/capture.mp4
```

（`-ss` = 采集侧测得的音频前导 `av.capture_audio_lead_s=0.0309 s`，只作用于第二个输入。）

产物（`probe-mux.txt`、`av-spans.txt`）：

```text
Duration: 00:00:10.03, start: 0.000000, bitrate: 1586 kb/s
Stream #0:0: Video: h264 (High), yuv420p, 1440x2560, 1384 kb/s, 30 fps, 30 tbr
Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, 192 kb/s
ffmpeg -v error -xerror -i capture.mp4 -f null -   → exit 0（全量解码通过，0.26 s）

video: packets=301  first=0.000000  end=10.033333
audio: packets=470  first=-0.021333 end=9.989000
start_offset_ms = -21.333
end_skew_ms     = -44.333
video_effective_fps = 30.000
```

| 指标 | 值 |
|---|---:|
| mux 产物大小 | 1,989,344 B |
| `ffmpeg -i` 容器时长 | 10.03 s |
| 采集侧音频前导（audio start → 首帧视频） | 30.9 ms |
| 流起点偏移（audio first_pts − video first_pts） | **−21.33 ms** |
| 扣除 AAC priming 后起点偏移 | **≈ 0 ms** |
| 流尾部偏差（audio end − video end） | **−44.33 ms** |
| 其中 AAC priming | 21.33 ms（1024 采样 @48 kHz） |
| 其中真实尾部差 | 约 23.0 ms（音频在采集结束点停止；视频按 301 帧扩张到 10.033 s） |
| 视频有效帧率（包数/跨度） | 30.000 fps |

解释：`-21.333 ms` 是 **AAC 编码器 1024 采样 priming** 写进首包的负 pts（mp4 edit list
会在播放时裁掉），不是真实音画不同步；扣除后起点对齐 ≈0。尾部 23 ms 是“音频停止点 /
视频时间轴长度”的口径差，R5 需要用统一媒体时钟做裁齐/补齐并冻结容差。
本原型已经能**测量**这两个量（`-debug_ts` + `-progress` 双口径），但没有实现 R5 的
时钟/暂停/裁齐策略。

### 4.7 管道背压（慢消费者，`release-backpressure-10s`）

命令：`--capture gdi --slow-consumer-ms 40`（写线程每帧人为延迟 40 ms，模拟慢盘；
30 fps 预算为 33.3 ms，因此必然落后）。

| 指标 | 值 | 解读 |
|---|---:|---|
| 原始送达帧数 | **35** | 采集主循环阻塞在 `send()`，GDI 采样节拍被拖慢 |
| 实际写入帧数 | 204（含复制帧） | 输出视频 204/30 = 6.80 s |
| 同槽丢弃 / 缺口复制 | 0 / 169 | 复制是时间轴补齐，不是真实帧 |
| 到达缺口次数 | 20 | 送达间隔 >1.5/fps |
| 背压事件 / 总阻塞 / 最大阻塞 | **192 次 / 9,230.83 ms / 54.48 ms** | 阻塞发生在采集线程的 `send()` |
| 送达间隔 mean / p50 / p95 / max | 278.69 / 174.92 / 568.56 / 570.46 ms | 节拍严重滑移 |
| 采集墙钟 / 输出时长 | 10.031 s / **6.800 s** | **视频比墙钟短 3.2 s** |
| 管道吞吐 / 解码 | 277.2 MiB/s / exit 0 | 编码本身没坏 |
| CPU（本进程 + ffmpeg / 墙钟） | 2.500 + 3.562 = 6.062 s / 10.590 s（57.2%） | 有界队列避免了无界内存增长 |

结论：有界队列 + 阻塞发送的行为是“**反压到采集端**”，不会无限吃内存；但本原型的
缺口补齐上限（10 帧/次）在长时间阻塞时会**截短时间轴**（6.80 s < 10.03 s）。
这正说明 R5 不能靠复制帧掩盖编码落后，必须冻结：
慢盘/编码过载时的丢帧/降帧率/暂停策略、队列上界与磁盘预算、以及“失败不登记成品”的语义
（计划 §7 R5-02/R5-05、§9.1 导出队列=1 running + 2 waiting）。

### 4.8 其他失败分支（原始错误逐字保留）

| 分支 | 命令（关键参数） | 退出码 | 原始错误/行为 |
|---|---|---:|---|
| WGC 严格模式（不回退） | `--capture wgc --seconds 2` | 2 | `WGC unavailable: IGraphicsCaptureItemInterop::CreateForMonitor(hmon=196748) failed: You do not have permission to capture the given monitor. (0x80070005)`（在启动 ffmpeg 前失败，无半成品） |
| WGC 失败回退 | `--capture auto` | 0 | 记录 `fallback_reason`（同上），实际后端 `gdi`，10 s 视频通过 |
| ffmpeg 不存在 | `--ffmpeg .tmp-r0-media-native/no-such-ffmpeg.exe` | 2 | `spawn ffmpeg failed: 系统找不到指定的文件。 (os error 2) (path=…): 系统找不到指定的文件。 (os error 2)` |
| 编码器不存在 | `--codec definitely_not_a_codec` | 2 | ffmpeg stderr：`Unknown encoder 'definitely_not_a_codec'` / `Error selecting an encoder` / `Error opening output files: Encoder not found`；Rust 写线程：`ffmpeg stdin write failed at frame 2: 管道正在被关闭。 (os error 232)`；`capture.send_errors=1`、`capture.stats_error=encoder channel closed (ffmpeg exited early?)`；ffmpeg `exit_code=Some(-1129203192)`（原样记录，未解释）；视频不存在 |
| 无效/不可用音频端点 | `--audio --audio-endpoint MMDEVAPI-invalid-endpoint-id` | 1（partial） | `IMMDeviceEnumerator::GetDevice(MMDEVAPI-invalid-endpoint-id) failed: 参数错误。 (0x80070057)`；视频继续并验证通过；`mux.skipped=no audio data or video encode failed` |
| 系统静音（非失败但易误判） | `--audio`（无系统声） | 0 | 302/302 包为 SILENT，字节数与期望一致；见 §4.5 |
| 管道背压 | `--slow-consumer-ms 40` | 0（视频可解码但短于墙钟） | 见 §4.7 |

**“无 loopback 设备”环境**：本机有默认渲染端点，无法真实制造“无设备”环境；上表用
“无效端点 ID”触发了同一条 `GetDevice` 错误传播路径并保留了原始 HRESULT。
`GetDefaultAudioEndpoint` 在无设备机器上的行为属 R5/真机矩阵，未验证。

**“无 WGC 环境”**：本机是**真实权限拒绝**（不是模拟），且 `auto` 回退与严格失败两条
路径都实测过。R0 未尝试通过打包/改系统策略来绕过——那属于 R5 的产品决策
（见 §5 与 §6）。

### 4.9 补充：4K 主屏 GDI@30 抽样（`release-gdi-4k3s`，3 s，`--no-animate`）

| 指标 | 值 |
|---|---:|
| 目标 | `--monitor 0`（主屏 3840×2160@150%，不创建可见窗口） |
| 送达 / 写入帧 | 87 / 90（期望 90） |
| 同槽丢弃 / 缺口复制 | 2 / 5 |
| 送达 fps / 采集墙钟 | 28.808 / 3.020 s |
| 帧间隔 p50 / p95 / max | 33.90 / 39.71 / 49.51 ms |
| 背压事件 / 最大阻塞 | 35 / 2.42 ms |
| 原始帧入管道 / 吞吐 | 2,985,984,000 B / 898.6 MiB/s |
| 视频 | 3840×2160、3.000 s、510,721 B、解码 exit 0 |
| CPU 合计 | **8.688 s**；按采集墙钟 3.020 s ≈**2.88 核**，按整段运行墙钟 3.430 s = **253.3%**（≈2.53 核，含探测/收尾/验证） |

3 s 抽样下 GDI 4K@30 已接近上限（28.8 fps，2 个同槽丢弃）；这是“GDI 整帧 CPU 拷贝”
路线的分辨率成本信号，但 3 s 太短、且主屏有并行任务，**不能作为 4K 结论**。

### 4.10 Debug 对照与性能口径（`debug-auto-10s`）

| 指标 | Debug | Release（`release-auto-10s`） |
|---|---:|---:|
| 送达 / 写入帧 | 301 / 301 | 301 / 301 |
| 帧间隔 p50 / p95 / max | 31.48 / 37.86 / 38.70 ms | 31.67 / 37.92 / 39.86 ms |
| 视频大小 / 时长 / 解码 | 1,756,637 B / 10.03 s / exit 0 | 1,742,387 B / 10.03 s / exit 0 |
| 本进程 CPU | 3.391 s（user 0.859 / kernel 2.531） | 5.359 s（3.047 / 2.312） |
| ffmpeg CPU | 7.891 s | 9.766 s |
| 合计 / 墙钟（≈单核） | 11.281 / 10.393 s（108.6%） | 15.125 / 10.426 s（145.1%） |
| 帧质量口径 | `sampled-1of16` | `full-frame` |

**Debug 数字不能当 Release 基线**（计划 §9.2、R0-07 规则）；本表只说明功能等价。
注意 Debug 本进程 CPU 反而更低，是因为 Release 做了全帧哈希/亮度（约 2 s CPU），
Debug 采样 1/16——**两者不是同一测量口径**，不能按“Debug 更省 CPU”解读。
即使 Release 数字也只属于本机、单次、非隔离环境（副屏有并行任务、电源方案未冻结），
**不是产品性能基线**。

## 5. 结论（建议，供 ADR-0001 汇总；不写“已冻结”）

1. **原生后端在原型层面可行（GDI 路径已闭环）**：10 s@30 fps 桌面采集 → 有界管道 →
   ffmpeg H.264 → 可解码 MP4；WASAPI loopback → WAV → A/V mux 全部跑通，
   帧数/丢帧/间隔/黑帧、音频字节/时长、A/V 偏差都有可复核数字。
2. **WGC 路径“代码完成、运行证据缺失”**：本机对未打包 Win32 进程拒绝创建 capture item
   （E_ACCESSDENIED），且这是**新 Windows 版本的 programmatic capture 同意/包身份问题**，
   不是 Rust 绑定或 D3D 集成问题。对 R5 的直接含义：
   - 若选 WGC，必须把“打包身份/能力声明/用户同意/采集指示”纳入设计与发行方案，
     并在目标 Windows build 上复验（近期已有 `CreateForMonitor` 版本回归报告）；
   - 不能假设“桌面应用静默调 WGC 即可”，这与 Electron/WebView2 现有“指定源 +
     loopback 无二次选择”的体验目标存在**产品语义冲突**，需要 ADR-0001 明确；
   - GDI 回退不是等价物：无光标、无系统采集指示、D3D/叠加层/受保护内容风险、
     整帧 CPU 拷贝（本机 4K@30 已接近上限）。
3. **成本量级（本机原型，非产品基线）**：1440×2560@30 的 GDI + 管道 + libx264 ≈
   1.2–1.5 核（Release 合计 CPU 秒/墙钟 120.6%–145.1%）；4K@30 3 s 抽样 ≈2.5–2.9 核（口径见 §4.9）且未满帧；
   原始帧管道吞吐 418 MiB/s（3.7 MP）到 899 MiB/s（8.3 MP）。这支持“原生后端可行”，
   但不足以回答“是否比 WebView2 路径更省”/“是否满足产品 §9.2”，需 R5 同条件对照。
4. **A/V 与背压是可工程化的问题**：本原型已能测出 AAC priming 与尾部偏差，
   也复现了慢消费者导致的时间轴缩短；R5 必须冻结统一时钟、暂停语义、丢帧/降载策略、
   慢盘/磁盘满失败路径，以及“失败不登记成品”。
5. **对 ADR-0001 的建议**：两路 spike 证据齐备前不选型；本路证据支持
   “原生后端（以 ffmpeg 为编码器）作为 **B 方案** 的可行性下限成立”，
   但 WGC 权限/包身份、GDI 等价性、真实长录与性能对照是 R5 前必须补齐的未验证前提。
   置信度：采集/编码/mux 链路=中高（本机实测）；WGC 可行性=低（本机无成功证据）。

## 6. 未解决限制

1. **WGC 无成功运行证据**：本机权限拒绝；未验证打包身份/同意 UI/target build 差异、
   `TryCreateFromDisplayId` 路径、WGC 的帧率/CPU/光标/D3D 叠加层行为。
2. **GDI 路径的等价性缺口**：无光标；D3D 全屏独占/硬件叠加层/受保护内容可能黑块或旧帧；
   无系统采集指示；整帧 CPU 拷贝在更高分辨率/帧率下的成本未测（4K@30 仅 3 s 抽样）。
3. **音频不完整**：只取混音格式前 2 声道（本机是 8 声道）；无麦克风、无双音源混音、
   无重采样/设备切换/热插拔；loopback 静音包语义已验证但“无 loopback 设备”环境未验证。
4. **实时性/长录未验证**：只有 3/10 s；无暂停/继续、无 30 分钟时钟样例、无真实慢盘/磁盘满、
   无编码队列/取消/重试、无崩溃恢复；背压策略未冻结。
5. **测量口径**：非隔离环境（副屏并行任务）、单次运行、电源方案未冻结、GPU 驱动/OS 版本
   未锁定；Release 全帧哈希 vs Debug 采样导致 CPU 口径不同。都不能当产品基线。
6. **窗口/多显示器矩阵**：只测副屏 1440×2560@125% 与主屏 4K@150% 的 3 s 抽样；
   未测 100%/200%、拔插/重排、窗口/区域采集、独占全屏、锁屏/RDP。
7. **编码器选择**：只用 libx264（软件）；`h264_nvenc`/`h264_amf`/Media Foundation 未测。
8. **工程边界**：原型只写 `.tmp-r0-media-native/`；产物不提交，文档哈希只对应当前本机文件，
   清理后不可复核（命令可复跑）。

## 7. 责任批次与退出验收

| 项 | 批次 | 退出验收 |
|---|---|---|
| WGC/包身份/同意模型选型 + 目标 build 复验（含 `TryCreateFromDisplayId` 备选） | R5-01 / ADR-0001 / R8 | 目标机（含 Win10 22H2、Win11 24H2+）上 WGC 采集 10 s@30 fps 成功，并记录同意 UI/采集指示行为；失败有明确产品降级路径 |
| GDI 回退的等价性/成本与产品降级语义 | R5-01/R5-02 | 光标、D3D/叠加层、受保护内容、4K@30/60、慢盘矩阵；GDI 与 WGC 差异逐项登记 |
| 统一时钟、暂停/继续、A/V 裁齐、容差冻结 | R5-02/R5-04/R5-07 | 30 分钟双音源样例；暂停 0 漂移；音画偏差在 R0 冻结阈值内（本原型只给出测量方法） |
| 背压/慢盘/磁盘满/设备丢失失败路径 | R5-02/R5-05 | 队列上界与磁盘预算；失败不登记成品；可解释暂停/失败；无无界内存 |
| 双音源混音、麦克风、设备切换 | R5-02/R5-07 | 系统声 + 麦克风可混音；设备变化不静默换目标 |
| 编码器选型（libx264/NVENC/AMF/MF）与 4K 性能对照 | R5-05/R5-07 | 同条件 30/60 fps、4K、30 分钟；CPU/GPU/内存/文件大小对照 |
| 原生 vs WebView2 两路同条件对照 | ADR-0001 / R5 | 计划 §9.2 口径的 p50/p95、CPU/GPU、内存、失败语义对照表 |

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 初版：R0-05b 原型、Release/Debug 验收矩阵、WGC 权限失败分支、WASAPI/A-V、背压与失败分支证据 | 本文档；`.tmp-r0-media-native/`；提交见分支 `codex/rust-r0-baseline-contracts` |

## 附录 A：证据文件与 sha256（`.tmp-r0-media-native/`，gitignore）

| 文件 | 大小 | sha256 |
|---|---:|---|
| `release-auto-10s/video.mp4` | 1,742,387 B | `18aa6c21e782eb5b5d135d5547a798f23d75c015619ac6f92299bc946d08256d` |
| `release-gdi-10s/video.mp4` | 1,742,851 B | `717a12ac08b88b66699ac85bd23bfd686fcde80874c4bd81e2095a2b01bf164f` |
| `release-av-10s/video.mp4` | 1,741,111 B | `30bf78caaf6a0201d5f6ef36022bfe176c14f6569bc473d5e02ba4ec4344207a` |
| `release-av-10s/audio.wav` | 1,923,884 B | `1da960da51f8d5148ad797d6b5c8c84eb33e85a7f173c0ac1547d74852ca4e66` |
| `release-av-10s/capture.mp4` | 1,989,344 B | `76dfcdb3275834d683c0108f9e27678c6b63db2514591add01657278ddec7d89` |
| `release-av-10s/av-spans.txt` | 140 B | `6c2e12b813632b2abe019ac5a934e76d15de58ab773767370f2288e05f950021` |
| `release-av-10s/summary.json` | 4,796 B | `4aaf9355653baadbb25dfb6df70d7a24ab19bee144f0f1d6cdcdedf38a6d75c4` |
| `release-backpressure-10s/video.mp4` | 1,159,664 B | `b4ad6e1026972a15bd5c814d7a375913dce9c15751b209d9134f4e54dc78090b` |
| `probe-wgc/run.log` | 2.1 KB | `6a3dd7261137a062f8b956fef1bfcb6945d4a01c8e59252a39a000b2fb03cbf7` |
| `smoke-gdi/frame.png`（首帧核对图） | 1,481,246 B | `ff563be19014b0311885a233093747a15d5a679b3e4b370a3ca8aa8b4643e6ee` |

每个运行目录还包含 `run.log`（完整日志）、`metrics.txt`/`summary.json`（指标）、
`probe-*.txt`（`ffmpeg -i` 原文）、`console.log`（stdout/stderr）。哈希对应 2026-11-10
最后一次 Release 验收运行。

## 附录 B：原型代码位置

| 文件 | 内容 |
|---|---|
| [`src/main.rs`](../../../rust-app/prototypes/native-capture/src/main.rs) | CLI、编排、指标落盘、Debug/Release 标注 |
| [`src/capture/mod.rs`](../../../rust-app/prototypes/native-capture/src/capture/mod.rs) | 显示器枚举（per-monitor v2）、后端解析、按时间轴重采样、统计 |
| [`src/capture/wgc.rs`](../../../rust-app/prototypes/native-capture/src/capture/wgc.rs) | WGC：D3D11 → WinRT device → `CreateForMonitor` → `CreateFreeThreaded` 帧池 → staging；探测/失败分支 |
| [`src/capture/gdi.rs`](../../../rust-app/prototypes/native-capture/src/capture/gdi.rs) | GDI：`CreateDIBSection`(top-down BGRA) + `BitBlt(SRCCOPY|CAPTUREBLT)` |
| [`src/ffmpeg.rs`](../../../rust-app/prototypes/native-capture/src/ffmpeg.rs) | 有界通道写线程 → ffmpeg stdin；stderr 排空；帧哈希/亮度；mux |
| [`src/wasapi.rs`](../../../rust-app/prototypes/native-capture/src/wasapi.rs) | WASAPI loopback → WAV（s16、混音格式探测、SILENT 包处理） |
| [`src/verify.rs`](../../../rust-app/prototypes/native-capture/src/verify.rs) | `ffmpeg -i` / `-xerror` / `-debug_ts` / `-progress` 证据解析 |
| [`src/anim.rs`](../../../rust-app/prototypes/native-capture/src/anim.rs) | 测试动画窗口（只出现在被采集显示器） |
| [`src/cpumon.rs`](../../../rust-app/prototypes/native-capture/src/cpumon.rs) | `GetProcessTimes`：本进程 + ffmpeg 子进程 CPU |
