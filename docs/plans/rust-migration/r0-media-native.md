# R0-05b 原生媒体采集最小闭环证据（ADR-0001 第二路）

- 状态：**R0 证据文档（草案）；ADR-0001 仍为“待验证”，G0 未通过前不构成架构冻结**
- 决定批次：R0-05（计划 §2 D05、§7 R0-05、§8 G0）；实施批次：R5
- 日期：2026-11-10（初版，原机 Ryzen 7 9850X3D）；**2026-11-11 扩展**（当前机 SHERUNLOCK02：
  暂停/继续、双音源、区域/窗口与源目标变化、30 分钟时钟样例、T4 媒体阈值候选）
- 关联计划：[Rust 改造计划](../2026-11-10-rust-migration-development-plan.md) §2 D05、§7 R0-05、§8 G0、§9.2；
  [R0 基线](r0-baseline.md) §4.1；[可行性调研](../../research/2026-11-10-rust-migration-feasibility.md) §6.2；
  [ADR 模板](adr/0000-template.md)、[ADR 索引](adr/README.md)
- 对应共享任务：`task-6`（R0-05b 原生采集最小闭环）、`task-1`（R0-05 长时媒体收尾）
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

### 0.1 2026-11-11 扩展结论（当前机 SHERUNLOCK02）

6. **暂停/继续成立（GDI 路径，12 s 样例，两次暂停：2 s + 1 s）**：媒体时长 12.012 s、
   墙钟 15.015 s、暂停 3.003 s；输出视频 360 帧 / 12.000 s / `timeline_missing_slots=0` /
   帧间隔中位 33.33 ms / 有效 30.000 fps（暂停在视频时间轴上**不产生空洞**）；
   音频在暂停期间丢弃 144,000 帧 = 3.000 s×48 kHz，WAV 时长 12.030 s；
   mux 后 `start_offset_ms=-21.33`（AAC priming，扣除后≈0）、`end_skew_ms=-34.0`，
   同条件无暂停基线为 `-49.3`（见 §4.11）。
7. **双音源采集/混音成立，但双路对齐测量在本机不成立**：本机 ACTIVE 端点 = 2 render
   （网易虚拟音频设备、Realtek 扬声器）+ 2 capture（网易虚拟麦克风、Intel 数字麦克风阵列）；
   loopback(Realtek 扬声器) 8.16 s 与 Intel 麦克风阵列 8.05 s 同时采集、混音
   `audio-mix.wav` 1,545,644 B 可解码；但麦克风未拾到本机渲染的测试音
   （互相关峰值 **0.011**，有效延迟不可测），虚拟麦克风端点全零 → 登记环境限制，
   不写成“对齐通过”（见 §4.12）。
8. **区域/窗口采集与源目标变化**：区域 640×360@30 实际 30.1 fps、0 丢帧；
   窗口三方法在**隐藏窗口**下 `printwindow`/`window-dc` 全黑（196/196 帧）、
   `screen` 采到桌面背景；同一场景改为**可见窗口**后 `printwindow`/`window-dc`
   只有 1/262 帧全黑并可采到窗口内容；场景内移动（moves=1）、关闭（invalid_events）、
   按标题重解析到新窗口（retargets=1）均有事件记录；目标丢失约 1 s 期间受
   `max_fill=10` 限制，输出视频（9.07 s）短于采集媒体时长（9.5 s）——这是需要 R5
   冻结的“源丢失期间时间轴语义”（见 §4.13）。上述窗口行为已在 **Medium IL**
   （ACL 修复后）逐项复现（§4.13.1）→ 不是 Low IL 造成，作为本原型/本机行为成立；
   逐帧内容对照、真实应用窗口矩阵仍属 R5。
9. **GDI 成本与分辨率强相关（本机）**：2240×1400 全屏 GDI 唯一内容仅约 21–25 fps
   （CAPTUREBLT 开/关无显著差异），输出按 30 fps 均匀补齐；640×360 区域可达 30.1 fps。
   30 分钟样例（§4.14）据此以“输出时间轴 30 fps + 采集侧丢帧/复制帧”口径记录，
   不能把输出帧数当作唯一内容帧数。
10. **30 分钟时钟样例（当前机 Release GDI，`--seconds 1800 --fps 30 --capture gdi
   --no-animate --audio --tone`）成立**：输出 **54,000 帧 / 1800.000 s / 逐包时间轴
   缺槽 0 / 有效 29.9999 fps**，视频 107,388,915 B、全量解码 exit 0；采集侧送达
   45,597 帧（25.33 fps）、复制补齐 8,501 帧（15.7%）；音频 86,400,960 帧 =
   1800.020 s，WAV 345,603,884 B；mux 后 1800.000 s、151,927,189 B、全量解码 exit 0；
   A/V `start_offset=-21.33 ms`（AAC priming，扣除后≈0）、`end_skew=-32.67 ms/30 min`
   与短样例同量级（无累积漂移证据）；进程树峰值 Private Bytes 1,219.6 MB / CPU
   ≈2.28 核（2 s 峰值）。**注意：该样例运行在 Low IL 环境（§4.15），作为
   “Low IL 环境下”对照保留**；Medium IL 10 分钟样例见 §4.14.5（用于确认 IL 对时钟/丢帧/
   A-V/峰值无影响）。
11. **WGC 在本机可用（2026-11-11 更正，Medium IL 复验）**：旧登记 `E_ACCESSDENIED` 由
   工作区 ACL 的 Low IL 环境造成，**不是 Windows/未打包应用限制**。ACL 修复后：
   `CreateForMonitor(#0)` OK（2240×1400）、`CreateForWindow(前台窗口)` OK（1557×1314）；
   修复原型 WGC 帧读取 bug（`IDirect3DSurface → ID3D11Texture2D` 需经
   `IDirect3DDxgiInterfaceAccess`）后，**WGC 10 s@30 fps 采集成功**：送达 590 帧
   （56.77 fps）、写入 300 帧、复制补齐 0、视频 300 帧/10.000 s/1,055,818 B、全量解码
   exit 0、时间轴缺槽 0；`--capture auto` 已选 WGC 且无回退。打包身份/同意 UI/采集指示、
   Win10/其它 build、多显示器/HDR/4K/60/长时 WGC 仍未验证（§4.1）。

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

**初版本路不在范围**（原计划 R5）：区域/窗口/多显示器组合、双音源混音、麦克风、暂停/继续、
30 分钟长录、设备热插拔、编码队列/取消、项目契约、产品宿主/WebView 集成、
打包（MSIX）身份下的 WGC 权限。**2026-11-11 扩展已补做**区域/窗口/源目标变化、双音源
（采集+混音，对齐测量受本机声学路径限制）、暂停/继续、30 分钟时钟样例与 T4 候选；
设备热插拔、编码队列/取消、产品集成仍属 R5，不在本文件证据内。

## 2. 备选方案（本路只实测 B1/B2，B3 未测）

| 方案 | 描述 | 本路证据 | 代价/风险 |
|---|---|---|---|
| A. WebView2 采集 + Canvas/MediaRecorder | 保留现有前端路径，宿主提供“指定源 + loopback”等价绑定 | 不在本路（并行 R0-05 另一路） | 选源/loopback/时钟等价性未证明（可行性 §6.2） |
| **B1. WGC + FFmpeg 管道** | D3D11 帧池 → staging 读回 → 有界通道 → `ffmpeg -f rawvideo` | **2026-11-11 Medium IL 成功**（10 s@30 fps，2240×1400，可解码；旧 `E_ACCESSDENIED` 为 Low IL 环境造成）；打包身份/同意/真机矩阵待 R5 | 需验证 programmatic capture 同意/包身份/目标 build；高分辨率读回与拷贝成本 |
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

#### 3.1.1 2026-11-11 扩展运行环境（当前机）

| 项 | 值 |
|---|---|
| 主机 / OS | `SHERUNLOCK02`；Windows 11 家庭版 26300.9974（26H2） |
| CPU / 内存 | Intel i5-13500H 12C/16T / 15.75 GiB |
| GPU / 显示 | Intel Iris Xe（无独显）；**单屏** 2240×1400@150%，无副屏 |
| 电源方案 | 10 s 级测试：平衡；**30 分钟样例：脚本切“高性能”并在结束后恢复**（§4.14） |
| 音频端点 | 2 render ACTIVE（网易虚拟音频设备=默认、Realtek(R) Audio 扬声器）+ 2 capture ACTIVE（网易虚拟麦克风=默认、Intel 数字麦克风阵列）；见 §4.12 |
| 采集目标 | 显示器 0（主屏，允许；可见测试窗口经用户授权后在主屏短暂出现） |
| 可见窗口许可 | 用户已授权可见测试窗口与不限时长屏幕采集（2026-11-11 17:20 前后） |
| 并行负载 | 同机另一 teammate 在跑 PDF 验证（短时 CPU 峰值）；长测期间记录该事实，不据此放弃采样 |
| **进程完整性级别** | 2026-11-11 17:59 发现工作区 ACL 带 `Low Mandatory Label` 继承 → 原型 exe/ffmpeg 以 **Low IL(0x1000)** 运行；**19:40 已修复**（61,767 文件 Low→Medium），复验运行时日志 `[env] process integrity level = Medium(0x2000)`；Low IL 时期证据保留作对照，详见 §4.15 |

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

### 3.2.1 2026-11-11 扩展命令（当前机，Release，仓库根目录）

```powershell
$exe = 'rust-app\prototypes\native-capture\target\release\native-capture.exe'

# 0) 端点枚举（render + capture，含默认端点/混音格式）→ audio-endpoints.txt
& $exe --list-audio --out .tmp-r0-media-native/list-audio

# 1) 同条件基线：8 s 全屏 GDI + loopback(默认虚拟端点) + 低幅测试音（A/V 偏移基线）
& $exe --seconds 8 --fps 30 --capture gdi --monitor 0 --no-animate `
  --audio --tone --tone-amp 0.002 --out .tmp-r0-media-native\tone-loopback-8s-b

# 2) 暂停/继续（媒体 12 s；3 s 处暂停 2 s、7 s 处暂停 1 s；两次均恢复）
& $exe --seconds 12 --fps 30 --capture gdi --monitor 0 --no-animate `
  --audio --tone --tone-amp 0.002 --pause-at 3,7 --pause-ms 2000,1000 `
  --out .tmp-r0-media-native\pause-short-12s

# 3) 区域采集（640×360，验证尺寸/帧率/时间轴）
& $exe --seconds 5 --fps 30 --capture gdi --region 300,200,640,360 --no-animate `
  --out .tmp-r0-media-native\region-640x360-5s

# 4) CAPTUREBLT 开关对照（全屏，排除“抓分层窗口”是否为瓶颈）
& $exe --seconds 5 --fps 30 --capture gdi --monitor 0 --no-animate `
  --out .tmp-r0-media-native\captureblt-with-5s
& $exe --seconds 5 --fps 30 --capture gdi --monitor 0 --no-animate --no-captureblt `
  --out .tmp-r0-media-native\captureblt-without-5s

# 5) 双音源：loopback(Realtek 扬声器) + Intel 麦克风阵列；混音 + 双路落盘
#    （端点 ID 取自 --list-audio；Intel 麦克风在电池/受限会话下可能不可用，错误原样保留）
& $exe --seconds 8 --fps 30 --capture gdi --monitor 0 --no-animate `
  --audio --audio-endpoint '{0.0.0.00000000}.{cbfd81be-a396-4501-8745-ea51308a6622}' `
  --audio2 '{0.0.1.00000000}.{cdb05f84-8122-4b4f-a565-de8cde85e052}' `
  --audio-mix --tone --tone-endpoint '{0.0.0.00000000}.{cbfd81be-a396-4501-8745-ea51308a6622}' `
  --tone-amp 0.03 --out .tmp-r0-media-native\dual-audio-8s

# 6) 窗口目标变化场景（隐藏窗口 / 可见窗口）
& $exe --scenario window-target --out .tmp-r0-media-native\scenario-hidden
& $exe --scenario window-target --scenario-visible --out .tmp-r0-media-native\scenario-visible

# 7) 30 分钟时钟样例（脚本切高性能、采样进程树峰值、结束后恢复平衡）
pwsh -NoProfile -File rust-app\prototypes\native-capture\run-long-sample.ps1 `
  -OutDir .tmp-r0-media-native\long-30min -Seconds 1800 -SampleIntervalMs 2000

# 8) WGC 探测 + 10 s@30 fps 采集（Medium IL；--animate 需可见窗口许可）
& $exe --probe-wgc --animate --monitor 0 --out .tmp-r0-media-native\probe-wgc-medium
& $exe --seconds 10 --fps 30 --capture wgc --monitor 0 --animate `
  --out .tmp-r0-media-native\wgc-10s-medium

# 9) Medium IL 10 分钟对照样例（ACL 修复后；同 §7 脚本，仅改时长/目录）
pwsh -NoProfile -File rust-app\prototypes\native-capture\run-long-sample.ps1 `
  -OutDir .tmp-r0-media-native\long-10min-medium-r2 -Seconds 600 -SampleIntervalMs 2000
```

初版（2026-11-10）非静音音频样本的准备与播放（工作目录 = 仓库根；扩展版已内建
`--tone` 合成测试音，不再依赖外部播放器）：```bash
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

### 4.1 WGC 可用性（2026-11-11 更正：Low IL 环境修复后成立）

> **结论更正（重要）**：2026-11-10/11 早段登记的 `E_ACCESSDENIED (0x80070005)` 由
> **工作区 ACL 导致的 Low IL 运行环境**造成（§4.15），**不是** Windows 对未打包应用的拒绝。
> 2026-11-11 19:40 ACL 修复（Low→Medium）后，本机 Medium IL 下 WGC **可创建 capture item
> 并可实际采集 10 s@30 fps**；同时修复了原型自身一个 WGC 帧读取 bug（见下）。
> 之前“WGC 本机不可用/真实失败分支”的结论作废，保留为历史观测。

#### 4.1.1 Medium IL 探测矩阵（2026-11-11 19:45，Release）

命令：`native-capture.exe --probe-wgc --animate --monitor 0 --out .tmp-r0-media-native/probe-wgc-medium`
（先创建可见动画窗口再探测；用户已授权可见窗口）。原始日志：
`.tmp-r0-media-native/probe-wgc-medium/run.log`（sha256 `ce4580a8…88b905`）。
进程 IL 自证：`[env] process integrity level = Medium(0x2000)`。

| 探测 | 结果 | 细节 |
|---|---|---|
| `RoGetActivationFactory("Windows.Graphics.Capture.GraphicsCaptureItem")` | **成功** | `[probe] WGC activation factory OK` |
| `CreateForMonitor(#0 \\.\DISPLAY1, hmon=65537)` | **成功** | size=2240×1400（与显示器 rect 一致） |
| `CreateForWindow(前台窗口 HWND(0x1f08ea))` | **成功** | display_name=`"R0-04 selection matrix - Google Chrome"`，size=1557×1314 |
| `SetIsCursorCaptureEnabled(true)` / `SetIsBorderRequired(false)` | **成功**（无失败日志） | 原型保留失败降级日志；本机两项均未报错 |

#### 4.1.2 WGC 10 s@30 fps 采集（`wgc-10s-medium`，2240×1400）

首次运行暴露**原型自身 bug**：item 创建成功，但帧处理 `frame.Surface() → ID3D11Texture2D`
直接 QI 返回 `不支持此接口 (0x80004002 E_NOINTERFACE)`。修复：按 WinRT 规范经
`IDirect3DDxgiInterfaceAccess::GetInterface::<ID3D11Texture2D>()` 取底层纹理
（`src/capture/wgc.rs`），之后采集成功。

命令：`native-capture.exe --seconds 10 --fps 30 --capture wgc --monitor 0 --animate
--out .tmp-r0-media-native/wgc-10s-medium`

| 指标 | 值 | 说明 |
|---|---:|---|
| 后端解析/实际 | `Wgc` / **wgc** | `--capture wgc` 严格模式，无回退 |
| 采集尺寸 / staging 格式 | 2240×1400 / `DXGI_FORMAT(87)`=B8G8R8A8_UNORM | BGRA 直通 ffmpeg |
| 送达帧数 / 送达 fps | **590 / 56.772** | WGC 按桌面变化出帧，高于目标 30 fps |
| 写入帧数 / 同槽丢弃 / 复制补齐 / 到达缺口 | **300 / 290 / 0 / 0** | 输出 30 fps 时间轴，无复制帧 |
| 帧间隔 mean / p50 / p95 / max | 16.91 / 16.65 / 18.82 / 35.59 ms | 到达节拍稳定 |
| 背压事件 / 最大阻塞 | 32 / 3.x ms | 有界队列 |
| 视频 | 300 帧 / **10.000 s** / 1,055,818 B / h264 High 2240×1400@30 | 全量解码 **exit 0**（0.436 s） |
| 帧质量（Release 全帧） | 唯一哈希 **300/300**、重复 0、全黑 0、luma mean 226.07 | 动画窗口产生真实变化 |
| 逐包时间轴 | packets=300、span=9.967 s、**missing_slots=0**、有效 **30.0000 fps** | B 帧重排 145（非空洞） |
| CPU（本进程+ffmpeg / 墙钟） | 161.6% 单核（含 Release 全帧哈希） | 与 GDI 不同条件，仅量级参考 |

`auto` 模式复测（`auto-wgc-5s-medium`）：`capture.backend=Wgc`、**无 fallback**，
5 s 内送达 274 帧 / 写入 150 帧 / 复制补齐 1 帧、视频解码 exit 0 → auto 现已正确选择 WGC。

#### 4.1.3 历史观测（Low IL，2026-11-10～11-11 早段；保留原始 HRESULT）

以下失败均发生在 **Low IL** 环境（§4.15），现已被 ACL 修复后的 Medium IL 结果推翻，
保留用于解释环境缺陷的影响，**不得再作为 WGC 的机器能力结论**：

| 探测 | Low IL 结果 | 原始错误 |
|---|---|---|
| `CreateForMonitor(#0/#1)` | 失败 | `You do not have permission to capture the given monitor. (0x80070005)` |
| `CreateForWindow(前台窗口)` | 失败 | `You do not have permission to capture the given window. (0x80070005)` |
| 先创建可见窗口再探测 / 写 per-app `graphicsCaptureProgrammatic Allow` 后复测 | 失败 | 同上（`probe-wgc3`/`probe-wgc2`） |
| 系统侧只读证据 | 全局 `graphicsCaptureProgrammatic=Allow`，打包应用为 `Prompt` | 未打包 exe 在 Low IL 下仍被拒 |

#### 4.1.4 判断与边界（更正后）

- **WGC 在本机（Win11 26H2 / Medium IL / 交互式会话 1 / 未打包 exe）可用**：创建 item、
  10 s 采集、可播放 MP4 均成立；`E_ACCESSDENIED` 归因于 Low IL 环境缺陷。
- **仍需验证（不得写成通过）**：打包身份（MSIX + `uap11:Capability Name="graphicsCaptureProgrammatic"`）
  下的同意 UI/采集指示/首次运行行为；Win10 22H2 与其它 Win11 build（含 26100.7623 起的
  `CreateForMonitor` 版本回归报告，备选 `TryCreateFromDisplayId`）；多显示器/窗口采集 WGC；
  HDR/4K/60 fps/高动态内容；受保护内容/独占全屏；长时（30 分钟）WGC 稳定性与资源峰值；
  WGC 与 GDI 的同条件性能对照（本机 10 s 数据仅量级参考）。
- 外部资料（版本/权限面，R5 需锁最低 build 复验）：
  [Microsoft Q&A 26100.7623 CreateForMonitor](https://learn.microsoft.com/en-us/answers/questions/5772548/igraphicscaptureiteminterop-createformonitor-fails)、
  [uap11:Capability](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap11-capability)、
  [Privacy Policy CSP](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-privacy)。

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

### 4.11 暂停/继续（`pause-short-12s`，当前机 Release GDI）

命令见 §3.2.1 第 2 条；媒体时长 12 s，计划在媒体时间 3.0 s 暂停 2000 ms、7.0 s 暂停 1000 ms。
实现语义：暂停期间视频不采帧、音频取包后丢弃，媒体时间轴扣除暂停时长（`pause.rs`）。

视频/采集（`metrics.txt`、`pause-windows.txt`、`video-timeline.txt`）：

| 指标 | 值 | 说明 |
|---|---:|---|
| 采集墙钟 / 媒体时长 / 暂停总时长 | 15.027 / 12.024 / **3.003** s | 墙钟 = 媒体 + 暂停 |
| 输出视频 | **360 帧 / 12.000 s** | 期望 12×30=360 |
| 时间轴缺槽 `timeline_missing_slots` | **0** | 暂停未在视频时间轴留空洞 |
| 帧间隔中位 / 有效 fps | 33.33 ms / **29.9999** | 排序后检查（B 帧重排 174 步，非空洞） |
| 送达 / 写入 / 复制补齐 | 279 / 360 / 81 帧 | 全屏 GDI 本机只能 ~19 fps 送达，按 30 fps 槽位补齐 |
| 到达间隔 p50 / p95 / max | 46.35 / 53.09 / 2079.78 ms | max ≈ 暂停 2 s（暂停期间无到达） |
| 背压事件 / 总阻塞 | 2 次 / 3.49 ms | 有界队列未成为瓶颈 |
| 恢复槽位差（第 1/2 次暂停） | **2 / 3** | 每次暂停边界约 1 帧会被复制补齐（见下） |

音频（loopback 默认虚拟端点 + `--tone` 持续低幅测试音）：

| 指标 | 值 | 说明 |
|---|---:|---|
| 保留帧 / 时长 | 577,440 / **12.030 s** | 与媒体时长一致 |
| **暂停期间丢弃帧** | **144,000** | = 3.000 s×48 kHz，暂停未进入音频时间轴 |
| 观察到的暂停窗口数 | 2 | 音频侧 |
| 音频墙钟 / 末包偏移 / 最大包间隔 | 15.037 s / 15.030 s / 16.42 ms | loopback 全程未断流 |
| mux 起点偏移 / 尾部偏差 | **−21.33 / −27.03 ms** | 起点= AAC 1024 采样 priming，扣除后≈0 |
| 同条件无暂停基线（8 s） | −21.33 / −49.33 ms | 尾部差来自音频停止点/AAC 帧尾语义 |

`pause-windows.txt` 原文（`pause-short-12s-c`）：

```text
index scheduled_media_s start_wall_s planned_ms actual_ms media_start_s media_end_s last_slot_before first_slot_after resume_slot_delta
0     3.000             3.002        2000       2000.73   3.002         3.002         90               92               2
1     7.000             9.029        1000       1001.49   7.027         7.027         210              213              3
paused_total_s=3.003
```

解读与边界：

- 视频时间轴连续性由**排序后的逐包 pts**验证（`missing_slots=0`、中位间隔 33.33 ms）；
  暂停时长没有出现在输出时长里（12.000 s 而不是 15 s）。
- 恢复槽位差 2/3（预期 1）：暂停恢复后第一次抓帧已跨过 1～2 个 1/fps 槽位，`FramePusher`
  用上一帧补齐，因此**每暂停边界最多 1 帧是复制帧**（81 帧复制中其余来自全屏 GDI 送达不足）。
  R5 需要冻结“暂停恢复帧相位”策略（立即插帧/重新对齐/标记 freeze），R0 只记录现象。
- 音频暂停由 5 ms 轮询门控，暂停边界样点归属误差 ≤ 一轮询周期（本样例丢弃帧数恰好
  = 3.000 s，说明边界误差 < 1 个 10 ms 包）；mux 后无暂停导致的时间轴漂移
  （end_skew −27～−34 ms 与无暂停基线同量级）。
- 一次重复运行（`pause-short-12s-d`，系统同时有其它音频）得到相同视频结论
  （360 帧/12.000 s/缺槽 0），音频丢弃帧同为 144,000，说明结论可复现。

### 4.12 双音源端点枚举、采集与对齐（`--list-audio`、`dual-audio-*`）

本机 WASAPI ACTIVE 端点（`audio-endpoints.txt`）：

| 方向 | 名称 | 默认 | 混音格式 |
|---|---|---|---|
| render | 扬声器 (网易虚拟音频设备) | console+communications | float32 2ch 48 kHz |
| render | 扬声器 (Realtek(R) Audio) | — | float32 2ch 48 kHz |
| capture | 麦克风阵列 (网易虚拟音频设备) | console+communications | float32 2ch 48 kHz |
| capture | 麦克风阵列 (适用于数字麦克风的英特尔® 智音技术) | — | float32 2ch 48 kHz |

**关键事实**：默认输出是**虚拟设备**（无活跃渲染流时 loopback 0 包）；默认采集也是
**虚拟麦克风**。因此 A/V/长时证据必须用 `--tone` 向 loopback 端点渲染测试音；
第二音源测试显式选择 Intel 数字麦克风阵列，避免默认虚拟麦克风全零掩盖问题。

双路同时采集 + 混音（`dual-audio-8s`：loopback=Realtek 扬声器 + `--tone`，第二路=Intel 麦克风）：

| 指标 | loopback | 第二音源（Intel 麦克风阵列） |
|---|---:|---:|
| 设备是否同一路 | 扬声器 (Realtek(R) Audio) | 麦克风阵列 (Intel 智音技术) |
| 保留帧 / 时长 | 391,680 / 8.160 s | 386,400 / 8.050 s |
| 非零采样 / 峰值 | 783,213 / 5,281 | 659,634 / 2,750 |
| SILENT 包 | 0 | 0 |
| 最大包间隔 / 首包偏移 | 13.44 ms / 0.011 s | — |
| 混音产物 | `audio-mix.wav` 1,545,644 B，clipped=0，peak=5,281 | |
| mux | `capture.mp4` 961,279 B / 8.03 s / AAC 192k / 全量解码 exit 0 | |

对齐测量：`sync.rs` 把两路降混/降采样（48k→8k）后做 ±500 ms 归一化互相关。
本机结果（8 s 与 6 s、放大测试音到 0.5 各一次）：

| 运行 | 第二路 | 互相关峰值 | 结论 |
|---|---|---:|---|
| `dual-audio-8s`（tone amp 0.03） | Intel 麦克风阵列 | **0.011** | 无共享声学信号，lag 不可解释 |
| `dual-audio-loud-intelmic`（tone amp 0.50） | Intel 麦克风阵列 | **0.006** | 提高测试音幅度后无明显变化（麦克风峰值 2,954 不随测试音变化） |
| `dual-audio-netmic`（tone amp 0.05） | 网易虚拟麦克风 | —（全零，`max_amplitude=0`） | 第二路无信号，相关不可计算 |

判断与边界：

- **双音源采集、双路 WAV 落盘、饱和相加混音、mux 在本机成立**（两路内容独立、非静音，
  混音无削波）。这与“R5 需要系统声+麦克风可混音”的能力下限一致。
- **本机无法验证两路时间对齐**：Realtek 扬声器播放的测试音没有被 Intel 麦克风阵列拾到
  （可能被静音/耳机路由/麦克风降噪或隐私策略影响），因此互相关无峰。属**环境限制**，
  不是采集链路失败；不写成“对齐通过”。R5/真机矩阵需在有可用扬声器+麦克风的机器上复测。
- 默认虚拟麦克风端点全零、默认虚拟扬声器端点无流时 0 包：设备选择和“端点是否真的在
  工作”必须是 R5 的预检项，不能只看端点存在。

### 4.13 区域/窗口采集与源目标变化（`region-*`、`scenario-*`）

> **2026-11-11 19:47 Medium IL 复验完成**：ACL 修复后重跑 hidden/visible × 三种方法及区域采集，
> 结果与 Low IL 时期**逐项一致**（见 §4.13.1）→ Low IL **不是**隐藏窗口全黑/grab_errors 的原因；
> 本节结论（作为本原型/本机行为）成立。逐帧内容对照、真实应用窗口矩阵仍属 R5。
> 修复前 Low IL 结果保留在 §4.13.1 对照表左侧，作为环境对照。

区域采集（`region-640x360-5s`，`--region 300,200,640,360`）：

| 指标 | 值 |
|---|---:|
| 输出尺寸 / 时长 | 640×360 / 5.030 s |
| 送达 / 写入 / 复制补齐 | 151 / 151 / 1 |
| 送达 fps / 帧间隔 p50 / p95 | **30.136** / 33.34 / 35.20 ms |
| 时间轴缺槽 / 有效 fps | 0 / 30.000 |
| 视频大小 / 全量解码 | 35,599 B / exit 0 |
| 本进程+ffmpeg CPU / 墙钟 | 0.859 s / 5.2 s（≈16.4% 单核） |

全屏 2240×1400 对照（`captureblt-with-5s` / `captureblt-without-5s`）：送达仅
24.7 / 23.3 fps，p50 35.6 / 47.0 ms；CAPTUREBLT 开关几乎没有差别 → 瓶颈是整屏读回，
不是分层窗口抓取。**结论：GDI 成本随像素数近似线性，区域采集可满足 30 fps，全屏 3.1 MP
在本机达不到 30 fps 唯一内容**（输出时间轴仍 30 fps，靠复制帧补齐）。

窗口目标变化场景（`--scenario window-target`，同一进程自建测试窗口，时间线：
2.0 s 移动、3.2 s 遮挡（仅可见模式）、5.8 s 关闭 A、6.6 s 出现 B 并按标题重解析，9.5 s 结束）：

| 运行/方法 | 可见 | 输出帧 | 全黑帧 | 移动事件 | 失效事件 | 重解析 | 说明 |
|---|---|---:|---:|---:|---:|---:|---|
| `scenario-hidden3` / printwindow | 隐藏 | 206 | **196/196** | 1 | 31 | 1 | 隐藏窗口 PrintWindow 返回成功但全黑 |
| `scenario-hidden3` / window-dc | 隐藏 | 206 | **196/196** | 1 | 31 | 1 | 隐藏窗口 GetWindowDC 全黑 |
| `scenario-hidden3` / screen | 隐藏 | 206 | 0 | 1 | 31 | 1 | 采到桌面背景（不是窗口内容） |
| `scenario-visible` / printwindow | 可见 | 272 | **1/262** | 1 | 25 | 1 | 可见窗口可采内容；遮挡期间仍可采到目标窗口 |
| `scenario-visible` / window-dc | 可见 | 272 | **1/262** | 1 | 25 | 1 | 同上 |
| `scenario-visible` / screen | 可见 | 272 | 0 | 1 | 25 | 1 | 屏幕路径会被遮挡物覆盖（见边界） |

事件时间线示例（`scenario-visible/printwindow/window-events.txt`）：

```text
0.001  visible=true
2.001  rect-changed (120,120..760,480) -> (340,240..980,600)
5.801  visible=false
5.834  target-invalid
...
（约 6.6 s 出现同名目标窗口 B 后）
        target-retargeted
```

行为与边界（必须带回 R5）：

1. **三种方法的隐藏/可见差异是真实的**：隐藏窗口无法用 PrintWindow/GetWindowDC 采到内容
   （本机全黑），屏幕路径只能采到背景；产品必须禁止“采集不可见窗口”的目标选择，
   或明确降级语义。
2. **移动**：每帧重读窗口矩形（DWM 扩展边框），因此 `screen` 方法也能跟随移动；
   `printwindow`/`window-dc` 用窗口句柄，移动不影响内容。
3. **关闭/失效**：原型对所有方法都显式 `IsWindow` 检查并记 `target-invalid`，
   因此 `screen` 方法也不会“安静地继续采桌面”；但原型自己加了检查，不等于系统行为。
4. **切换到另一窗口**：`--window-follow` 按标题重解析成功（retargets=1），事件记录可见；
   未实现“多个同名窗口的选择策略/前台切换跟随”，属 R5。
5. **遮挡**：可见模式下 `printwindow`/`window-dc` 在覆盖窗口存在期间仍采到目标窗口内容
   （全黑帧仅 1/262），`screen` 采到覆盖物；R0 只做到“帧统计+事件”级证据，
   **未做逐帧图像对照**（不做内容审查），逐帧内容等价性属 R5。
6. **目标丢失期间的时间轴**：A 关闭到 B 重解析之间约 0.8–1.0 s，无帧可采；
   `FramePusher` 单次最多补 10 帧（`max_fill`），因此输出视频（9.07 s）短于采集媒体时长
   （9.5 s，差约 0.43 s），且时间轴缺槽检查在补齐后仍为 0。R5 必须冻结
   “源丢失期间”的时间轴语义（暂停/黑帧/标记断点/失败重试），不能靠 max_fill 掩盖。

#### 4.13.1 Medium IL 复验（2026-11-11 19:46–19:48，Release；对比 Low IL）

命令：`--scenario window-target [--scenario-visible] --out <dir>`；区域：
`--seconds 5 --fps 30 --capture gdi --region 300,200,640,360 --no-animate`。
所有运行 `run.log` 均含 `[env] process integrity level = Medium(0x2000)`。

| 场景 / 指标 | Low IL（修复前） | **Medium IL（修复后）** | 判定 |
|---|---|---|---|
| 区域 640×360 送达 fps / 复制补齐 / 缺槽 | 30.136 / 1 / 0 | **30.063 / 0 / 0** | 一致（IL 无影响） |
| hidden：printwindow 全黑帧 | 196/196 | **196/196** | 一致 → **隐藏窗口全黑不是 IL 问题** |
| hidden：window-dc 全黑帧 | 196/196 | **196/196** | 同上 |
| hidden：screen 全黑帧（桌面背景） | 0 | **0** | 一致 |
| visible：printwindow 全黑帧 | 1/262 | **1/262** | 一致 |
| visible：window-dc 全黑帧 | 1/262 | **1/262** | 一致 |
| visible：screen 全黑帧 | 0 | **0** | 一致 |
| 移动 / 失效 / 重解析事件 | moves=1 / invalid=25–31 / retargets=1 | **moves=1 / invalid=25–31 / retargets=1** | 一致 |
| 目标丢失期输出缩短（media − video） | 0.63 s（hidden）/ 0.43–0.45 s（visible） | **0.632–0.645 s / 0.434–0.450 s** | 一致 |
| 视频时间轴缺槽 / 有效 fps | 0 / 30.000 | **0 / 30.000** | 一致 |

结论：窗口三方法的行为差异（隐藏窗口 PrintWindow/GetWindowDC 全黑、屏幕路径只能采背景；
可见窗口可采内容；遮挡下 screen 与 printwindow/window-dc 结果不同）在 Medium IL 下**复现**，
属本原型/本机真实行为，不是 Low IL 造成。R5 仍需：逐帧内容对照、真实应用窗口
（浏览器/Office/独占全屏）、多显示器/DPI、目标丢失期语义冻结。

### 4.14 30 分钟时钟样例与 T4 媒体阈值候选（`long-30min`，当前机 Release GDI）

> **环境**：本样例运行在 **Low IL** 环境（§4.15），且同机另一 teammate 有 PDF 验证负载
> （采样期间系统有短时 CPU 峰值）。作为“Low IL 环境下”的对照数据保留；WGC/窗口结论不适用。
> 采集 exe sha256 `4596629ae02c201845ac3364ac17be348421893e90234d6896f6a10b1928de88`
> （该构建尚未包含 `[env] process integrity level` 日志；进程 IL 由外部查询确认 Low，
> 见 `.tmp-r0-media-native/env-integrity/integrity-levels.txt`）。

命令（`run-long-sample.ps1` 启动；电源方案 before/after 已记录，采样间隔 2 s）：

```powershell
pwsh -NoProfile -File rust-app/prototypes/native-capture/run-long-sample.ps1 `
  -OutDir .tmp-r0-media-native/long-30min -Seconds 1800 -SampleIntervalMs 2000
# 实际 exe 参数：--seconds 1800 --fps 30 --capture gdi --monitor 0 --no-animate
#              --audio --tone --tone-amp 0.0005 --out .tmp-r0-media-native/long-30min
```

电源方案（`long-summary.json`，原文中文）：before `平衡 (381b4222…)` → during
`高性能 (8c5e7fda…)` → after `平衡 (381b4222…)`（脚本已恢复）。
退出码 0；`run.wall_s=1926.769`（含 mux/解码验证），`capture.wall_s=media_s=1800.021`。

#### 4.14.1 视频/帧时间轴

| 指标 | 值 | 说明 |
|---|---:|---|
| 写入（输出）帧数 | **54,000** | 期望 1800×30 = 54,000 |
| 输出视频时长 / 文件大小 | **1800.000 s / 107,388,915 B** | ≈102.4 MiB，≈3.58 MB/min（桌面内容基本静止） |
| 全量解码 | **exit 0**，36.93 s | `ffmpeg -v error -xerror -f null -` |
| 逐包时间轴 packets / span | 54,000 / 1,799.970 s | 排序后检查（B 帧重排 26,078 步，非空洞） |
| **缺失槽位 / 最大间隙 / 非均匀步** | **0 / 0 ms / 0** | 中位间隔 33.000 ms，有效 **29.9999 fps** |
| 采集侧送达 / 期望 | 45,597 / 54,000（**25.331 fps**） | 全屏 GDI 读回上限（§4.13） |
| 同槽丢弃 / 复制补齐 / 到达缺口 | 98 / **8,501（15.7%）** / 6,788 | 复制帧用于补齐输出时间轴 |
| 背压事件 / 总阻塞 / 最大阻塞 | 579 / 1,397.60 ms / 6.21 ms | 有界队列未成为瓶颈 |
| 帧质量（Release 全帧） | 唯一哈希 2,227、重复 51,773、全黑 0 | 桌面内容基本静止，luma mean 217.43 |
| 编码 | h264 MP4 2240×1400@30，CRF23 veryfast，exit 0 | `encode.wall_s=1800.580` |

结论：**30 分钟输出时间轴连续、时长/帧数精确、全量可解码**；采集侧唯一内容约 25 fps，
输出以复制帧补齐到 30 fps（比例 15.7%），这是本机 GDI 全屏能力的真实上限，不是编码问题。

#### 4.14.2 音频与 A/V

| 指标 | 值 | 说明 |
|---|---:|---|
| loopback 帧数 / 时长 | 86,400,960 / **1800.020 s** | 期望 1800×48,000 = 86,400,000（+0.02 s） |
| 包数 / SILENT 包 | 180,002 / 0 | 测试音持续渲染，无静音断流 |
| 首/末包偏移 / 最大包间隔 | 0.010 / 1800.021 s / 28.92 ms | 全程未断流 |
| WAV 大小 / 探测时长 | 345,603,884 B / 1800.020 s（48 kHz stereo） | 流式写盘，内存不保留整段 PCM |
| mux | **1800.000 s / 151,927,189 B / AAC 192k stereo / 解码 exit 0（38.42 s）** | mux wall 42.512 s |
| 视频跨度 / 音频跨度 | 1800.0033 / 1799.9707 s | `-debug_ts` |
| **start_offset / end_skew** | **−21.333 ms / −32.667 ms** | start=−AAC 1024 采样 priming（扣除后≈0）；尾部差 32.7 ms |
| 与短样对比 | 8–12 s 基线 end_skew −49.3/−34.0 ms | 30 min 仍同量级 → **无累积漂移证据**；容差需 R5 冻结 |

#### 4.14.3 进程树资源峰值（`resources.json`，2 s 采样；采集阶段 0–1798 s，800 点）

| 口径 | 测量值 | 说明 |
|---|---:|---|
| 进程数 max | 3 | native-capture + ffmpeg + conhost |
| **进程树 Private Bytes 峰值 / 均值 / p95** | **1,219.6 / 1,198.0 / 1,209.9 MB** | 由 ffmpeg(x264) 主导 |
| 其中 native-capture 峰值 / 均值 | **40.1 / 29.3 MB** | 有界队列 4×11.96 MB + 音频/线程 |
| 其中 ffmpeg 峰值 | 1,181.5 MB | x264 线程/前瞻缓冲；随分辨率/preset 变化 |
| Working Set 峰值 | 1,008.6 MB | 进程树合计 |
| 线程 / 句柄峰值 | 83 / 714 | 采集阶段 |
| **CPU（2 s 区间，占 16 逻辑核）峰值 / 均值 / p95** | **14.25% / 9.67% / 11.79%** | = **2.28 / 1.55 / 1.89 核** |
| 进程树 CPU 时间合计 / run wall | 2,795.484 s / 1,926.769 s = 145.1% 单核 | native-capture 1,112.2 s + ffmpeg 1,683.3 s |
| mux/解码等后处理（>1798 s，55 点） | CPU 峰值 **70%（11.2 核）**、Private ≤241.6 MB | **不计入采集阈值**，需要时另立“导出/后处理”口径 |

#### 4.14.4 T4 媒体阈值候选（**候选，未冻结**；交 Lead/用户/G0 决策）

测量口径 P1（本机可复现）：Windows 11 / i5-13500H / 16 逻辑核 / 2240×1400@150% 单屏 /
GDI 全屏采集 / 30 fps 输出 / libx264 veryfast CRF23 / AAC 192k mux / 高性能电源方案 /
30 分钟 / 进程树=采集进程+ffmpeg 子进程（采样 2 s）。**R5 必须先冻结媒体 profile 与
电源/设备/数据源，再据此重测；不同分辨率/preset 不得套用同一数值。**

| 候选阈值 | 建议值（P1） | 依据 | 备注 |
|---|---|---|---|
| 进程树 Private Bytes 峰值 | **≤ 1.35 GB** | 实测 1,219.6 MB（+~10%） | x264 lookahead/threads 主导；4K/更高 preset 需重测 |
| 采集进程 Private Bytes 峰值 | **≤ 64 MB** | 实测 40.1 MB | 有界队列 4 帧（11.96 MB/帧） |
| 进程树 Working Set 峰值 | **≤ 1.1 GB** | 实测 1,008.6 MB | Working Set 不等于独占 RAM |
| CPU 均值 / p95 / 2s 峰值 | **≤ 2.0 / 2.5 / 3.0 核** | 实测 1.55 / 1.89 / 2.28 核 | 以 16 逻辑核折算；产品机核数不同需按比例或绝对值重定 |
| 内存无界增长 | Private 峰值 ≤ 均值×**1.05**；句柄 ≤ **1000** | 实测 1.018 / 714 | 长时泄漏守卫 |
| 输出时间轴完整性 | `missing_slots=0`、时长=帧数/30、全量解码 exit 0 | 实测 0 / 1800.000 s / 0 | 硬门禁候选 |
| 复制帧比例 | **仅记录，不作门禁**（GDI 全屏 15.7%；WGC/区域应显著更低） | — | 产品应按来源类型设不同目标 |
| A/V 偏差 | `|start_offset|` 扣除 priming 后 ≤ 10 ms；`|end_skew|` ≤ 50 ms/30 min | 实测 0 / 32.7 ms | 容差需 R5 用统一媒体时钟冻结 |
| 文件大小 | **仅记录**（107.4 MB/30 min，静态桌面；mux 151.9 MB） | — | 强依赖内容/CRF，不适合做固定阈值 |
| 后处理（mux/导出） | 另立口径：CPU 峰值 11.2 核、Private ≤250 MB、耗时 ≈42 s/30 min | — | 不计入采集 T4 |

注意：以上为 **Low IL 30 min + Medium IL 10 min 两次运行**（均并行负载、单次/条件未隔离）
下的候选区间；§4.14.5 显示 IL 修复后各峰值差 <2%（CPU <10%），候选值无需因 IL 修改。
**不得写成“已冻结/已通过”**：正式 T4 需在隔离/负载受控条件下、至少 2–3 次独立运行、
并与 R5 目标媒体 profile 一致后由 G0 决策；登记位置建议为
[r0-performance-baseline.md](r0-performance-baseline.md) §6/§10（T4 行），由 Lead 统一回写。

#### 4.14.5 Medium IL 10 分钟对照样例（`long-10min-medium-r2`，2026-11-11 20:14–20:25）

目的：验证 IL 修复后时钟/丢帧/A-V/资源峰值结论是否变化。命令同 §4.14，仅
`-Seconds 600 -OutDir .tmp-r0-media-native\long-10min-medium-r2`。运行时
`env.integrity_level=Medium(0x2000)`；电源方案 before 平衡 → during 高性能 → after 平衡。
同机并行负载：system-load 采样 63 点（10 s 间隔）**平均 47.1%、最高 88%**（hook-matrix 等
teammate 在跑），属于非隔离环境，需在结论中登记。

| 指标 | Low IL 30 min（`long-30min`） | **Medium IL 10 min（`long-10min-medium-r2`）** | 判定 |
|---|---:|---:|---|
| 采集墙钟 / 媒体时长 | 1800.021 / 1800.021 s | **600.018 / 600.018 s** | 均为实时 |
| 输出帧数 / 视频时长 | 54,000 / 1800.000 s | **18,000 / 600.000 s** | 都精确 = 秒数×30 |
| 逐包时间轴缺槽 / 最大间隙 / 有效 fps | 0 / 0 ms / 29.9999 | **0 / 0 ms / 30.0000** | 一致 |
| 采集侧送达 / 送达 fps | 45,597 / 25.331 | **17,483 / 29.137** | 差异见下（非 IL 结论） |
| 同槽丢弃 / 复制补齐 | 98 / 8,501（15.7%） | **159 / 676（3.76%）** | 采集侧送达率差异所致 |
| 到达缺口 / 背压事件（总阻塞/最大） | 6,788 / 579（1,397.6 ms/6.21 ms） | **308 / 488（1,089.1 ms/6.07 ms）** | 同一量级 |
| 视频大小 / 全量解码 | 107,388,915 B / exit 0（36.9 s） | **53,712,424 B / exit 0（12.9 s）** | 通过 |
| 音频帧数 / 时长 / WAV | 86,400,960 / 1800.020 s / 345,603,884 B | **28,800,960 / 600.020 s / 115,203,884 B** | 均 = 秒数×48 kHz+0.02 s |
| 音频 SILENT 包 / 最大包间隔 | 0 / 28.92 ms | **0 / 23.11 ms** | 全程无断流 |
| mux 时长 / 大小 / 解码 | 1800.000 s / 151,927,189 B / exit 0 | **600.000 s / 68,557,760 B / exit 0** | 通过 |
| **A/V start_offset / end_skew** | −21.333 / **−32.667 ms**（30 min） | **−21.333 / −33.667 ms**（10 min） | **IL 无影响；无累积漂移** |
| 进程树 Private 峰值 / 均值 / p95 | 1,219.6 / 1,198.0 / 1,209.9 MB | **1,217.0 / 1,194.3 / 1,206.2 MB** | 差 <0.5% |
| 其中 native-capture 峰值 / 均值 | 40.1 / 29.3 MB | **39.6 / 29.0 MB** | 一致 |
| Working Set 峰值 | 1,008.6 MB | **991.5 MB** | 差 ~1.7% |
| CPU（2 s）峰值 / 均值 / p95 | 2.28 / 1.55 / 1.89 核 | **2.46 / 1.63 / 2.04 核** | 差 <10%（受并行负载影响） |
| 句柄 / 线程峰值 | 714 / 83 | **717 / 81** | 一致 |
| CPU 时间合计 / run wall | 2,795.5 s / 1,926.8 s（145.1%） | **981.9 s / 644.5 s（152.4%）** | 同量级 |

结论：

- **时钟/时间轴/A-V 结论不受 IL 影响**：两次长样例的输出时间轴均 0 缺槽、精确 30 fps、
  A/V start_offset 相同（−21.33 ms=AAC priming）、end_skew 差 1 ms（−32.7 vs −33.7 ms/长时）；
  音频时长 = 媒体时长+0.02 s。**T4 候选峰值同样成立**（Private/WS/句柄/线程差 <2%，
  CPU <10%），§4.14.4 的候选区间无需因 IL 修改。
- **采集侧送达率差异（25.3 vs 29.1 fps）不能归因于 IL**：两次运行均为非隔离环境，Medium
  样例并行负载平均 47%、最高 88%；Low IL 样例当时是 PDF teammate 负载。该差异属运行条件，
  不是 IL 的可见效应（GDI BitBlt 吞吐与 token IL 无已知机制关联），也不影响输出时间轴。
- **一次失败/受扰样例须登记**：首轮 10 min Medium 样例（`long-10min-medium`，20:09 完成）
  在并行负载下出现严重背压（backpressure 2,238 次/186.5 s 总阻塞/max 1.08 s），
  输出视频仅 466.8 s（<600 s，max_fill 截断）、A/V end_skew 巨大（+134.7 s）；
  该运行被判定为**负载扰动不可用**，未用于结论；其 `metrics.txt` 保留在证据目录中，
  说明“慢盘/长阻塞下时间轴会被 max_fill 截短”的风险在长录中确实存在（R5 必须冻结策略）。

### 4.15 环境缺陷（2026-11-11 发现）与修复：工作区 ACL 使 exe 以 Low IL 运行

**当前状态：已修复并完成 Medium IL 复验（2026-11-11 19:40 ACL 修复；19:44–19:58 重验）。
本机结论以 Medium IL 结果为准；Low IL 时期数据保留为环境对照。**

发现（同机 install-probe 定位，media-runner 复核）：

```text
icacls D:\workspace\Highlighter   （修复前）
  Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)     # 工作区目录树带 Low 强制标签+继承
icacls rust-app\prototypes\native-capture\target\release\native-capture.exe   （修复前）
  Mandatory Label\Low Mandatory Level:(I)(NW)          # 编译产物继承 Low 标签
shell（pwsh）进程完整性级别 = Medium(0x2000)            # 由 .NET/P-Invoke 读 TokenIntegrityLevel
native-capture（长测 pid=6164）/ ffmpeg 子进程 = Low(0x1000)
```

机制对照实验（排除“只是文件标签、不影响进程”）：把 `C:\Windows\System32\whoami.exe` 复制到
工作区（继承 Low 标签）后运行，`whoami /groups` 显示 **Low Mandatory Level (S-1-16-4096)**；
直接运行 System32 的原文件显示 **Medium (S-1-16-8192)**。即：**工作区内编译出的 exe 启动后
进程 IL = Low**，`ffmpeg` 子进程同样为 Low。证据：
`.tmp-r0-media-native/env-integrity/`（`icacls-*.txt`、`whoami-*.txt`、`integrity-levels.txt`、
`README-low-il.txt`）。

运行时自证：原型新增 `[env] process integrity level = ...` 日志（`src/env.rs`）后，
Low IL 时期短跑 `.tmp-r0-media-native/env-il-check-3s/run.log` 输出
`[env] process integrity level = Low(0x1000)`；修复后
`.tmp-r0-media-native/medium-il-check-3s/run.log` 输出
`[env] process integrity level = Medium(0x2000)`，`metrics.txt` 中
`env.integrity_level=Medium(0x2000)`。30 分钟样例（低 IL 时期构建）无 IL 行，
其进程 IL 由外部查询（`integrity-levels.txt`）确认。

**修复（Lead 执行，2026-11-11 19:40 前后）**：工作区全树 61,767 个文件 Low→Medium；
`icacls` 显示工作区根与 `target` 下 exe 均为 **Medium Mandatory Level**；当前 shell token 仍
Medium；新建/重跑 exe 运行时日志为 `Medium(0x2000)`。本 teammate 未自行修改 ACL。

影响映射（含修复后复验结果）：

| R0 结论/证据 | Low IL 时期 | **Medium IL 复验（已做）** | 最终处理 |
|---|---|---|---|
| WGC `E_ACCESSDENIED 0x80070005`（§4.1） | 失败 | **CreateForMonitor/CreateForWindow 均 OK；WGC 10 s@30 fps 采集成功（§4.1）** | **原结论作废**；E_ACCESSDENIED 归因 Low IL；WGC 可用，但打包身份/同意/真机矩阵仍未验证 |
| 窗口采集三方法（§4.13） | hidden 全黑/visible 部分黑 | **逐项复现（§4.13.1）** | 结论成立（本原型/本机行为）；非 IL 造成 |
| 区域采集（§4.13） | 30.136 fps / 1 复制帧 | **30.063 fps / 0 复制帧** | 结论成立，IL 无影响 |
| 音频 loopback/capture、暂停、时间轴、A/V 偏差（§4.11/§4.12） | 有效 | 10 min Medium 样例复核（§4.14.5） | 可直接引用 |
| 30 分钟样例 CPU/峰值（§4.14） | Low IL 单次 | 10 min Medium IL 样例对照（§4.14.5） | 作为区间候选；仍需多次运行/固定 profile |

修复后重验清单执行状态：

1. ✅ ACL 修复（Lead 执行，61,767 文件 Low→Medium；exe/工作区根 icacls 显示 Medium）；
2. ✅ 重建/运行确认 `[env] process integrity level = Medium(0x2000)`；
3. ✅ `--probe-wgc --animate`：两路径成功；WGC 10 s@30 fps 采集可播放；
4. ✅ hidden/visible × printwindow/window-dc/screen 与区域采集重跑；
5. ✅ Medium IL 10 分钟时钟+资源样例（`long-10min-medium-r2`，§4.14.5；首轮
   `long-10min-medium` 受并行负载扰动，作为异常证据保留）；30 分钟 Medium 样例未跑（以 10 分钟对照）；
6. ✅ 回写本文档 §4.1/§4.13/§4.14/§4.15 与 ADR-0001；handoff §1.3/§7 由 Lead 统一同步；
7. 环境教训：**Windows 上“工作区 ACL/强制标签”可以直接改变编译产物的进程 IL，并伪装成
   “系统权限拒绝”**；后续 R0/R1 的权限类失败先查 `icacls` Mandatory Label 与运行时 IL
   日志，再下结论。

### 4.16 2026-11-11 晚：回到原机（Ryzen 7 9850X3D / RTX 5070 Ti / 双屏）复验

**机器变更**：本轮被交接回 handoff §8 记的“原机”（SHERUNLOCK / MSN）：Ryzen 7 9850X3D 8C/16T、
47.15 GiB、**RTX 5070 Ti 独显**；双屏：主屏 `DISPLAY1` 3840×2160@**150%**（dpi 144）原点 (0,0)，
副屏 `DISPLAY2` **竖屏 1440×2560@125%**（dpi 120）物理原点 **(3840, −170)**（负 Y，虚拟桌面 5280×2560）。
Windows 11 专业版 26300、WebView2/Edge 157.0.4341.46。笔记本（SHERUNLOCK02，单屏 2240×1400、无独显）
的数值与本机**不可互比**，见 §4.16.4。

**完整性标签（第二台机器复现）**：本机工作区**再次**带有 DSH workspace-write 沙箱遗留的
`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`（含 `Everyone:(CI)(DENY)` 与能力 SID），
把 `whoami.exe` 复制进工作区运行输出 `Low Mandatory Level (S-1-16-4096)`。2026-11-11 21:22–21:27
由 Lead 修复（全树 Low→Medium；需先给属主授 `WO` 才能改标签，改完回收），修复后工作区内 exe 与
本轮所有原型进程均为 **Medium(0x2000)**（原型 `[env] process integrity level` 自证）。
取证与命令：`.tmp-r0-acl/acl-repair*.log`（gitignore）。

#### 4.16.1 发现并修复：WGC 采集路径未透传真实 HMONITOR（多显示器缺陷）

首次在双屏机器跑 WGC 采集**直接失败**（修复前原文）：

```text
[wgc] item created for monitor #0 (), wgc_size=5280x2560
[run] capture FAILED (raw error): WGC item size 5280x2560 != resolved size 1440x2560 (would corrupt rawvideo pipe)
```

根因：`capture::run` 用**合成**的 `MonitorInfo { index: 0, hmon: 0 }` 创建 `GraphicsCaptureItem`，
而 `IGraphicsCaptureItemInterop::CreateForMonitor(HMONITOR(0))` 得到的是**整个虚拟桌面**（5280×2560）。
单屏机器上虚拟桌面尺寸 == 屏幕尺寸，所以 2026-11-11 笔记本（单屏 2240×1400）那轮“WGC 10 s@30 fps 采集成功”
**看不见**这个缺陷：当时 item 也是由 HMONITOR(0)（虚拟桌面）创建的，只是尺寸恰好一致，
抓取语义与目标显示器等价。**这是从代码路径得出的一致性推论，未在笔记本上重测**。

修复（本轮，原型范围内）：`ResolvedCapture` 增加 `monitor: Option<MonitorInfo>`；
`--monitor` 目标在 `resolve()` 阶段把真实 `MonitorInfo`（含 `hmon`）带进运行期；
区域/窗口目标仍使用合成显示器（WGC 本就不支持这两类）。修复后日志变为：

```text
[wgc] item created for monitor #1 (\\.\DISPLAY2), wgc_size=1440x2560
[wgc] item created for monitor #0 (\\.\DISPLAY1), wgc_size=3840x2160
```

原型门槛：`cargo fmt --check` / `cargo clippy --all-targets -D warnings` / `cargo test --locked` 均 exit 0。

#### 4.16.2 本轮运行矩阵（Release、Medium IL、电源=平衡、无并行重活）

| 目录 | 目标 / 后端 | 输出 | 送达 fps | 写入帧 | 复制帧 | 节流丢弃 | 到达缺口 | 背压事件(总 ms) | 有效 fps | 解码 | 全黑 | CPU(%单核) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| `wgc-10s-mon1` | 副屏竖屏 / WGC | 1440×2560 | 51.27 | 301 | 0 | 233 | 0 | 0 (0.00) | 30.0000 | 0 | 0 | 128.3 |
| `wgc-5s-60fps-mon1` | 副屏竖屏 / WGC @60 | 1440×2560 | 49.60 | 300 | 33 | 0 | 0 | 0 (0.00) | 60.0000 | 0 | 0 | 131.3 |
| `auto-10s-mon1` | 副屏竖屏 / auto→WGC | 1440×2560 | 51.45 | 301 | 0 | 233 | 0 | 1 (2.67) | 30.0000 | 0 | 0 | 156.8 |
| `gdi-5s-30fps-mon1` | 副屏竖屏 / GDI 对照 | 1440×2560 | 30.10 | 151 | 0 | 0 | 0 | 1 (2.41) | 30.0000 | 0 | 0 | 97.0 |
| `wgc-5s-30fps-mon0` | 4K 主屏 / WGC | 3840×2160 | **24.80** | 151 | 27 | 10 | 22 | 41 (46.58) | 30.0000 | 0 | 0 | 179.7 |
| `gdi-5s-30fps-mon0` | 4K 主屏 / GDI 对照 | 3840×2160 | **27.88** | 150 | 13 | 3 | 0 | 55 (66.98) | 30.0000 | 0 | 0 | 246.6 |
| `wgc-2s-60fps-mon0` | 4K 主屏 / WGC @60 | 3840×2160 | **8.42** | 105 | 83 | 0 | 19 | 87 (1834.20) | 60.0001 | 0 | 0 | 257.1 |

WGC 能力矩阵（`--probe-wgc`，同一进程内）：`CreateForMonitor #0` 3840×2160 **OK**、
`CreateForMonitor #1` 1440×2560 **OK**、`CreateForWindow(前台窗口)` 1440×1260 **OK**。

#### 4.16.3 结论（只写本轮实测，不含推测）

1. **多显示器 WGC 逐屏可用**：修复 HMONITOR 透传后，主屏 4K 与副屏竖屏都能分别创建 item 并完成采集；
   `--capture auto` 在副屏选择 WGC 且无回退。此前“多显示器 WGC 未验证”升级为“本机双屏逐屏验证通过”，
   但**“同屏同时多路 WGC”未测**。
2. **竖屏 1440×2560 是该机 WGC 最舒服的点**：30 fps 与 60 fps 都满帧（301/300 帧、0 复制、0 背压、
   有效 30.0000/60.0000 fps、解码 exit 0、0 全黑）；30 fps 下 WGC 送达 ≈51 fps（DWM 刷新驱动），
   节流丢弃 233 次属预期行为而非缺陷。
3. **4K（3840×2160）在本原型架构下 WGC 并无对 GDI 的帧率优势**：@30 时 WGC 送达 24.8 fps（复制 27、背压 41 次）、
   GDI 27.9 fps（复制 13、背压 55 次），两者都被“整帧 BGRA 拷贝 + stdin 管道 + libx264 软编”限制。
4. **4K@60 明确不可持续**：2 s 只送达 22 帧（8.4 fps）、复制 83、背压 87 次共 1834 ms、CPU 257%（单核口径）、
   写入 ffmpeg 1218 MiB/s。对 R5 的直接含义：4K/60 需要硬编（NVENC/AMF/Media Foundation）或
   降采样/降帧策略；**不能沿用“每帧原始 BGRA 走 stdin”**，也不能把 4K/60 写进 R0 已达成项。
   独显存在不等于编码走 GPU——本原型只用 libx264。
5. 笔记本原结论的适用范围：单屏 2240×1400 下“WGC 10 s@30 fps 成功、送达 ≈56.8 fps、复制补齐 0”
   仍成立（当轮 item 由 HMONITOR(0)=虚拟桌面创建，尺寸恰好等于单屏）；但**不可外推到多屏/4K**。
   本轮所有数值与原机/笔记本其它轮次均不可互比。

#### 4.16.4 本轮口径与限制

- 电源方案为“平衡”（未切高性能），存在用户前台负载（主屏播放视频、DSH 桌面会话）；
  这些数字是**功能可行性 + 量级**，不是产品基线。
- 录制内容含本机桌面（含用户会话），完成解码校验后已删除 `video.mp4`，只保留指标与逐帧哈希：
  `.tmp-r0-media-native/newmachine/{summary.json,metrics.txt,video-timeline.txt,probe-video.txt,run.log}`
  与 `EVIDENCE.md`（gitignore）。
- 仍未验证：HDR、打包身份（MSIX/能力声明）、同意 UI/采集指示/企业策略、Win10 22H2 与其它 build、
  同屏多路、光标开关画面效果、长时 WGC（本轮最长 10 s）。

## 5. 结论（建议，供 ADR-0001 汇总；不写“已冻结”）

1. **原生后端在原型层面可行（GDI 路径已闭环）**：10 s@30 fps 桌面采集 → 有界管道 →
   ffmpeg H.264 → 可解码 MP4；WASAPI loopback → WAV → A/V mux 全部跑通，
   帧数/丢帧/间隔/黑帧、音频字节/时长、A/V 偏差都有可复核数字。
2. **WGC 路径“代码完成、运行证据缺失”（2026-11-11 Medium IL 复验后更正）**：
   旧观测的 `E_ACCESSDENIED` 是工作区 ACL 导致的 Low IL 环境缺陷（§4.15），不是 Windows
   对未打包应用的拒绝。ACL 修复后本机 WGC 两路径均可创建 item，WGC 10 s@30 fps 采集
   成功并可解码（§4.1，`wgc-10s-medium`），`auto` 已选 WGC 无回退。对 R5 的直接含义：
   - WGC 作为候选后端**可行性下限成立**；仍需把“打包身份/能力声明/用户同意/采集指示”
     纳入设计与发行方案，并在目标 Windows build 上复验（近期已有 `CreateForMonitor`
     版本回归报告，备选 `TryCreateFromDisplayId`）；
   - 本机未打包 Medium IL 下程序化创建 item 未弹选源 UI（观测），但**打包应用/首次运行/
     企业策略下的同意与采集指示行为未验证**，不能假设“静默调用即可”；
   - GDI 回退不是等价物：无光标、无系统采集指示、D3D/叠加层/受保护内容风险、
     整帧 CPU 拷贝（本机 2240×1400 全屏 21–25 fps，WGC 10 s 内送达 ~56.8 fps）。
3. **成本量级（本机原型，非产品基线）**：1440×2560@30 的 GDI + 管道 + libx264 ≈
   1.2–1.5 核（Release 合计 CPU 秒/墙钟 120.6%–145.1%）；4K@30 3 s 抽样 ≈2.5–2.9 核（口径见 §4.9）且未满帧；
   原始帧管道吞吐 418 MiB/s（3.7 MP）到 899 MiB/s（8.3 MP）。这支持“原生后端可行”，
   但不足以回答“是否比 WebView2 路径更省”/“是否满足产品 §9.2”，需 R5 同条件对照。
4. **A/V 与背压是可工程化的问题**：本原型已能测出 AAC priming 与尾部偏差，
   也复现了慢消费者导致的时间轴缩短；R5 必须冻结统一时钟、暂停语义、丢帧/降载策略、
   慢盘/磁盘满失败路径，以及“失败不登记成品”。
5. **对 ADR-0001 的建议**：两路 spike 证据齐备前不选型；本路证据支持
   “原生后端（以 ffmpeg 为编码器）作为 **B 方案** 的可行性下限成立”，
   **且 WGC 在 Medium IL 本机已取得成功采集证据**（但仍需打包身份/同意/采集指示、
   目标 build、多显示器/HDR/4K/长时与真机矩阵）。
   置信度：采集/编码/mux 链路=中高（本机实测）；WGC 本机可行性=中（Medium IL 实测成功，
   环境/身份面未验证）；GDI 等价性与两路同条件性能对照=低（未做）。

### 5.1 2026-11-11 扩展结论（供 ADR-0001/G0 汇总，候选未冻结）

6. **暂停/继续在本机成立（GDI）**：媒体时间轴不包含暂停时长（视频 0 缺槽、音频丢弃
   帧数 = 暂停时长×48 kHz、A/V end_skew 与无暂停基线同量级）；恢复边界最多 1 帧复制。
   R5 需冻结“暂停恢复帧相位/音频边界”的统一定义（本原型只给测量方法与现象）。
7. **双音源能力下限成立、对齐测量受环境阻塞**：可同时采 loopback 与 capture 端点、
   分别落 WAV、饱和相加混音并 mux；但本机麦克风拾不到渲染测试音，互相关无有效峰，
   “双路时间对齐”**未验证**（环境限制，登记为真机矩阵项）。
8. **区域/窗口采集与源目标变化有行为证据**：区域可达 30 fps；窗口三方法在可见/隐藏、
   遮挡、移动、关闭、重解析下的差异与事件均已复现并有落盘证据；**Medium IL 复验逐项一致**
   （§4.13.1），隐藏窗口全黑等行为不是 Low IL 造成；但逐帧内容对照、
   多显示器/DPI 矩阵、真实应用窗口（浏览器/Office/独占全屏）仍属真机矩阵。
9. **GDI 在本机全屏 3.1 MP 达不到 30 fps 唯一内容**（~21–25 fps）：输出时间轴仍 30 fps，
   靠复制帧补齐；**Medium IL 下 WGC 送达 ~56.8 fps、复制补齐 0**（§4.1/§4.14.5），
   说明 WGC 是 4K/高帧率的必要路径；R5 的媒体阈值必须按**分辨率/来源类型**分别定义。
10. **T4 媒体阈值候选**见 §4.14；只给候选区间与测量口径，不冻结（交 Lead/用户/G0 决策）。
11. **Medium IL 复验（2026-11-11 19:44–19:58）**：ACL 修复后重跑 WGC（成功）、区域
    （30.06 fps/0 复制）、窗口 hidden/visible（与 Low IL 逐项一致）、10 分钟 GDI 时钟样例
    （§4.14.5）。Low IL 结论中仅 WGC 被推翻；窗口/区域/音频/时间轴结论不受影响。

## 6. 未解决限制

1. **WGC 已在本机 Medium IL 取得成功采集证据（2026-11-11 更正），但能力边界未闭合**：
   未验证打包身份（MSIX/`uap11:Capability`）/同意 UI/采集指示/企业策略、Win10 22H2 与其它
   Win11 build（含 `CreateForMonitor` 版本回归报告与 `TryCreateFromDisplayId` 备选）、
   多显示器/窗口 WGC、HDR/4K/60 fps/受保护内容、光标开关的实际画面效果、长时 WGC 稳定性。
   旧 `E_ACCESSDENIED` 归因于工作区 Low IL 环境缺陷（§4.15），已作废。
2. **GDI 路径的等价性缺口**：无光标；D3D 全屏独占/硬件叠加层/受保护内容可能黑块或旧帧；
   无系统采集指示；整帧 CPU 拷贝在更高分辨率/帧率下的成本未测（4K@30 仅 3 s 抽样）。
3. **音频不完整（初版）**：只取混音格式前 2 声道（本机是 8 声道）；无麦克风、无双音源混音、
   无重采样/设备切换/热插拔；loopback 静音包语义已验证但“无 loopback 设备”环境未验证。
   2026-11-11 扩展已补：任意 capture 端点采集、双路 WAV、混音、设备混音格式枚举；
   仍缺：多声道混音（>2 声道）、设备热插拔/默认端点切换、双路时间对齐有效测量（本机阻塞）。
   默认输出/输入在本机均为**虚拟设备**：无活跃渲染流时 loopback 0 包（长录必须用 `--tone`
   或真实播放维持引擎；产品必须有“端点无数据”预检）。
4. **实时性/长录**：暂停/继续、30 分钟 Low IL 样例与 10 分钟 Medium IL 样例已在当前机完成
   （见 §4.11/§4.14/§4.14.5；Low IL 仅作环境对照）；仍缺：真实慢盘/磁盘满、编码队列/取消/重试、
   崩溃恢复、长录中用户改显示/锁屏/休眠、30 分钟 Medium IL 与双音源同条件样例；
   背压与“源丢失期间时间轴”策略未冻结。
5. **测量口径**：初版为非隔离环境（副屏并行任务）、单次运行、电源方案未冻结；
   扩展的 30 分钟样例固定高性能电源方案并记录 before/during/after，但仍是单次运行、
   **Low IL 环境**、同机有并行 teammate 负载（已登记），不能当产品基线。
6. **窗口/多显示器矩阵**：当前机单屏 2240×1400@150%；已补区域/窗口/源目标变化，
   仍缺 100%/200%、副屏/负坐标、拔插/重排、独占全屏、锁屏/RDP、真实应用窗口矩阵。
7. **编码器选择**：只用 libx264（软件）；`h264_nvenc`/`h264_amf`/Media Foundation 未测。
8. **工程边界**：原型只写 `.tmp-r0-media-native/`；产物不提交，文档哈希只对应当前本机文件，
   清理后不可复核（命令可复跑）。
9. **窗口方法的行为边界**：隐藏窗口的 `printwindow`/`window-dc` 在本机全黑、`screen`
   只能采背景；`--window-follow` 只按标题重解析，未实现同名窗口优先级/前台跟随；
   遮挡场景只到帧统计/事件级，未做逐帧图像对照。
10. **双音源对齐**：互相关方法已实现，但本机无共享声学路径（麦克风拾不到渲染音），
    有效延迟不可测；虚拟麦克风端点全零。属环境限制，真机矩阵必测项。
11. **GDI 帧率上限**：当前机 2240×1400 全屏唯一内容约 21–25 fps（CAPTUREBLT 开关无显著
    差异），输出时间轴按 30 fps 用复制帧补齐；更高分辨率/双屏/多窗口叠加的成本未测。
12. **暂停边界语义**：恢复后首个视频槽位差通常 2–3（1 帧复制），音频暂停边界 5 ms 轮询；
    R5 需冻结统一时钟与恢复相位，不能直接沿用本原型行为。
13. **4K 与 60 fps（2026-11-11 原机）**：4K@30 的 WGC/GDI 都满不了帧（24.8/27.9 fps 送达），
    4K@60 在本原型“原始 BGRA → stdin → libx264”架构下**不可持续**（8.4 fps 送达、背压 1834 ms）；
    未测硬编（NVENC/AMF/MF）、GPU 拷贝路径、降采样策略与 HDR。见 §4.16。
14. **同一显示器多路 WGC 未测**：本轮只做“逐屏单路”，未验证同一屏两路 item、跨屏同步时间戳、
    显示器热插拔/分辨率切换期间的 item 失效行为。

## 7. 责任批次与退出验收

| 项 | 批次 | 退出验收 |
|---|---|---|
| WGC/包身份/同意模型选型 + 目标 build 复验（含 `TryCreateFromDisplayId` 备选） | R5-01 / ADR-0001 / R8 | **R0 Medium IL 已成功**：CreateForMonitor/CreateForWindow OK、10 s@30 fps 采集可解码；**R5 仍需**：打包身份/同意 UI/采集指示/企业策略、Win10 22H2 与其它 build、多显示器/窗口/HDR/4K/60/长时 WGC 复验；失败有明确产品降级路径 |
| GDI 回退的等价性/成本与产品降级语义 | R5-01/R5-02 | 光标、D3D/叠加层、受保护内容、4K@30/60、慢盘矩阵；GDI 与 WGC 差异逐项登记；本机全屏 2240×1400 唯一内容 21–25 fps 需作为分辨率成本输入 |
| 统一时钟、暂停/继续、A/V 裁齐、容差冻结 | R5-02/R5-04/R5-07 | **R0 已补**：30 分钟时钟样例 + 暂停 2 次样例（视频 0 缺槽、音频丢弃帧=暂停时长、A/V end_skew 同基线量级）；**R5 仍需**：暂停恢复相位、A/V 容差数值冻结、30 分钟双音源（本机对齐不可测） |
| 背压/慢盘/磁盘满/设备丢失失败路径 | R5-02/R5-05 | 队列上界与磁盘预算；失败不登记成品；可解释暂停/失败；无无界内存；源目标丢失期间时间轴语义（R0 已暴露 max_fill 截短问题） |
| 双音源混音、麦克风、设备切换 | R5-02/R5-07 | **R0 已补**：loopback+Intel 麦克风同时采集/混音/mux 通过；**R5 仍需**：双路时间对齐有效测量（本机声学路径阻塞）、设备变化不静默换目标、>2 声道 |
| 区域/窗口/源目标变化 | R5-01/R5-02 | **R0 已完成（Low+Medium IL 双复验）**：区域 30 fps；窗口三方法可见/隐藏/遮挡/移动/关闭/重解析行为与事件；**R5 仍需**：逐帧内容对照、真实应用窗口、多显示器/DPI、目标丢失时间轴语义 |
| 媒体阈值 T4（峰值 CPU/Private Bytes/WorkingSet） | R0-05 / G0 | §4.14 候选区间 + 测量口径；不得在 R0 冻结，交 G0/产品决策 |
| 编码器选型（libx264/NVENC/AMF/MF）与 4K 性能对照 | R5-05/R5-07 | 同条件 30/60 fps、4K、30 分钟；CPU/GPU/内存/文件大小对照 |
| 原生 vs WebView2 两路同条件对照 | ADR-0001 / R5 | 计划 §9.2 口径的 p50/p95、CPU/GPU、内存、失败语义对照表 |
| 4K / 60 fps / 多显示器编码路径 | R5-01/R5-05 | **R0 已给下限**：竖屏 1440×2560@60 满帧可行；4K@30 满帧不可达（WGC 24.8 / GDI 27.9）；4K@60 当前架构不可持续（§4.16）。**R5 仍需**：硬编/GPU 拷贝路径、降采样/降帧策略、HDR、同屏多路、跨屏时间戳 |

## 8. 变更记录

| 日期 | 变更 | 证据 |
|---|---|---|
| 2026-11-10 | 初版：R0-05b 原型、Release/Debug 验收矩阵、WGC 权限失败分支、WASAPI/A-V、背压与失败分支证据 | 本文档；`.tmp-r0-media-native/`；提交见分支 `codex/rust-r0-baseline-contracts` |
| 2026-11-11 | 扩展（当前机 SHERUNLOCK02）：暂停/继续（媒体时钟+音频丢弃+恢复槽位差）、双音源端点枚举/采集/混音/对齐测量（对齐受本机声学路径阻塞）、区域/窗口三方法 + 源目标变化场景、30 分钟时钟样例 + 进程树资源峰值、T4 媒体阈值候选（未冻结）、GDI 分辨率成本对照；新增 `pause.rs`/`sync.rs`/`testwin.rs`/`capture/window.rs`/`run-long-sample.ps1` | 本文档 §0.1/§4.11～§4.14/附录 A.1；`.tmp-r0-media-native/`（gitignore，不提交） |
| 2026-11-11 晚（21:20–21:45，回到原机） | **原机双屏复验**：ACL Low 标签在本机二次复现并由 Lead 修复（全树 Medium，运行时 `Medium(0x2000)` 自证）；发现并修复原型 **WGC HMONITOR 未透传缺陷**（多屏下 item 变成整个虚拟桌面 5280×2560，单屏不可见）；`--probe-wgc` 主屏 4K/副屏竖屏/CreateForWindow 全 OK；WGC 竖屏 30/60 fps 满帧、4K@30 未满帧、**4K@60 不可持续**（§4.16）；录制产物按隐私处理后删除 | 本文档 §4.16；`.tmp-r0-media-native/newmachine/`（gitignore，含 `EVIDENCE.md`）；`.tmp-r0-acl/` |
| 2026-11-11（19:40–19:58，ACL 修复后） | **Medium IL 复验**：工作区 ACL Low→Medium（61,767 文件，Lead 执行）；运行时 IL 日志 `Medium(0x2000)`；**WGC 更正为可用**（probe 两路径 OK、10 s@30 fps 采集成功、auto 无回退；修复 `IDirect3DSurface→ID3D11Texture2D` 读取 bug）；区域 30.06 fps/0 复制、窗口 hidden/visible 与 Low IL 逐项一致（隐藏窗口全黑非 IL 造成）；新增 10 分钟 Medium IL 时钟/资源样例（§4.14.5）；T4 候选与 ADR-0001 证据更新 | 本文档 §4.1/§4.13.1/§4.14.5/§4.15；`.tmp-r0-media-native/{probe-wgc-medium,wgc-10s-medium,auto-wgc-5s-medium,region-640x360-5s-medium,scenario-hidden-medium,scenario-visible-medium,medium-il-check-3s,long-10min-medium}/` |

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

### A.1 2026-11-11 扩展证据（当前机，Release）

| 文件 | 大小 | sha256 |
|---|---:|---|
| `tone-loopback-8s-b/video.mp4`（A/V 无暂停基线） | 763,285 B | `cfa1d7c50a964f88d33471dbcb993a766a0b57e6686c306a51b352cd78875b88` |
| `pause-short-12s-c/video.mp4`（暂停 2 s+1 s，视频-only） | 958,315 B | `9b2dc50db7e6e200538bb538d5919a9d0c943548da8e2a0133685c483d3ff6e8` |
| `pause-short-12s-c/capture.mp4`（暂停样例 A/V mux） | 1,255,809 B | `6acb17c90961317fdefae11efd4b3f962abda47404155c9d5b63bb7a2362db92` |
| `pause-short-12s-c/pause-windows.txt` | 292 B | `（短文本，内容见 §4.11 原文）` |
| `dual-audio-8s/audio-mix.wav`（loopback+Intel 麦克风混音） | 1,545,644 B | `0a109a84e9d398deba03cd57c5559c5d17019f4420fc38ffacd40e1f8953fffb` |
| `dual-audio-8s/capture.mp4`（双音源 mux） | 961,279 B | `514e605c8f3c2dfbb729a93c2886af8334401d37a75d4df1ea32300af95e9821` |
| `region-640x360-5s/video.mp4` | 35,599 B | `389d366e796777072ab24fef2f4482b7bae0afb8e016c423290b8df342c1f069` |
| `scenario-visible/printwindow/video.mp4` | 56,371 B | `7fef75ba8a5c8638df9c7c4b339a319f967ed885b527c26d8ff59b0cf5d24351` |
| `scenario-visible/window-dc/video.mp4` | 59,969 B | `ccfd1a1b456af5592f5c1fb08905de03bc33b00f7992e4c0b4581179342291ad` |
| `scenario-visible/screen/video.mp4` | 67,986 B | `d5dd633d8224dc33f8bed64283db56ef5ddc05d004d467975a75103759627c51` |
| `scenario-hidden3/printwindow/video.mp4`（全黑） | 8,288 B | `5b2538322a4db4798c87c1a3642bb9e3eda65bea5302f74c75d6ab4aad6ca380` |
| `scenario-hidden3/window-dc/video.mp4`（全黑，与上同哈希） | 8,288 B | `5b2538322a4db4798c87c1a3642bb9e3eda65bea5302f74c75d6ab4aad6ca380` |
| `scenario-hidden3/screen/video.mp4`（桌面背景） | 51,869 B | `c5f1fb272b535a211a351938c3965400204d5cb8a75200603eaaddc5728851ac` |

30 分钟样例与资源峰值证据见 §4.14（`long-summary.json`、`resources.json`、
`video-timeline.txt`、`pause/` 相关产物同目录）。所有 `.tmp*` 目录不提交。

### A.2 30 分钟样例与 Low IL 环境证据（2026-11-11，当前机，gitignore）

| 文件 | 大小 | sha256 |
|---|---:|---|
| `long-30min/video.mp4`（30 min 视频-only，54,000 帧） | 107,388,915 B | `49b04274ffd99729e701c4ae1c0a124a054c9262ef50bc256c89448943295d73` |
| `long-30min/capture.mp4`（30 min A/V mux） | 151,927,189 B | `03f91aba3c098a804710d565adf28ae0c9b5323f1be6a5e7a99e69baaeaefdd0` |
| `long-30min/audio.wav`（30 min loopback） | 345,603,884 B | `a6591d9110d46a7a94370e071886f98fd0804d6ba27d733659dfb6f1547b0cca` |
| `long-30min/video-timeline.txt` | 216 B | `7e53a1460bb498864f20b6e68e5b1ce3cd05349a8ac25edc41d8747970f0af49` |
| `long-30min/av-spans.txt` | 149 B | `dd8e5cca736273d0340667d9d54b3e3fbfe2ec9040461596e9cc3fd86e35f2cd` |
| `long-30min/long-summary.json`（电源/产物/峰值汇总） | 1,891 B | `9011b42a6a5c6745d511f1acd56950652423326334bfabff2cab4865fa6cbf29` |
| `long-30min/resources.json`（855 点进程树采样） | 876,058 B | `a07cdb94468c89751a6f4b809fb606789568659f53c75aa9b2ea740560674aa2` |
| `long-30min/metrics.txt` | 4,772 B | `8feabeae51b84c2b498453ad122cacb25911ecb62f237429dd11730ee4dd4eaf` |
| `long-30min/probe-video.txt` / `probe-mux.txt` | 633 / 844 B | `d9f0ded5…03385` / `3a3e177e…68665` |
| `env-integrity/icacls-workspace-root.txt`（Low 标签） | 303 B | `d211c7e96f52eb7a39fbf14dea47be2f4e58d58b78148d9a5806bc6a4474f9cf` |
| `env-integrity/icacls-native-capture-exe.txt` | 577 B | `fcf3e35941fa2fd1035349b419fbae0d5048b53bdf18f7365bfcf82ddf0ee066` |
| `env-integrity/integrity-levels.txt`（进程 IL=Low） | 201 B | `28ae3c2522a923f0030e7f5f117c3d1c3996d9376c4152b90918f950e4fc2be1` |
| `env-integrity/whoami-lowlabeled-file.txt` / `whoami-system32-file.txt` | 157 / 222 B | `6ca943e6…b8a42` / `b31c6dfe…3cf02` |
| `env-il-check-3s/run.log`（含 `[env] process integrity level = Low(0x1000)`） | 4,750 B | `f36f5eac353b2f6e8222873269c2b575868f26b2ad40b446839f418f04ffe01c` |
| `env-il-check-3s/metrics.txt`（`env.integrity_level=Low(0x1000)`） | 2,741 B | `c1279222038742db1b59a9fa30a4c2685556763e32deb4dde1e41e890824abd8` |

### A.3 Medium IL 复验证据（2026-11-11 19:44–20:25，ACL 修复后，gitignore）

| 文件 | 大小 | sha256 |
|---|---:|---|
| `medium-il-check-3s/run.log`（`Medium(0x2000)` 运行时自证） | 4,778 B | `bec48714efd0ca2751992a47596dd0b259f5c8d288e905b3f739ad623827529c` |
| `probe-wgc-medium/run.log`（CreateForMonitor/CreateForWindow OK） | 1,245 B | `ce4580a8e19fc8d6471674eab9418739b44f6f8ccfc1c10133bc1dc26e88b905` |
| `wgc-10s-medium/video.mp4`（WGC 10 s@30 fps，300 帧） | 1,055,818 B | `1272db8d3907f18163568b03f059843edbc032292003e766773ac1961ea75758` |
| `wgc-10s-medium/summary.json` | 3,828 B | `7d49ece18bcdcc676ba8ba809524ed955814a4e3c344b69b7b591ef56d2a9827` |
| `auto-wgc-5s-medium/video.mp4`（auto 选 WGC 无回退） | 855,621 B | `96921648362b3043d1f36df7b1e3082b17882feb33c1cd830a2ef21f09c04d4b` |
| `region-640x360-5s-medium/video.mp4`（30.06 fps / 0 复制） | 28,099 B | `3856360fe2d1ac7f29174c75864b3e2ce2bd6db6a3e192cc7a9a78291680a5dc` |
| `scenario-hidden-medium/printwindow/video.mp4`（196/196 全黑） | 8,288 B | `5b2538322a4db4798c87c1a3642bb9e3eda65bea5302f74c75d6ab4aad6ca380` |
| `scenario-hidden-medium/window-dc/video.mp4`（同上，同哈希） | 8,288 B | `5b2538322a4db4798c87c1a3642bb9e3eda65bea5302f74c75d6ab4aad6ca380` |
| `scenario-hidden-medium/screen/video.mp4`（桌面背景） | 42,612 B | `8db6a2ecfbe9913ab9d37da860b887be353cc7de93ef55b61fbdb4eda1c2e88e` |
| `scenario-visible-medium/printwindow/video.mp4`（1/262 全黑） | 61,603 B | `cd5c883a590d37c37b9b12030a1eb88901b9eafdf138510afdfcf3d420fa5573` |
| `scenario-visible-medium/window-dc/video.mp4`（1/262 全黑） | 61,260 B | `28f04cdd3074e1fe973cca587c10400408ca6c6588dc7f5a9b8b85eebb3dbaa8` |
| `scenario-visible-medium/screen/video.mp4` | 67,534 B | `c38ad626be59870da8dbfc5b08ed2accd97aae9d4b0d80afad60138e7e8cd79b` |
| `long-10min-medium-r2/video.mp4`（10 min Medium IL，18,000 帧） | 53,712,424 B | `cd64260a23919d1ae5b605d8e0618b2454f4d361856149db7405cc359a568607` |
| `long-10min-medium-r2/capture.mp4`（10 min A/V mux） | 68,557,760 B | `4e4e89857927738a9008353ecdc2ccb9d2fcb9c2956eef5b97d66d4df52acd3c` |
| `long-10min-medium-r2/audio.wav` | 115,203,884 B | `fcca490893d5e9db5e3d1b66d9344f2d5e1eb85f0b42c2644a53d444f4da32cc` |
| `long-10min-medium-r2/video-timeline.txt` | 213 B | `5a5417d263124bbce9c7fa9166bc53bd0849084d02ec21dcc70e90e98a25c897` |
| `long-10min-medium-r2/av-spans.txt` | 147 B | `37f4ff6343d037a85e22e3249c6737aa29fa7e800a89bfc0d487e70a0dd9d4f3` |
| `long-10min-medium-r2/long-summary.json` | 1,918 B | `ac8ac916c613ebb4f1d7fd9d07759f833adab40d51686cc8167d544c0b6284f3` |
| `long-10min-medium-r2/resources.json` | 293,821 B | `8f2905cdaf22816ad938504efaee655a26d16757d1ebec93be072888157f34f8` |
| `long-10min-medium-r2/metrics.txt` | 4,791 B | `caa7bfbe9095ff4530921eec5ab0d23f24268e9bcd2c4eb1d88e59c8ebbdb731` |
| `long-10min-medium-r2/system-load.csv`（并行负载采样 63 点） | 1,257 B | `b0daa00f607c5327be88e4f111e6700bd53b83115d0d9f44fd26b682fd8f3b48` |
| `long-10min-medium/metrics.txt`（首轮受扰样例，不用于结论） | 4,797 B | `4309badfbd2c42a094dca45bdaa78e95b6b4f9ad580a426560a3058adfadfec0` |

## 附录 B：原型代码位置

| 文件 | 内容 |
|---|---|
| [`src/main.rs`](../../../rust-app/prototypes/native-capture/src/main.rs) | CLI、编排、指标落盘、窗口目标变化场景、Debug/Release 标注 |
| [`src/capture/mod.rs`](../../../rust-app/prototypes/native-capture/src/capture/mod.rs) | 显示器枚举（per-monitor v2）、目标解析（显示器/区域/窗口）、后端解析、按时间轴重采样（含暂停媒体时钟）、统计 |
| [`src/capture/wgc.rs`](../../../rust-app/prototypes/native-capture/src/capture/wgc.rs) | WGC：D3D11 → WinRT device → `CreateForMonitor` → `CreateFreeThreaded` 帧池 → staging；探测/失败分支 |
| [`src/capture/gdi.rs`](../../../rust-app/prototypes/native-capture/src/capture/gdi.rs) | GDI：`CreateDIBSection`(top-down BGRA) + `BitBlt(SRCCOPY|CAPTUREBLT)`；暂停节拍；区域/窗口目标 |
| [`src/capture/window.rs`](../../../rust-app/prototypes/native-capture/src/capture/window.rs) | 窗口枚举/几何（DWM 扩展边框）、PrintWindow/WM_PRINT/GetWindowDC 抓取、移动/失效/重解析事件 |
| [`src/testwin.rs`](../../../rust-app/prototypes/native-capture/src/testwin.rs) | 受控测试窗口（可见/隐藏、定时重绘、WM_PRINT 自绘） |
| [`src/ffmpeg.rs`](../../../rust-app/prototypes/native-capture/src/ffmpeg.rs) | 有界通道写线程 → ffmpeg stdin；stderr 排空；帧哈希/亮度；mux |
| [`src/wasapi.rs`](../../../rust-app/prototypes/native-capture/src/wasapi.rs) | 端点枚举、loopback/任意 capture 端点采集、流式 WAV、暂停丢弃、合成测试音、混音/重采样 |
| [`src/pause.rs`](../../../rust-app/prototypes/native-capture/src/pause.rs) | 暂停调度状态机（媒体时钟、暂停窗口、恢复槽位差）+ 跨线程 PauseGate |
| [`src/sync.rs`](../../../rust-app/prototypes/native-capture/src/sync.rs) | 双路对齐（降采样归一化互相关）、电平统计、测试音起点检测 |
| [`src/verify.rs`](../../../rust-app/prototypes/native-capture/src/verify.rs) | `ffmpeg -i` / `-xerror` / `-debug_ts` / `-progress` 证据解析、排序后时间轴连续性 |
| [`src/anim.rs`](../../../rust-app/prototypes/native-capture/src/anim.rs) | 测试动画窗口（只出现在被采集显示器） |
| [`src/cpumon.rs`](../../../rust-app/prototypes/native-capture/src/cpumon.rs) | `GetProcessTimes`：本进程 + ffmpeg 子进程 CPU |
| [`src/env.rs`](../../../rust-app/prototypes/native-capture/src/env.rs) | 进程完整性级别取证（OpenProcessToken/GetTokenInformation，日志 `[env] process integrity level`） |
| [`run-long-sample.ps1`](../../../rust-app/prototypes/native-capture/run-long-sample.ps1) | 30 分钟样例外壳：电源方案、进程树资源采样、解码/哈希/峰值汇总 |
