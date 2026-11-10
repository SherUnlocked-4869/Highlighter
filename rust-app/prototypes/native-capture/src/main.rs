//! R0-05b 原生媒体采集最小闭环原型（独立 Cargo 工程）。
//!
//! 一键复跑（仓库根目录）：
//! ```text
//! cargo run --release --manifest-path rust-app/prototypes/native-capture/Cargo.toml -- \
//!   --seconds 10 --fps 30 --capture auto --audio --out .tmp-r0-media-native/release-av
//! ```
//!
//! 链路：Windows.Graphics.Capture（WGC）或 GDI BitBlt 采 BGRA 帧
//! → 有界通道 → ffmpeg stdin 原始帧编码 H.264 MP4；
//! WASAPI loopback 采系统声音 → 16-bit PCM WAV → ffmpeg mux 成 MP4；
//! 所有产物与日志落在 `--out` 目录（仓库 `.tmp*/` gitignore）。
//!
//! 构建类型（Debug/Release）写入日志、summary.json 与文档：
//! Release 数据只代表本机本原型的量级，**不是**产品 Release 基线（计划 §9.2 未冻结）。

#![windows_subsystem = "windows"]
// 原型里的诊断/测量辅助项并非全部被主链路调用，保留而不产生告警。
#![allow(dead_code)]

// util 里的 logln! 宏通过 macro_use 引入 crate 根，对下面所有模块可见。
#[macro_use]
mod util;
mod anim;
mod capture;
mod cpumon;
mod ffmpeg;
mod verify;
mod wasapi;

use std::path::{Path, PathBuf};
use std::time::Instant;

use cpumon::SelfCpuCounter;
use ffmpeg::encoder_args_pretty;
use util::{build_profile, json_escape, log};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

const DEFAULT_FFMPEG: &str = "node_modules/ffmpeg-static/ffmpeg.exe";
const DEFAULT_OUT: &str = ".tmp-r0-media-native/latest";

#[derive(Clone, Debug)]
struct Cli {
    seconds: f64,
    fps: u32,
    capture: String,
    audio: bool,
    out: PathBuf,
    ffmpeg: PathBuf,
    monitor: usize,
    animate: bool,
    queue: usize,
    slow_consumer_ms: u64,
    fallback: bool,
    codec: String,
    preset: String,
    crf: u32,
    audio_endpoint: Option<String>,
    mux: bool,
    fault_wgc_hmon: Option<isize>,
    probe_wgc: bool,
    help: bool,
}

impl Default for Cli {
    fn default() -> Self {
        Self {
            seconds: 10.0,
            fps: 30,
            capture: "auto".to_string(),
            audio: false,
            out: PathBuf::from(DEFAULT_OUT),
            ffmpeg: PathBuf::from(DEFAULT_FFMPEG),
            // 默认采副屏：仓库 AGENTS.md 要求可见测试窗口只放副屏，动画窗口会跟随采集目标。
            monitor: 1,
            animate: true,
            queue: 4,
            slow_consumer_ms: 0,
            fallback: true,
            codec: "libx264".to_string(),
            preset: "veryfast".to_string(),
            crf: 23,
            audio_endpoint: None,
            mux: true,
            fault_wgc_hmon: None,
            probe_wgc: false,
            help: false,
        }
    }
}

fn parse_args() -> Result<Cli, String> {
    let mut cli = Cli::default();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let (key, inline) = match arg.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (arg.clone(), None),
        };
        macro_rules! value {
            () => {
                inline
                    .clone()
                    .or_else(|| it.next())
                    .ok_or_else(|| format!("argument {key} requires a value"))?
            };
        }
        match key.as_str() {
            "--seconds" => cli.seconds = value!().parse().map_err(|e| format!("--seconds: {e}"))?,
            "--fps" => cli.fps = value!().parse().map_err(|e| format!("--fps: {e}"))?,
            "--capture" => cli.capture = value!(),
            "--audio" => cli.audio = true,
            "--no-audio" => cli.audio = false,
            "--out" => cli.out = PathBuf::from(value!()),
            "--ffmpeg" => cli.ffmpeg = PathBuf::from(value!()),
            "--monitor" => cli.monitor = value!().parse().map_err(|e| format!("--monitor: {e}"))?,
            "--animate" => cli.animate = true,
            "--no-animate" => cli.animate = false,
            "--queue" => cli.queue = value!().parse().map_err(|e| format!("--queue: {e}"))?,
            "--slow-consumer-ms" => {
                cli.slow_consumer_ms = value!()
                    .parse()
                    .map_err(|e| format!("--slow-consumer-ms: {e}"))?
            }
            "--no-fallback" => cli.fallback = false,
            "--codec" => cli.codec = value!(),
            "--preset" => cli.preset = value!(),
            "--crf" => cli.crf = value!().parse().map_err(|e| format!("--crf: {e}"))?,
            "--audio-endpoint" => cli.audio_endpoint = Some(value!()),
            "--no-mux" => cli.mux = false,
            "--fault-wgc-hmon" => {
                cli.fault_wgc_hmon = Some(
                    value!()
                        .parse()
                        .map_err(|e| format!("--fault-wgc-hmon: {e}"))?,
                )
            }
            "--probe-wgc" => cli.probe_wgc = true,
            "--help" | "-h" => cli.help = true,
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(cli)
}

fn usage() -> &'static str {
    "native-capture: R0-05b 原生采集最小闭环\n\
     \n\
     用法: native-capture [选项]\n\
     \n\
       --seconds <秒>          采集时长，默认 10\n\
       --fps <帧率>            目标输出帧率，默认 30\n\
       --capture <auto|wgc|gdi> 后端，默认 auto（WGC 失败回退 GDI）\n\
       --audio                 同时采集 WASAPI loopback 系统声音并 mux\n\
       --no-mux                只采音频不 mux\n\
       --out <目录>            产物目录，默认 .tmp-r0-media-native/latest\n\
       --ffmpeg <exe>          ffmpeg 路径，默认 node_modules/ffmpeg-static/ffmpeg.exe\n\
       --monitor <索引>        显示器索引，默认 1（副屏；0=主屏）\n\
       --no-animate            不创建测试动画窗口（静止桌面下 WGC 帧数会很低）\n\
       --queue <帧数>          ffmpeg 管道有界队列，默认 4\n\
       --slow-consumer-ms <ms> 每帧人为延迟，模拟慢盘/背压\n\
       --no-fallback           auto 模式下 WGC 失败不回退 GDI\n\
       --codec/--preset/--crf  编码参数，默认 libx264/veryfast/23\n\
       --audio-endpoint <id>   指定渲染端点（默认 eRender/eConsole）\n\
       --fault-wgc-hmon <值>   故障注入：用无效 HMONITOR 触发真实 WGC 错误\n\
       -h, --help              本帮助\n\
     \n\
     退出码: 0=ok, 1=partial（视频通过但音频/mux 失败）, 2=失败\n"
}

#[derive(Default)]
struct Report {
    status: String,
    metrics: Vec<(String, String)>,
}

impl Report {
    fn set(&mut self, key: &str, value: impl Into<String>) {
        self.metrics.push((key.to_string(), value.into()));
    }
    fn log_metric(&self) {
        logln!("---- metrics ----");
        for (k, v) in &self.metrics {
            logln!("{k}={v}");
        }
    }
}

fn write_report(out_dir: &Path, report: &Report) {
    let mut json = String::new();
    json.push_str("{\n");
    json.push_str(&format!(
        "  \"status\": \"{}\",\n",
        json_escape(&report.status)
    ));
    json.push_str("  \"metrics\": {\n");
    for (i, (k, v)) in report.metrics.iter().enumerate() {
        json.push_str(&format!(
            "    \"{}\": \"{}\"{}\n",
            json_escape(k),
            json_escape(v),
            if i + 1 == report.metrics.len() {
                ""
            } else {
                ","
            }
        ));
    }
    json.push_str("  }\n}\n");
    let _ = std::fs::write(out_dir.join("summary.json"), &json);
    let flat: String = report
        .metrics
        .iter()
        .map(|(k, v)| format!("{k}={v}\n"))
        .collect();
    let _ = std::fs::write(out_dir.join("metrics.txt"), &flat);
    logln!("[run] wrote {}", out_dir.join("summary.json").display());
}

struct CaptureResult {
    run: capture::CaptureRun,
}

fn main() {
    let code = real_main();
    std::process::exit(code);
}

fn real_main() -> i32 {
    let cli = match parse_args() {
        Ok(c) => c,
        Err(e) => {
            log(&format!("[run] argument error: {e}"));
            log(usage());
            return 2;
        }
    };
    if cli.help {
        log(usage());
        return 0;
    }

    // DPI 感知必须在任何窗口/屏幕 DC 之前设置，否则 GDI 采到 DPI 虚拟化放大的坐标。
    let dpi_result =
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let _ = std::fs::create_dir_all(&cli.out);
    let _ = util::init_log(&cli.out.join("run.log"));
    logln!(
        "[run] native-capture R0-05b profile={} pid={}",
        build_profile(),
        std::process::id()
    );
    logln!(
        "[run] command line: {}",
        std::env::args().collect::<Vec<_>>().join(" ")
    );
    logln!(
        "[run] cwd={} out={} ffmpeg={}",
        std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        cli.out.display(),
        cli.ffmpeg.display()
    );
    match &dpi_result {
        Ok(()) => logln!("[env] SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) ok"),
        Err(e) => logln!("[env] SetProcessDpiAwarenessContext failed (continuing): {e}"),
    }
    match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        Ok(()) => logln!("[env] RoInitialize(MTA) ok"),
        Err(e) => logln!("[env] RoInitialize(MTA) returned {e} (usually already initialized)"),
    }

    let mut report = Report {
        status: "failed".to_string(),
        ..Default::default()
    };
    report.set("run.profile", build_profile());
    report.set("run.seconds", format!("{:.3}", cli.seconds));
    report.set("run.fps", cli.fps.to_string());
    report.set("run.capture_mode", cli.capture.clone());
    report.set(
        "run.command",
        std::env::args().collect::<Vec<_>>().join(" "),
    );

    let monitors = match capture::enumerate_monitors() {
        Ok(m) => m,
        Err(e) => {
            logln!("[run] FAILED enumerate displays: {e}");
            report.set("failure", format!("enumerate displays: {e}"));
            write_report(&cli.out, &report);
            return 2;
        }
    };
    for m in &monitors {
        logln!("[env] {m:?}");
    }
    let target = match monitors.get(cli.monitor).cloned() {
        Some(t) => t,
        None => {
            let msg = format!(
                "--monitor {} out of range: {} display(s) found",
                cli.monitor,
                monitors.len()
            );
            logln!("[run] FAILED {msg}");
            report.set("failure", msg);
            write_report(&cli.out, &report);
            return 2;
        }
    };
    report.set("capture.monitor", target.describe());

    if cli.probe_wgc {
        // 先创建可见窗口再探测：验证权限拒绝是否与“进程是否有前台窗口/能否弹出
        // 系统授权提示”有关（窗口放在 --monitor 指定的显示器上）。
        let anim = if cli.animate {
            match anim::AnimWindow::spawn(&target.rect) {
                Ok(w) => Some(w),
                Err(e) => {
                    logln!("[probe] anim window failed: {e}");
                    None
                }
            }
        } else {
            None
        };
        if anim.is_some() {
            std::thread::sleep(std::time::Duration::from_millis(2000));
        }
        capture::wgc::probe_matrix(&monitors);
        if let Some(w) = anim {
            w.close();
        }
        report.status = "probe".to_string();
        write_report(&cli.out, &report);
        return 0;
    }

    // 1) 先解析采集后端与真实输出尺寸（WGC 尺寸可能与显示器 rect 不同）。
    let resolved = match capture::resolve(&cli.capture, cli.fallback, &target, cli.fault_wgc_hmon) {
        Ok(r) => r,
        Err(e) => {
            logln!("[run] FAILED resolve capture backend: {e}");
            report.set("capture.resolve_error", e);
            write_report(&cli.out, &report);
            return 2;
        }
    };
    report.set("capture.backend", format!("{:?}", resolved.backend));
    report.set("capture.width", resolved.width.to_string());
    report.set("capture.height", resolved.height.to_string());
    if let Some(reason) = &resolved.fallback_reason {
        report.set("capture.fallback_reason", reason.clone());
        logln!("[run] capture fallback reason: {reason}");
    }

    // 2) 启动 ffmpeg 编码器（原始 BGRA 帧从 stdin 进入）。
    let video_path = cli.out.join("video.mp4");
    let keyint = cli.fps.saturating_mul(2).max(1);
    let encoder = match ffmpeg::spawn_video_encoder(
        &cli.ffmpeg,
        &video_path,
        resolved.width,
        resolved.height,
        cli.fps,
        &cli.codec,
        &cli.preset,
        cli.crf,
        keyint,
        cli.queue,
        cli.slow_consumer_ms,
    ) {
        Ok(e) => e,
        Err(e) => {
            logln!("[run] FAILED spawn ffmpeg encoder: {e}");
            report.set("encode.spawn_error", e);
            write_report(&cli.out, &report);
            return 2;
        }
    };
    report.set("ffmpeg.path", cli.ffmpeg.display().to_string());
    report.set("ffmpeg.args", encoder_args_pretty(&encoder.args));
    logln!(
        "[encode] ffmpeg args: {}",
        encoder_args_pretty(&encoder.args)
    );

    // 3) 动画窗口（可选，保证桌面有稳定内容变化）。
    let anim = if cli.animate {
        match anim::AnimWindow::spawn(&target.rect) {
            Ok(h) => Some(h),
            Err(e) => {
                logln!("[run] animation window failed: {e}");
                report.set("animate.error", e);
                None
            }
        }
    } else {
        None
    };

    // 4) WASAPI loopback（可选），先于 StartCapture 启动以测量音频前导。
    let audio_handle = if cli.audio {
        match wasapi::LoopbackHandle::start(cli.audio_endpoint.as_deref()) {
            Ok(h) => Some(h),
            Err(e) => {
                logln!("[run] audio start FAILED (raw error): {e}");
                report.set("audio.start_error", e);
                None
            }
        }
    } else {
        None
    };
    let audio_start = audio_handle.as_ref().and_then(|h| h.start_instant());
    if let Some(t) = audio_start {
        report.set("audio.start_offset_from_capture", "measured-after-capture");
        logln!("[audio] loopback started at {t:?}");
    }

    // 5) 采集。
    let self_cpu = SelfCpuCounter::start();
    let run_start = Instant::now();
    let capture_t0 = Instant::now();
    let capture_result = capture::run(
        &resolved,
        &target,
        cli.seconds,
        cli.fps,
        10,
        encoder.sender(),
        capture_t0,
        cli.fault_wgc_hmon,
    );
    let capture_result: CaptureResult = match capture_result {
        Ok(run) => CaptureResult { run },
        Err(e) => {
            logln!("[run] capture FAILED (raw error): {e}");
            report.set("capture.error", e);
            if let Some(anim) = anim {
                anim.close();
            }
            if let Some(handle) = audio_handle {
                let audio = handle.stop();
                record_audio(&mut report, &audio);
            }
            let enc = encoder.finish();
            record_encode(&mut report, &enc);
            report.set(
                "run.wall_s",
                format!("{:.3}", run_start.elapsed().as_secs_f64()),
            );
            write_report(&cli.out, &report);
            return 2;
        }
    };

    // 采集结束后先停动画窗口，再停音频（音频覆盖同一墙钟窗口 + tail）。
    if let Some(anim) = anim {
        anim.close();
    }
    let audio_outcome = audio_handle.map(|h| h.stop());

    let capture_wall = capture_result.run.stats.wall_s();
    report.set("capture.real_backend", capture_result.run.backend);
    record_capture(&mut report, &capture_result.run);
    logln!(
        "[capture] backend={} wall={:.3}s",
        capture_result.run.backend,
        capture_wall
    );

    // 6) 收尾编码，记录 ffmpeg 原始错误。
    let enc = encoder.finish();
    record_encode(&mut report, &enc);
    let encode_ok = enc.exit_code == Some(0) && enc.stats.frames_written > 0;
    if !encode_ok {
        let tail_text = verify::tail(&enc.ffmpeg_stderr, 2000);
        logln!(
            "[encode] FAILED exit={:?} write_error={:?} stderr={}",
            enc.exit_code,
            enc.stats.write_error,
            tail_text
        );
        report.set("encode.ffmpeg_stderr", tail_text);
    }

    // 7) 视频产物验证。
    let mut video_ok = false;
    if video_path.exists() {
        report.set(
            "video.size_bytes",
            ffmpeg::file_size(&video_path).to_string(),
        );
        match verify::probe(&cli.ffmpeg, &video_path) {
            Ok(p) => {
                let _ = std::fs::write(cli.out.join("probe-video.txt"), &p.raw);
                video_ok = p.video.as_ref().map(|v| v.width > 0).unwrap_or(false);
                report.set(
                    "video.duration_s",
                    p.duration_s.map(|d| format!("{d:.3}")).unwrap_or_default(),
                );
                if let Some(v) = &p.video {
                    report.set("video.codec", v.codec.clone());
                    report.set("video.width", v.width.to_string());
                    report.set("video.height", v.height.to_string());
                    report.set("video.fps", format!("{:.3}", v.fps));
                    logln!("[verify] video stream: {}", v.raw);
                }
                logln!(
                    "[verify] video container duration={:?}s start={:?}",
                    p.duration_s,
                    p.start_s
                );
            }
            Err(e) => {
                logln!("[verify] video probe FAILED: {e}");
                report.set("verify.video.error", e);
            }
        }
        match verify::decode_check(&cli.ffmpeg, &video_path) {
            Ok((code, secs)) => {
                report.set("video.decode_exit", code.to_string());
                report.set("video.decode_wall_s", format!("{secs:.3}"));
                logln!("[verify] video full decode OK exit={code} wall={secs:.3}s");
            }
            Err(e) => {
                logln!("[verify] video decode FAILED (raw error): {e}");
                report.set("verify.video.decode_error", e);
                video_ok = false;
            }
        }
    } else {
        report.set("video.missing", "true");
        logln!("[verify] video file missing: {}", video_path.display());
    }

    // 8) 音频验证 + mux。
    let mut audio_ok = false;
    let mut audio_info: Option<(u32, u16, u64, Vec<u8>)> = None;
    if let Some(audio) = audio_outcome {
        record_audio(&mut report, &audio);
        let (rate, channels) = match &audio.mix {
            Some(m) => (m.sample_rate, m.channels.min(2)),
            None => (48000, 2),
        };
        if audio.error.is_some() {
            logln!(
                "[audio] capture error (raw): {}",
                audio.error.clone().unwrap_or_default()
            );
        }
        let expected_bytes = audio.frames * channels as u64 * 2;
        report.set("audio.expected_bytes", expected_bytes.to_string());
        report.set(
            "audio.frames_to_wav_ratio",
            if expected_bytes > 0 {
                format!("{:.4}", audio.out_bytes as f64 / expected_bytes as f64)
            } else {
                "0".to_string()
            },
        );
        if audio.pcm.is_empty() {
            logln!(
                "[audio] no loopback packets captured (pcm empty); system audio engine may be idle"
            );
            report.set(
                "audio.empty_reason",
                "no loopback packets captured (system audio engine idle or endpoint inactive)",
            );
        } else {
            let wav_path = cli.out.join("audio.wav");
            match wasapi::write_wav(&wav_path, rate, channels, &audio.pcm) {
                Ok(size) => {
                    report.set("audio.wav_bytes", size.to_string());
                    report.set("audio.sample_rate", rate.to_string());
                    report.set("audio.channels", channels.to_string());
                    let wav_seconds =
                        audio.pcm.len() as f64 / (rate as f64 * channels as f64 * 2.0);
                    report.set("audio.wav_duration_s", format!("{wav_seconds:.3}"));
                    match verify::probe(&cli.ffmpeg, &wav_path) {
                        Ok(p) => {
                            let _ = std::fs::write(cli.out.join("probe-audio.txt"), &p.raw);
                            if let Some(a) = &p.audio {
                                logln!("[verify] wav stream: {}", a.raw);
                                report.set("audio.probe_sample_rate", a.sample_rate.to_string());
                                report.set("audio.probe_channels", a.channels.clone());
                            }
                            report.set(
                                "audio.probe_duration_s",
                                p.duration_s.map(|d| format!("{d:.3}")).unwrap_or_default(),
                            );
                            audio_ok = true;
                        }
                        Err(e) => {
                            logln!("[verify] wav probe FAILED: {e}");
                            report.set("verify.audio.error", e);
                        }
                    }
                    audio_info = Some((rate, channels, size, audio.pcm.clone()));
                }
                Err(e) => {
                    logln!("[audio] write wav FAILED: {e}");
                    report.set("audio.wav_error", e);
                }
            }
        }
    }

    // 9) A/V mux 与偏差测量。
    let mut mux_ok = false;
    if cli.mux && encode_ok && audio_info.is_some() {
        let (audio_lead_s, first_frame) = match (capture_result.run.stats.first_frame, audio_start)
        {
            (Some(vf), Some(a0)) => ((vf - a0).as_secs_f64(), Some(vf)),
            _ => (0.0, None),
        };
        report.set("av.capture_audio_lead_s", format!("{audio_lead_s:.4}"));
        if let Some(t) = first_frame {
            logln!("[av] first video frame at {t:?}; audio lead={audio_lead_s:.4}s");
        }
        let muxed_path = cli.out.join("capture.mp4");
        let wav_path = cli.out.join("audio.wav");
        match ffmpeg::mux_av(
            &cli.ffmpeg,
            &video_path,
            &wav_path,
            &muxed_path,
            audio_lead_s,
        ) {
            Ok(mux) => {
                report.set("mux.exit_code", format!("{:?}", mux.exit_code));
                report.set("mux.wall_s", format!("{:.3}", mux.wall_s));
                logln!("[mux] args: {}", encoder_args_pretty(&mux.args));
                if mux.exit_code == Some(0) && muxed_path.exists() {
                    report.set("mux.size_bytes", ffmpeg::file_size(&muxed_path).to_string());
                    match verify::probe(&cli.ffmpeg, &muxed_path) {
                        Ok(p) => {
                            let _ = std::fs::write(cli.out.join("probe-mux.txt"), &p.raw);
                            report.set(
                                "mux.duration_s",
                                p.duration_s.map(|d| format!("{d:.3}")).unwrap_or_default(),
                            );
                            if let Some(v) = &p.video {
                                report.set(
                                    "mux.video",
                                    format!("{} {}x{} {:.3}fps", v.codec, v.width, v.height, v.fps),
                                );
                            }
                            if let Some(a) = &p.audio {
                                report.set(
                                    "mux.audio",
                                    format!(
                                        "{} {}Hz {} {}kbps",
                                        a.codec,
                                        a.sample_rate,
                                        a.channels,
                                        a.bitrate_kbps
                                            .map(|b| format!("{b:.0}"))
                                            .unwrap_or_default()
                                    ),
                                );
                            }
                            logln!("[verify] muxed container duration={:?}s", p.duration_s);
                        }
                        Err(e) => {
                            report.set("verify.mux.error", e.clone());
                            logln!("[verify] mux probe FAILED: {e}");
                        }
                    }
                    match verify::decode_check(&cli.ffmpeg, &muxed_path) {
                        Ok((code, secs)) => {
                            report.set("mux.decode_exit", code.to_string());
                            report.set("mux.decode_wall_s", format!("{secs:.3}"));
                            logln!("[verify] mux full decode OK exit={code} wall={secs:.3}s");
                            mux_ok = true;
                        }
                        Err(e) => {
                            logln!("[verify] mux decode FAILED (raw error): {e}");
                            report.set("verify.mux.decode_error", e);
                        }
                    }
                    // 每路流首末包时间戳（无 ffprobe 时用 -debug_ts 代替）。
                    let vspan = verify::stream_span(&cli.ffmpeg, &muxed_path, "0:v:0");
                    let aspan = verify::stream_span(&cli.ffmpeg, &muxed_path, "0:a:0");
                    match (&vspan, &aspan) {
                        (Ok(v), Ok(a)) => {
                            let start_offset = (a.first_pts_s - v.first_pts_s) * 1000.0;
                            let end_skew = (a.last_end_s - v.last_end_s) * 1000.0;
                            report.set("av.video_packets", v.packets.to_string());
                            report.set("av.audio_packets", a.packets.to_string());
                            report.set(
                                "av.video_span_s",
                                format!("{:.4}", v.last_end_s - v.first_pts_s),
                            );
                            report.set(
                                "av.audio_span_s",
                                format!("{:.4}", a.last_end_s - a.first_pts_s),
                            );
                            report.set("av.start_offset_ms", format!("{start_offset:.2}"));
                            report.set("av.end_skew_ms", format!("{end_skew:.2}"));
                            if v.last_end_s > v.first_pts_s {
                                report.set(
                                    "av.video_effective_fps",
                                    format!(
                                        "{:.3}",
                                        v.packets as f64 / (v.last_end_s - v.first_pts_s)
                                    ),
                                );
                            }
                            logln!(
                                "[av] video span={:.4}s ({}) audio span={:.4}s ({}) start_offset={:.2}ms end_skew={:.2}ms",
                                v.last_end_s - v.first_pts_s,
                                v.packets,
                                a.last_end_s - a.first_pts_s,
                                a.packets,
                                start_offset,
                                end_skew
                            );
                            let _ = std::fs::write(
                                cli.out.join("av-spans.txt"),
                                format!(
                                    "video: packets={} first={:.6} end={:.6}\naudio: packets={} first={:.6} end={:.6}\nstart_offset_ms={:.3}\nend_skew_ms={:.3}\n",
                                    v.packets, v.first_pts_s, v.last_end_s, a.packets, a.first_pts_s, a.last_end_s, start_offset, end_skew
                                ),
                            );
                        }
                        _ => {
                            let msg = format!(
                                "span measurement failed: video={:?} audio={:?}",
                                vspan.err(),
                                aspan.err()
                            );
                            logln!("[av] {msg}");
                            report.set("av.span_error", msg);
                        }
                    }
                    // 交叉口径：-progress out_time。
                    if let Ok(vend) = verify::stream_end_progress(&cli.ffmpeg, &muxed_path, "0:v:0")
                    {
                        report.set("av.video_end_progress_s", format!("{vend:.4}"));
                    }
                    if let Ok(aend) = verify::stream_end_progress(&cli.ffmpeg, &muxed_path, "0:a:0")
                    {
                        report.set("av.audio_end_progress_s", format!("{aend:.4}"));
                    }
                } else {
                    let tail_text = verify::tail(&mux.stderr, 2000);
                    logln!("[mux] FAILED exit={:?} stderr={tail_text}", mux.exit_code);
                    report.set("mux.ffmpeg_stderr", tail_text);
                }
            }
            Err(e) => {
                logln!("[mux] spawn FAILED (raw error): {e}");
                report.set("mux.spawn_error", e);
            }
        }
    } else if cli.audio && cli.mux {
        logln!("[mux] skipped: no audio data or video encode failed");
        report.set("mux.skipped", "no audio data or video encode failed");
    }

    // 10) CPU / 时间汇总。
    let total_wall = run_start.elapsed().as_secs_f64();
    let self_times = self_cpu.elapsed();
    let ffmpeg_cpu = enc.ffmpeg_cpu.unwrap_or_default();
    let total_cpu = self_times.total_s() + ffmpeg_cpu.total_s();
    report.set("run.wall_s", format!("{total_wall:.3}"));
    report.set("cpu.self_user_s", format!("{:.3}", self_times.user_s));
    report.set("cpu.self_kernel_s", format!("{:.3}", self_times.kernel_s));
    report.set("cpu.self_total_s", format!("{:.3}", self_times.total_s()));
    report.set("cpu.ffmpeg_user_s", format!("{:.3}", ffmpeg_cpu.user_s));
    report.set("cpu.ffmpeg_kernel_s", format!("{:.3}", ffmpeg_cpu.kernel_s));
    report.set("cpu.ffmpeg_total_s", format!("{:.3}", ffmpeg_cpu.total_s()));
    report.set("cpu.total_s", format!("{total_cpu:.3}"));
    if total_wall > 0.0 {
        report.set(
            "cpu.total_pct_of_one_core",
            format!("{:.1}", total_cpu / total_wall * 100.0),
        );
        report.set(
            "cpu.realtime_factor",
            format!("{:.3}", total_wall / cli.seconds.max(0.001)),
        );
    }
    report.set("encode.wall_s", format!("{:.3}", enc.wall_s));
    report.set(
        "encode.frames_written",
        enc.stats.frames_written.to_string(),
    );
    report.set(
        "encode.bytes_to_ffmpeg",
        enc.stats.bytes_written.to_string(),
    );
    report.set(
        "encode.throughput_mib_s",
        if enc.wall_s > 0.0 {
            format!(
                "{:.1}",
                enc.stats.bytes_written as f64 / (1024.0 * 1024.0) / enc.wall_s
            )
        } else {
            "0".to_string()
        },
    );
    report.set("encode.black_frames", enc.stats.black_frames.to_string());
    report.set("encode.quality_mode", enc.stats.quality_mode.clone());
    report.set("encode.unique_hashes", enc.stats.unique_hashes.to_string());
    report.set(
        "encode.repeated_hashes",
        enc.stats.repeated_hashes.to_string(),
    );
    report.set("encode.luma_min", format!("{:.2}", enc.stats.min_luma));
    report.set("encode.luma_max", format!("{:.2}", enc.stats.max_luma));
    report.set("encode.luma_mean", format!("{:.2}", enc.stats.mean_luma));
    if let Some(err) = &enc.stats.write_error {
        report.set("encode.write_error", err.clone());
    }

    logln!(
        "[run] profile={} wall={:.3}s self_cpu={:.3}s ffmpeg_cpu={:.3}s total_cpu={:.3}s ({:.1}% of one core)",
        build_profile(),
        total_wall,
        self_times.total_s(),
        ffmpeg_cpu.total_s(),
        total_cpu,
        if total_wall > 0.0 {
            total_cpu / total_wall * 100.0
        } else {
            0.0
        }
    );

    let audio_requested = cli.audio;
    let audio_ok_final = audio_ok && audio_info.is_some();
    report.status = if encode_ok && video_ok && (!audio_requested || (audio_ok_final && mux_ok)) {
        "ok".to_string()
    } else if encode_ok && video_ok {
        "partial".to_string()
    } else {
        "failed".to_string()
    };
    logln!("[run] STATUS={}", report.status);
    report.log_metric();
    write_report(&cli.out, &report);
    match report.status.as_str() {
        "ok" => 0,
        "partial" => 1,
        _ => 2,
    }
}

fn record_capture(report: &mut Report, run: &capture::CaptureRun) {
    let s = &run.stats;
    report.set("capture.backend_used", run.backend);
    report.set(
        "capture.requested_seconds",
        format!("{:.3}", run.requested_seconds),
    );
    report.set("capture.requested_fps", run.requested_fps.to_string());
    report.set("capture.delivered_frames", s.delivered.to_string());
    report.set("capture.written_frames", s.written.to_string());
    report.set("capture.pacing_drops", s.pacing_drops.to_string());
    report.set("capture.duplicated_frames", s.duplicated.to_string());
    report.set("capture.arrival_gaps", s.arrival_gaps.to_string());
    report.set(
        "capture.backpressure_events",
        s.backpressure_events.to_string(),
    );
    report.set(
        "capture.backpressure_total_ms",
        format!("{:.2}", s.backpressure_total_ms),
    );
    report.set(
        "capture.backpressure_max_ms",
        format!("{:.2}", s.backpressure_max_ms),
    );
    report.set("capture.send_errors", s.send_errors.to_string());
    report.set("capture.wall_s", format!("{:.3}", s.wall_s()));
    if s.delivered > 0 && s.wall_s() > 0.0 {
        report.set(
            "capture.delivered_fps",
            format!("{:.3}", s.delivered as f64 / s.wall_s()),
        );
    }
    report.set(
        "capture.expected_frames",
        format!("{:.0}", run.requested_seconds * run.requested_fps as f64),
    );
    report.set(
        "capture.interval_mean_ms",
        format!("{:.2}", s.intervals.mean_ms),
    );
    report.set(
        "capture.interval_p50_ms",
        format!("{:.2}", s.intervals.p50_ms),
    );
    report.set(
        "capture.interval_p95_ms",
        format!("{:.2}", s.intervals.p95_ms),
    );
    report.set(
        "capture.interval_max_ms",
        format!("{:.2}", s.intervals.max_ms),
    );
    if let Some(err) = &s.error {
        report.set("capture.stats_error", err.clone());
    }
    if let Some(ff) = s.first_frame {
        report.set("capture.first_frame_debug", format!("{ff:?}"));
    }
}

fn record_encode(report: &mut Report, enc: &ffmpeg::EncodeOutcome) {
    report.set(
        "encode.frames_written",
        enc.stats.frames_written.to_string(),
    );
    report.set("encode.black_frames", enc.stats.black_frames.to_string());
    report.set("encode.quality_mode", enc.stats.quality_mode.clone());
    report.set("encode.unique_hashes", enc.stats.unique_hashes.to_string());
    report.set(
        "encode.repeated_hashes",
        enc.stats.repeated_hashes.to_string(),
    );
    report.set("encode.luma_min", format!("{:.2}", enc.stats.min_luma));
    report.set("encode.luma_max", format!("{:.2}", enc.stats.max_luma));
    report.set("encode.luma_mean", format!("{:.2}", enc.stats.mean_luma));
    report.set("encode.exit_code", format!("{:?}", enc.exit_code));
    report.set("encode.wall_s", format!("{:.3}", enc.wall_s));
    report.set("encode.raw_bytes", enc.stats.bytes_written.to_string());
    if let Some(err) = &enc.stats.write_error {
        report.set("encode.write_error", err.clone());
    }
    if enc.exit_code != Some(0) {
        report.set(
            "encode.ffmpeg_stderr",
            verify::tail(&enc.ffmpeg_stderr, 2000),
        );
    }
}

fn record_audio(report: &mut Report, audio: &wasapi::AudioOutcome) {
    report.set("audio.device_id", audio.device_id.clone());
    if let Some(mix) = &audio.mix {
        report.set("audio.mix_format", format!("{:?}", mix.kind));
        report.set("audio.mix_rate", mix.sample_rate.to_string());
        report.set("audio.mix_channels", mix.channels.to_string());
        report.set("audio.mix_bits", mix.bits.to_string());
        report.set("audio.mix_block_align", mix.block_align.to_string());
    }
    report.set("audio.frames", audio.frames.to_string());
    report.set("audio.packets", audio.packets.to_string());
    report.set("audio.silent_packets", audio.silent_packets.to_string());
    report.set("audio.pcm_bytes", audio.out_bytes.to_string());
    report.set("audio.max_amplitude", audio.max_amplitude.to_string());
    report.set("audio.nonzero_samples", audio.nonzero_samples.to_string());
    report.set("audio.duration_s", format!("{:.3}", audio.duration_s()));
    report.set("audio.wall_s", format!("{:.3}", audio.wall_s()));
    if let Some(err) = &audio.error {
        report.set("audio.error", err.clone());
    }
}
