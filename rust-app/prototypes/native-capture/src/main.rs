//! R0-05 原生媒体采集最小闭环原型（独立 Cargo 工程）。
//!
//! 一键复跑（仓库根目录）：
//! ```text
//! cargo run --release --manifest-path rust-app/prototypes/native-capture/Cargo.toml -- \
//!   --seconds 10 --fps 30 --capture gdi --audio --tone --monitor 0 --out .tmp-r0-media-native/release-av
//! ```
//!
//! 链路：GDI BitBlt（显示器/区域/窗口）采 BGRA 帧 → 有界通道 → ffmpeg stdin 编码 H.264 MP4；
//! WASAPI loopback / capture 端点（第二音源）→ 流式 WAV → ffmpeg mux 成 MP4；
//! 支持暂停/继续（媒体时钟扣除暂停时长）与合成测试音（让 loopback 有确定内容）。
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
mod env;
mod ffmpeg;
mod pause;
mod sync;
mod testwin;
mod verify;
mod wasapi;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use capture::window::WindowMethod;
use cpumon::SelfCpuCounter;
use ffmpeg::encoder_args_pretty;
use pause::{PauseController, PauseGate};
use util::{build_profile, json_escape, log};
use windows::Win32::Foundation::RECT;
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
    captureblt: bool,
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
    audio_endpoint_name: Option<String>,
    audio2: String,
    audio2_endpoint: Option<String>,
    audio2_name: Option<String>,
    audio_mix: bool,
    mux: bool,
    tone: bool,
    tone_freq: f64,
    tone_amp: f64,
    tone_endpoint: Option<String>,
    tone_endpoint_name: Option<String>,
    pause_at: Option<String>,
    pause_ms: Option<String>,
    region: Option<capture::ScreenRect>,
    window_title: Option<String>,
    window_hwnd: Option<isize>,
    window_method: WindowMethod,
    window_follow: bool,
    window_exclude: Vec<String>,
    list_audio: bool,
    scenario: Option<String>,
    scenario_visible: bool,
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
            captureblt: true,
            audio: false,
            out: PathBuf::from(DEFAULT_OUT),
            ffmpeg: PathBuf::from(DEFAULT_FFMPEG),
            // 默认采副屏：仓库 AGENTS.md 要求可见测试窗口只放副屏。
            // 本机只有主屏时显式传 --monitor 0。
            monitor: 1,
            animate: true,
            queue: 4,
            slow_consumer_ms: 0,
            fallback: true,
            codec: "libx264".to_string(),
            preset: "veryfast".to_string(),
            crf: 23,
            audio_endpoint: None,
            audio_endpoint_name: None,
            audio2: "off".to_string(),
            audio2_endpoint: None,
            audio2_name: None,
            audio_mix: false,
            mux: true,
            tone: false,
            tone_freq: 440.0,
            tone_amp: 0.02,
            tone_endpoint: None,
            tone_endpoint_name: None,
            pause_at: None,
            pause_ms: None,
            region: None,
            window_title: None,
            window_hwnd: None,
            window_method: WindowMethod::PrintWindow,
            window_follow: false,
            window_exclude: Vec::new(),
            list_audio: false,
            scenario: None,
            scenario_visible: false,
            fault_wgc_hmon: None,
            probe_wgc: false,
            help: false,
        }
    }
}

fn parse_region(value: &str) -> Result<capture::ScreenRect, String> {
    let parts: Vec<&str> = value.split(',').map(|s| s.trim()).collect();
    if parts.len() != 4 {
        return Err(format!("--region expects x,y,w,h (got {value:?})"));
    }
    let nums: Vec<i64> = parts
        .iter()
        .map(|p| p.parse::<i64>().map_err(|e| format!("--region: {e}")))
        .collect::<Result<_, _>>()?;
    if nums[2] <= 0 || nums[3] <= 0 {
        return Err("--region width/height must be > 0".to_string());
    }
    Ok(capture::ScreenRect {
        left: nums[0] as i32,
        top: nums[1] as i32,
        width: nums[2] as u32,
        height: nums[3] as u32,
    })
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
            "--no-captureblt" => cli.captureblt = false,
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
            "--audio-endpoint-name" => cli.audio_endpoint_name = Some(value!()),
            "--audio2" => cli.audio2 = value!(),
            "--audio2-endpoint" => cli.audio2_endpoint = Some(value!()),
            "--audio2-name" => cli.audio2_name = Some(value!()),
            "--audio-mix" => cli.audio_mix = true,
            "--no-mux" => cli.mux = false,
            "--tone" => cli.tone = true,
            "--tone-freq" => {
                cli.tone_freq = value!().parse().map_err(|e| format!("--tone-freq: {e}"))?
            }
            "--tone-amp" => {
                cli.tone_amp = value!().parse().map_err(|e| format!("--tone-amp: {e}"))?
            }
            "--tone-endpoint" => cli.tone_endpoint = Some(value!()),
            "--tone-endpoint-name" => cli.tone_endpoint_name = Some(value!()),
            "--pause-at" => cli.pause_at = Some(value!()),
            "--pause-ms" => cli.pause_ms = Some(value!()),
            "--region" => cli.region = Some(parse_region(&value!())?),
            "--window-title" => cli.window_title = Some(value!()),
            "--window-hwnd" => {
                let raw = value!();
                let parsed =
                    if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
                        isize::from_str_radix(hex, 16)
                    } else {
                        raw.parse::<isize>()
                    };
                cli.window_hwnd = Some(parsed.map_err(|e| format!("--window-hwnd: {e}"))?);
            }
            "--window-method" => cli.window_method = WindowMethod::parse(&value!())?,
            "--window-follow" => cli.window_follow = true,
            "--window-exclude" => cli.window_exclude.push(value!()),
            "--list-audio" => cli.list_audio = true,
            "--scenario" => cli.scenario = Some(value!()),
            "--scenario-visible" => cli.scenario_visible = true,
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
    "native-capture: R0-05 原生采集最小闭环（暂停/续录、双音源、区域/窗口、30 分钟样例）\n\
     \n\
     用法: native-capture [选项]\n\
     \n\
     采集目标（三选一；默认 --monitor 1 副屏）:\n\
       --monitor <索引>        显示器索引（0=主屏，1=副屏）\n\
       --region <x,y,w,h>      区域采集（虚拟桌面物理像素坐标，固定区域）\n\
       --window-title <子串>   窗口采集（标题不区分大小写，可配 --window-exclude 多次）\n\
       --window-hwnd <hwnd>    窗口采集（0x 十六进制或十进制 hwnd）\n\
       --window-method <screen|window-dc|printwindow>  窗口采集方法（默认 printwindow）\n\
       --window-follow         目标失效时按标题重新解析到另一窗口\n\
     \n\
     基本参数:\n\
       --seconds <秒>          采集时长（媒体时长，不含暂停），默认 10\n\
       --fps <帧率>            目标输出帧率，默认 30\n\
       --capture <auto|wgc|gdi> 后端，默认 auto（WGC 失败回退 GDI）；区域/窗口只支持 gdi\n       --no-captureblt         GDI 不使用 CAPTUREBLT（不抓分层窗口，通常更快）\n\
       --out <目录>            产物目录，默认 .tmp-r0-media-native/latest\n\
       --ffmpeg <exe>          ffmpeg 路径，默认 node_modules/ffmpeg-static/ffmpeg.exe\n\
       --no-animate            不创建测试动画窗口\n\
       --queue <帧数>          编码管道有界队列，默认 4\n\
       --slow-consumer-ms <ms> 每帧人为延迟，模拟慢盘/背压\n\
       --no-fallback           auto 模式下 WGC 失败不回退 GDI\n\
       --codec/--preset/--crf  编码参数，默认 libx264/veryfast/23\n\
     \n\
     暂停/续录:\n\
       --pause-at <s[,s...]>   媒体时间触发点（支持多个）\n\
       --pause-ms <ms[,ms...]> 每次暂停时长（单值广播到所有触发点）\n\
     \n\
     音频:\n\
       --audio                 WASAPI loopback（默认渲染端点）并 mux\n\
       --audio-endpoint <id>   loopback 指定 render 端点 ID\n\
       --audio-endpoint-name <子串> loopback 按端点名选择\n\
       --audio2 <off|auto|id>  第二音源（capture 端点：麦克风等），auto=默认采集端点\n\
       --audio2-name <子串>    第二音源按端点名选择\n\
       --audio-mix             把 loopback+第二音源混音成 audio-mix.wav 并用于 mux\n\
       --tone                  渲染合成正弦测试音（给 loopback 确定内容）\n\
       --tone-freq <Hz>        默认 440；--tone-amp <0..1> 默认 0.02\n\
       --tone-endpoint <id> / --tone-endpoint-name <子串> 指定渲染端点\n\
       --no-mux                只采音频不 mux\n\
     \n\
     诊断/场景:\n\
       --list-audio            枚举 ACTIVE render/capture 端点后退出（写 audio-endpoints.txt）\n\
       --scenario window-target 窗口目标变化场景（移动/关闭/遮挡/重切换到另一窗口）\n\
       --scenario-visible      场景窗口可见（需用户许可；默认隐藏窗口）\n\
       --probe-wgc             只探测 WGC 可用性矩阵，不采集\n\
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
    fn set(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.metrics.push((key.into(), value.into()));
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
        "[run] native-capture R0-05 profile={} pid={}",
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
    // 环境取证：工作区 ACL 若带 Low Mandatory Label，本 exe 会以 Low IL 运行（2026-11-11 发现）。
    // 每次运行都记录，便于“修复 ACL 后重验”对照。
    let integrity = env::process_integrity_level();
    logln!(
        "[env] process integrity level = {integrity} (exe={})",
        std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_default()
    );

    let mut report = Report {
        status: "failed".to_string(),
        ..Default::default()
    };
    report.set("run.profile", build_profile());
    report.set("env.integrity_level", integrity);
    report.set("run.seconds", format!("{:.3}", cli.seconds));
    report.set("run.fps", cli.fps.to_string());
    report.set("run.capture_mode", cli.capture.clone());
    report.set(
        "run.command",
        std::env::args().collect::<Vec<_>>().join(" "),
    );

    // 场景模式（窗口目标变化）：独立编排，不使用普通采集流程。
    if let Some(scenario) = cli.scenario.clone() {
        return scenario::run(&cli, &scenario, &mut report);
    }

    // 音频端点枚举（诊断模式）。
    if cli.list_audio {
        let enumeration = wasapi::enumerate_endpoints();
        wasapi::write_endpoint_report(&cli.out.join("audio-endpoints.txt"), &enumeration);
        for e in &enumeration.endpoints {
            logln!(
                "[audio-endpoint] {} name={:?} id={} default-console={} default-comm={} mix={:?}",
                e.flow,
                e.name,
                e.id,
                e.default_console,
                e.default_communications,
                e.mix
            );
        }
        for err in &enumeration.errors {
            logln!("[audio-endpoint] error: {err}");
        }
        report.set(
            "audio.endpoint_count",
            enumeration.endpoints.len().to_string(),
        );
        report.set(
            "audio.render_count",
            enumeration
                .endpoints
                .iter()
                .filter(|e| e.flow == "render")
                .count()
                .to_string(),
        );
        report.set(
            "audio.capture_count",
            enumeration
                .endpoints
                .iter()
                .filter(|e| e.flow == "capture")
                .count()
                .to_string(),
        );
        for err in &enumeration.errors {
            report.set("audio.enumerate_error", err.clone());
        }
        report.status = "probe".to_string();
        write_report(&cli.out, &report);
        return 0;
    }

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

    // 解析采集目标。--probe-wgc 只对显示器目标有意义。
    let monitor_target = monitors.get(cli.monitor).cloned();
    let target_spec: Result<capture::TargetSpec, String> = if cli.probe_wgc {
        match monitor_target.clone() {
            Some(t) => Ok(capture::TargetSpec::Monitor(t)),
            None => Err(format!(
                "--monitor {} out of range: {} display(s) found",
                cli.monitor,
                monitors.len()
            )),
        }
    } else if let Some(region) = cli.region {
        Ok(capture::TargetSpec::Region(region))
    } else if cli.window_title.is_some() || cli.window_hwnd.is_some() {
        Ok(capture::TargetSpec::Window(capture::WindowRequest {
            hwnd: cli.window_hwnd,
            title: cli.window_title.clone(),
            exclude: cli.window_exclude.clone(),
            method: cli.window_method,
            follow: cli.window_follow,
        }))
    } else {
        match monitor_target.clone() {
            Some(t) => Ok(capture::TargetSpec::Monitor(t)),
            None => Err(format!(
                "--monitor {} out of range: {} display(s) found",
                cli.monitor,
                monitors.len()
            )),
        }
    };
    let target_spec = match target_spec {
        Ok(t) => t,
        Err(e) => {
            logln!("[run] FAILED {e}");
            report.set("failure", e);
            write_report(&cli.out, &report);
            return 2;
        }
    };
    let target_description = match &target_spec {
        capture::TargetSpec::Monitor(m) => m.describe(),
        capture::TargetSpec::Region(r) => format!("region {}", r.describe()),
        capture::TargetSpec::Window(w) => format!(
            "window title={:?} hwnd={:?} method={} follow={}",
            w.title,
            w.hwnd,
            w.method.name(),
            w.follow
        ),
    };
    report.set("capture.target", target_description.clone());
    if let capture::TargetSpec::Monitor(m) = &target_spec {
        report.set("capture.monitor", m.describe());
    }

    if cli.probe_wgc {
        // 先创建可见窗口再探测：验证权限拒绝是否与“进程是否有前台窗口/能否弹出
        // 系统授权提示”有关（窗口放在目标显示器上）。
        let target = monitor_target.expect("probe-wgc requires monitor");
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

    // 1) 先解析采集后端、目标与真实输出尺寸（WGC 尺寸可能与显示器 rect 不同）。
    let resolved = match capture::resolve(
        &cli.capture,
        cli.fallback,
        target_spec,
        cli.fault_wgc_hmon,
        cli.captureblt,
    ) {
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
    report.set("capture.target_resolved", resolved.target.describe());
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
    let anim_rect: Option<RECT> = match &resolved.target {
        capture::CaptureTarget::Screen(r) => Some(RECT {
            left: r.left,
            top: r.top,
            right: r.left + r.width as i32,
            bottom: r.top + r.height as i32,
        }),
        capture::CaptureTarget::Window(w) => Some(w.initial.rect),
    };
    let anim = if cli.animate {
        match anim_rect {
            Some(rect) => match anim::AnimWindow::spawn(&rect) {
                Ok(h) => Some(h),
                Err(e) => {
                    logln!("[run] animation window failed: {e}");
                    report.set("animate.error", e);
                    None
                }
            },
            None => None,
        }
    } else {
        None
    };

    // 4) 合成测试音（可选）：先启动，让随后启动的 loopback 一定有内容可采。
    let tone_handle = if cli.tone {
        let amp = cli.tone_amp.clamp(0.0, 1.0);
        let seconds = cli.seconds.max(1.0);
        match wasapi::ToneHandle::start(
            cli.tone_endpoint
                .clone()
                .or_else(|| cli.audio_endpoint.clone()),
            cli.tone_endpoint_name
                .clone()
                .or_else(|| cli.audio_endpoint_name.clone()),
            cli.tone_freq.max(1.0),
            amp,
            seconds,
            0,
        ) {
            Ok(h) => {
                logln!(
                    "[tone] started freq={}Hz amp={} seconds={:.3}",
                    cli.tone_freq,
                    amp,
                    seconds
                );
                report.set("tone.enabled", "true");
                report.set("tone.freq_hz", format!("{:.1}", cli.tone_freq));
                report.set("tone.amplitude", format!("{amp:.4}"));
                Some(h)
            }
            Err(e) => {
                logln!("[tone] start FAILED (raw error): {e}");
                report.set("tone.error", e);
                None
            }
        }
    } else {
        None
    };
    // 让渲染流先稳定，再启动 loopback，避免音频引擎忙时首批包抖动。
    if tone_handle.is_some() {
        std::thread::sleep(Duration::from_millis(150));
    }

    // 4) 音频端点枚举（在启动测试音/音频源之前完成，避免枚举耗时打乱音频时间轴）。
    let enumeration = if cli.audio || cli.audio2 != "off" || cli.audio_endpoint_name.is_some() {
        let e = wasapi::enumerate_endpoints();
        wasapi::write_endpoint_report(&cli.out.join("audio-endpoints.txt"), &e);
        for ep in &e.endpoints {
            logln!(
                "[audio-endpoint] {} name={:?} id={} default-console={}",
                ep.flow,
                ep.name,
                ep.id,
                ep.default_console
            );
        }
        Some(e)
    } else {
        None
    };

    // 5) 合成测试音（可选）：先启动，让随后启动的 loopback 一定有内容可采。
    //    持续时间覆盖采集 + 3s 余量：虚拟设备在无活跃渲染流时 loopback 会停止出包，
    //    必须让渲染流覆盖整个采集窗口，音频时间轴才不会提前结束。
    let tone_handle = if cli.tone {
        let amp = cli.tone_amp.clamp(0.0, 1.0);
        // 覆盖采集窗口 + 大余量：渲染客户端会预写满 1s 共享缓冲后提前结束，
        // 且虚拟设备在无活跃渲染流时 loopback 停止出包；由 main 在采集结束后显式 stop。
        let seconds = (cli.seconds + 120.0).max(2.0);
        match wasapi::ToneHandle::start(
            cli.tone_endpoint
                .clone()
                .or_else(|| cli.audio_endpoint.clone()),
            cli.tone_endpoint_name
                .clone()
                .or_else(|| cli.audio_endpoint_name.clone()),
            cli.tone_freq.max(1.0),
            amp,
            seconds,
            0,
        ) {
            Ok(h) => {
                logln!(
                    "[tone] started freq={}Hz amp={} seconds={:.3}",
                    cli.tone_freq,
                    amp,
                    seconds
                );
                report.set("tone.enabled", "true");
                report.set("tone.freq_hz", format!("{:.1}", cli.tone_freq));
                report.set("tone.amplitude", format!("{amp:.4}"));
                report.set("tone.requested_seconds", format!("{seconds:.3}"));
                Some(h)
            }
            Err(e) => {
                logln!("[tone] start FAILED (raw error): {e}");
                report.set("tone.error", e);
                None
            }
        }
    } else {
        None
    };
    // 让渲染流先稳定，再启动 loopback，避免音频引擎忙时首批包抖动。
    if tone_handle.is_some() {
        std::thread::sleep(Duration::from_millis(150));
    }

    // 6) 音频源：loopback（可选）+ 第二音源（可选）。
    // 暂停调度先解析：音频线程需要同一个暂停 gate（音频包在暂停期间丢弃）。
    let pause_schedule =
        match pause::parse_schedule(cli.pause_at.as_deref(), cli.pause_ms.as_deref()) {
            Ok(s) => s,
            Err(e) => {
                logln!("[run] FAILED pause schedule: {e}");
                report.set("pause.schedule_error", e);
                write_report(&cli.out, &report);
                return 2;
            }
        };
    let pause_gate = PauseGate::default();
    let pause_gate_arg = if pause_schedule.is_empty() {
        None
    } else {
        logln!("[pause] schedule: {:?}", pause_schedule);
        report.set("pause.schedule", format!("{pause_schedule:?}"));
        Some(pause_gate.clone())
    };
    let short_audio = cli.seconds <= 120.0;
    let loopback_handle = if cli.audio {
        let mut spec =
            wasapi::AudioSourceSpec::loopback(Some(cli.out.join("audio.wav")), short_audio);
        spec.endpoint_id = cli.audio_endpoint.clone();
        spec.endpoint_name_hint = cli.audio_endpoint_name.clone();
        match wasapi::AudioHandle::start(spec, pause_gate_arg.clone()) {
            Ok(h) => {
                logln!("[audio] loopback started at {:?}", h.start_instant());
                Some(h)
            }
            Err(e) => {
                logln!("[audio] loopback start FAILED (raw error): {e}");
                report.set("audio.start_error", e);
                None
            }
        }
    } else {
        None
    };
    let audio2_handle = if cli.audio2 != "off" {
        let mut spec =
            wasapi::AudioSourceSpec::second_source(Some(cli.out.join("audio2.wav")), short_audio);
        let chosen = if let Some(id) = &cli.audio2_endpoint {
            Some((id.clone(), String::new()))
        } else if cli.audio2 != "auto" {
            // --audio2 直接给端点 ID。
            Some((cli.audio2.clone(), String::new()))
        } else if let Some(e) = enumeration.as_ref() {
            if let Some(hint) = &cli.audio2_name {
                e.endpoints
                    .iter()
                    .find(|x| {
                        x.flow == "capture" && x.name.to_lowercase().contains(&hint.to_lowercase())
                    })
                    .map(|x| (x.id.clone(), x.name.clone()))
            } else {
                wasapi::choose_second_source_endpoint(e).map(|x| (x.id.clone(), x.name.clone()))
            }
        } else {
            None
        };
        match chosen {
            Some((id, name)) => {
                let name = if name.is_empty() {
                    enumeration
                        .as_ref()
                        .and_then(|e| e.endpoints.iter().find(|x| x.id == id))
                        .map(|x| x.name.clone())
                        .unwrap_or_default()
                } else {
                    name
                };
                logln!("[audio2] second source endpoint id={id} name={name:?}");
                report.set("audio2.endpoint_id", id.clone());
                report.set("audio2.endpoint_name", name);
                spec.endpoint_id = Some(id);
                match wasapi::AudioHandle::start(spec, pause_gate_arg.clone()) {
                    Ok(h) => Some(h),
                    Err(e) => {
                        logln!("[audio2] start FAILED (raw error): {e}");
                        report.set("audio2.start_error", e);
                        None
                    }
                }
            }
            None => {
                let msg = if cli.audio2 == "auto" {
                    "no ACTIVE capture endpoint found for --audio2 auto".to_string()
                } else {
                    format!("--audio2-endpoint {:?} not usable", cli.audio2)
                };
                logln!("[audio2] {msg}");
                report.set("audio2.unavailable", msg);
                None
            }
        }
    } else {
        None
    };
    if let Some(t) = loopback_handle.as_ref().and_then(|h| h.start_instant()) {
        report.set("audio.start_offset_from_capture", "measured-after-capture");
        logln!("[audio] loopback started at {t:?}");
    }
    let tone_start_instant = tone_handle.as_ref().and_then(|h| h.start_instant);

    // 6) 采集（含暂停控制）。
    let self_cpu = SelfCpuCounter::start();
    let run_start = Instant::now();
    let capture_t0 = Instant::now();
    let pause_ctrl = if pause_schedule.is_empty() {
        None
    } else {
        Some(PauseController::new(
            pause_schedule,
            capture_t0,
            pause_gate.clone(),
        ))
    };
    let capture_result = capture::run(
        resolved,
        cli.seconds,
        cli.fps,
        10,
        encoder.sender(),
        capture_t0,
        pause_ctrl.clone(),
        cli.fault_wgc_hmon,
    );
    let capture_run = match capture_result {
        Ok(run) => run,
        Err(e) => {
            logln!("[run] capture FAILED (raw error): {e}");
            report.set("capture.error", e);
            if let Some(anim) = anim {
                anim.close();
            }
            if let Some(t) = tone_handle {
                let tone = t.stop();
                record_tone(&mut report, &tone);
            }
            if let Some(handle) = loopback_handle {
                let audio = handle.stop();
                record_audio_source(&mut report, "audio", &audio);
            }
            if let Some(handle) = audio2_handle {
                let audio = handle.stop();
                record_audio_source(&mut report, "audio2", &audio);
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

    // 采集结束后先停动画窗口，再停音频源（音频覆盖同一墙钟窗口 + tail），最后停测试音。
    if let Some(anim) = anim {
        anim.close();
    }
    let loopback_out = loopback_handle.map(|h| h.stop());
    let audio2_out = audio2_handle.map(|h| h.stop());
    if let Some(t) = tone_handle {
        let tone = t.stop();
        record_tone(&mut report, &tone);
    }

    let capture_wall = capture_run.stats.wall_s();
    report.set("capture.real_backend", capture_run.backend);
    report.set(
        "capture.target_description",
        capture_run.target_description.clone(),
    );
    record_capture(&mut report, &capture_run);
    logln!(
        "[capture] backend={} wall={:.3}s media={:.3}s paused={:.3}s",
        capture_run.backend,
        capture_wall,
        capture_run.stats.media_s(),
        capture_run.stats.paused_total_s
    );
    // 暂停窗口证据（补槽位连续性）。
    if let Some(p) = &pause_ctrl {
        let mut windows = p.windows();
        let deltas = &capture_run.stats.pause_resume_deltas;
        for (i, d) in deltas.iter().enumerate() {
            if let Some(w) = windows.get_mut(i) {
                w.resume_slot_delta = Some(*d);
                w.first_slot_after = w.last_slot_before.map(|l| (l as i64 + *d).max(0) as u64);
            }
        }
        pause::write_windows(
            &cli.out.join("pause-windows.txt"),
            &windows,
            capture_run.stats.paused_total_s,
        );
        report.set("pause.windows", windows.len().to_string());
        report.set(
            "pause.paused_total_s",
            format!("{:.3}", capture_run.stats.paused_total_s),
        );
        report.set(
            "pause.media_duration_s",
            format!("{:.3}", capture_run.stats.media_s()),
        );
        if let Some(first) = windows.first() {
            let d = first.resume_slot_delta.unwrap_or(-1);
            report.set("pause.first_resume_slot_delta", d.to_string());
        }
    }
    // 窗口目标证据。
    if let Some(win) = &capture_run.window {
        let mut text = String::new();
        text.push_str(&format!("initial={}\n", win.initial));
        text.push_str(&format!("method={}\n", cli.window_method.name()));
        for (t, ev) in &win.events {
            text.push_str(&format!("{t:.3}\t{ev}\n"));
        }
        text.push_str(&format!(
            "grabs={} failures={} invalid_events={} retargets={} moves={} size_changes={} visibility_changes={} printwindow_calls={} printwindow_failures={} wm_print_fallbacks={} black_frames={}\n",
            win.stats.grabs,
            win.stats.failures,
            win.stats.invalid_events,
            win.stats.retargets,
            win.stats.moves,
            win.stats.size_changes,
            win.stats.visibility_changes,
            win.stats.printwindow_calls,
            win.stats.printwindow_failures,
            win.stats.wm_print_fallbacks,
            win.stats.black_frames
        ));
        let _ = std::fs::write(cli.out.join("window-events.txt"), &text);
        report.set("window.grabs", win.stats.grabs.to_string());
        report.set("window.failures", win.stats.failures.to_string());
        report.set("window.retargets", win.stats.retargets.to_string());
        report.set("window.moves", win.stats.moves.to_string());
        report.set("window.size_changes", win.stats.size_changes.to_string());
        report.set(
            "window.invalid_events",
            win.stats.invalid_events.to_string(),
        );
        report.set(
            "window.printwindow_failures",
            win.stats.printwindow_failures.to_string(),
        );
        report.set(
            "window.wm_print_fallbacks",
            win.stats.wm_print_fallbacks.to_string(),
        );
        report.set("window.black_frames", win.stats.black_frames.to_string());
        report.set("window.events", win.events.len().to_string());
    }

    // 7) 收尾编码，记录 ffmpeg 原始错误。
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

    // 8) 视频产物验证。
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
        // 输出帧时间轴连续性（暂停/长录的关键证据）。
        match verify::packet_pts(&cli.ffmpeg, &video_path, "0:v:0") {
            Ok(pts) => {
                let check = verify::timeline_check(&pts, cli.fps as f64);
                let _ = std::fs::write(
                    cli.out.join("video-timeline.txt"),
                    format!(
                        "packets={}\nfirst_pts_s={:.6}\nlast_pts_s={:.6}\nspan_s={:.6}\nexpected_frames={}\nmissing_slots={}\nmax_gap_ms={:.3}\nmedian_gap_ms={:.3}\nnonuniform_steps={}\nreordered_steps={}\neffective_fps={:.4}\n",
                        check.packets,
                        check.first_pts_s,
                        check.last_pts_s,
                        check.span_s,
                        check.expected_frames,
                        check.missing_slots,
                        check.max_gap_ms,
                        check.median_gap_ms,
                        check.nonuniform_steps,
                        check.reordered_steps,
                        check.effective_fps
                    ),
                );
                report.set("video.timeline_packets", check.packets.to_string());
                report.set("video.timeline_span_s", format!("{:.3}", check.span_s));
                report.set(
                    "video.timeline_expected_frames",
                    check.expected_frames.to_string(),
                );
                report.set(
                    "video.timeline_missing_slots",
                    check.missing_slots.to_string(),
                );
                report.set(
                    "video.timeline_max_gap_ms",
                    format!("{:.3}", check.max_gap_ms),
                );
                report.set(
                    "video.timeline_median_gap_ms",
                    format!("{:.3}", check.median_gap_ms),
                );
                report.set(
                    "video.timeline_nonuniform_steps",
                    check.nonuniform_steps.to_string(),
                );
                report.set(
                    "video.timeline_reordered_steps",
                    check.reordered_steps.to_string(),
                );
                report.set(
                    "video.timeline_effective_fps",
                    format!("{:.4}", check.effective_fps),
                );
                logln!(
                    "[verify] video timeline: packets={} span={:.3}s missing_slots={} max_gap={:.1}ms effective_fps={:.3}",
                    check.packets,
                    check.span_s,
                    check.missing_slots,
                    check.max_gap_ms,
                    check.effective_fps
                );
            }
            Err(e) => {
                logln!("[verify] video timeline FAILED: {e}");
                report.set("verify.timeline.error", e);
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

    // 9) 音频验证（loopback + 第二音源）+ 双路对齐分析。
    let mut audio_ok = false;
    let mut mix_info: Option<wasapi::AudioOutcome> = None;
    if let Some(audio) = &loopback_out {
        record_audio_source(&mut report, "audio", audio);
        verify_audio_wav(&cli, &mut report, "audio", audio);
        if audio.error.is_none() && audio.wav_bytes > 44 {
            audio_ok = true;
        }
        // 合成音起点：音频时间轴的已知标记（tone 在 loopback 之前启动时，WAV 起点即目标音）。
        if let (Some(tone), Some(audio_start)) = (tone_start_instant, audio.start_instant) {
            let tone_before_ms = audio_start
                .checked_duration_since(tone)
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            let tone_after_ms = tone
                .checked_duration_since(audio_start)
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            report.set(
                "audio.tone_started_before_audio_ms",
                format!("{tone_before_ms:.2}"),
            );
            report.set(
                "audio.tone_started_after_audio_ms",
                format!("{tone_after_ms:.2}"),
            );
            if !audio.pcm.is_empty() {
                let threshold = (audio.max_amplitude / 4).max(2);
                if let Some(mix) = &audio.mix {
                    if let Some(onset_ms) = sync::detect_onset_ms(
                        &audio.pcm,
                        mix.channels.min(2) as usize,
                        mix.sample_rate,
                        threshold,
                    ) {
                        // 期望起点：tone 晚于 loopback 时是差值；早于 loopback 时 WAV 起点即非静音（0ms）。
                        let expected = tone_after_ms;
                        report.set("audio.tone_onset_ms", format!("{onset_ms:.2}"));
                        report.set("audio.tone_expected_onset_ms", format!("{expected:.2}"));
                        report.set(
                            "audio.tone_onset_delta_ms",
                            format!("{:.2}", onset_ms - expected),
                        );
                        logln!(
                            "[audio] tone onset measured={onset_ms:.2}ms expected={expected:.2}ms delta={:.2}ms (tone before audio {tone_before_ms:.2}ms)",
                            onset_ms - expected
                        );
                    }
                }
            }
        }
    }
    if let Some(audio) = &audio2_out {
        record_audio_source(&mut report, "audio2", audio);
        verify_audio_wav(&cli, &mut report, "audio2", audio);
        if audio.error.is_some() {
            report.set("audio2.usable", "false");
        } else {
            report.set("audio2.usable", "true");
        }
        // 双路对齐：两路都含同一测试音时用互相关测量第二路相对 loopback 的延迟。
        // 前提：第二路必须能拾到与 loopback 相同的声音（本机麦克风拾音/共享声学路径待验证）。
        if let (Some(lb), Some(mix_lb), Some(mix2)) = (
            &loopback_out,
            loopback_out.as_ref().and_then(|a| a.mix),
            audio.mix,
        ) {
            if !lb.pcm.is_empty() && !audio.pcm.is_empty() && mix_lb.sample_rate == mix2.sample_rate
            {
                let channels = mix_lb.channels.min(2) as usize;
                let (lb_peak, lb_rms, lb_nz) = sync::levels(&lb.pcm);
                let (sec_peak, sec_rms, sec_nz) = sync::levels(&audio.pcm);
                report.set("sync.loopback_peak", lb_peak.to_string());
                report.set("sync.loopback_rms", format!("{lb_rms:.1}"));
                report.set("sync.loopback_nonzero", lb_nz.to_string());
                report.set("sync.second_peak", sec_peak.to_string());
                report.set("sync.second_rms", format!("{sec_rms:.1}"));
                report.set("sync.second_nonzero", sec_nz.to_string());
                if sec_peak == 0 {
                    report.set("sync.unavailable", "second source is all-zero (silent)");
                    logln!("[sync] second source is all-zero; cross-correlation skipped");
                } else if let Some(lag) = sync::measure_lag(
                    &lb.pcm,
                    &audio.pcm,
                    channels,
                    mix_lb.sample_rate,
                    500.0,
                    4.0,
                ) {
                    report.set("sync.lag_ms", format!("{:.3}", lag.lag_ms));
                    report.set("sync.correlation", format!("{:.4}", lag.correlation));
                    report.set("sync.samples", lag.samples.to_string());
                    report.set("sync.downsample", lag.downsample.to_string());
                    if lag.correlation < 0.10 {
                        report.set("sync.weak", "correlation < 0.10: no shared acoustic source");
                    }
                    logln!(
                        "[sync] second source lag={:.3}ms correlation={:.4} (window {} samples @ {}Hz)",
                        lag.lag_ms,
                        lag.correlation,
                        lag.samples,
                        lag.sample_rate
                    );
                } else {
                    report.set(
                        "sync.unavailable",
                        "no usable correlation peak (degenerate input)",
                    );
                    logln!("[sync] no usable correlation peak (degenerate input)");
                }
            } else {
                report.set(
                    "sync.unavailable",
                    "sources differ in rate or PCM missing (short-run analysis only)",
                );
            }
        }
        // 混音（短录，内存内完成）。
        if cli.audio_mix {
            if let (Some(lb), Some(mix_lb)) =
                (&loopback_out, loopback_out.as_ref().and_then(|a| a.mix))
            {
                if !lb.pcm.is_empty() && !audio.pcm.is_empty() {
                    let (rate, ch, a_pcm, b_pcm) =
                        if mix_lb.sample_rate == audio.mix.map(|m| m.sample_rate).unwrap_or(0) {
                            (
                                mix_lb.sample_rate,
                                mix_lb.channels.min(2),
                                lb.pcm.clone(),
                                audio.pcm.clone(),
                            )
                        } else {
                            let m2 = audio.mix.unwrap();
                            let resampled = wasapi::resample_linear(
                                &audio.pcm,
                                m2.channels.min(2),
                                m2.sample_rate,
                                mix_lb.sample_rate,
                            );
                            report.set("mix.resampled_second", "true");
                            logln!(
                                "[mix] second source rate {} != loopback {}; linear resample",
                                m2.sample_rate,
                                mix_lb.sample_rate
                            );
                            (
                                mix_lb.sample_rate,
                                mix_lb.channels.min(2),
                                lb.pcm.clone(),
                                resampled,
                            )
                        };
                    let (mixed, clipped, peak) = wasapi::mix_pcm(&a_pcm, &b_pcm);
                    match wasapi::write_wav(&cli.out.join("audio-mix.wav"), rate, ch, &mixed) {
                        Ok(bytes) => {
                            report.set("mix.wav_bytes", bytes.to_string());
                            report.set("mix.clipped_samples", clipped.to_string());
                            report.set("mix.peak", peak.to_string());
                            report.set("mix.rate", rate.to_string());
                            report.set("mix.channels", ch.to_string());
                            mix_info = Some(wasapi::AudioOutcome {
                                label: "mix".to_string(),
                                kind: "mix(loopback+second)",
                                mix: Some(wasapi::MixFormat {
                                    kind: wasapi::SampleKind::I16,
                                    channels: ch,
                                    sample_rate: rate,
                                    block_align: ch * 2,
                                    bits: 16,
                                    tag: 1,
                                }),
                                frames: mixed.len() as u64 / (ch as u64 * 2),
                                out_bytes: mixed.len() as u64,
                                wav_bytes: bytes,
                                ..Default::default()
                            });
                            logln!(
                                "[mix] wrote audio-mix.wav bytes={bytes} clipped={clipped} peak={peak}"
                            );
                        }
                        Err(e) => {
                            logln!("[mix] write FAILED (raw error): {e}");
                            report.set("mix.error", e);
                        }
                    }
                } else {
                    logln!("[mix] skipped: one source has no PCM (short-run analysis only, --seconds <= 120 required)");
                    report.set("mix.skipped", "one source has no PCM or --seconds > 120");
                }
            }
        }
    }

    // 10) A/V mux 与偏差测量。
    let mut mux_ok = false;
    let mux_audio_path: Option<PathBuf> = if mix_info.is_some() {
        Some(cli.out.join("audio-mix.wav"))
    } else if loopback_out
        .as_ref()
        .map(|a| a.wav_bytes > 44)
        .unwrap_or(false)
    {
        Some(cli.out.join("audio.wav"))
    } else {
        None
    };
    if cli.mux && encode_ok {
        if let (Some(audio_path), Some(loopback)) = (&mux_audio_path, &loopback_out) {
            let (audio_lead_s, first_frame) =
                match (capture_run.stats.first_frame, loopback.start_instant) {
                    (Some(vf), Some(a0)) => ((vf - a0).as_secs_f64(), Some(vf)),
                    _ => (0.0, None),
                };
            report.set("av.capture_audio_lead_s", format!("{audio_lead_s:.4}"));
            if let Some(t) = first_frame {
                logln!("[av] first video frame at {t:?}; audio lead={audio_lead_s:.4}s");
            }
            let muxed_path = cli.out.join("capture.mp4");
            match ffmpeg::mux_av(
                &cli.ffmpeg,
                &video_path,
                audio_path,
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
                                        format!(
                                            "{} {}x{} {:.3}fps",
                                            v.codec, v.width, v.height, v.fps
                                        ),
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
                        if let Ok(vend) =
                            verify::stream_end_progress(&cli.ffmpeg, &muxed_path, "0:v:0")
                        {
                            report.set("av.video_end_progress_s", format!("{vend:.4}"));
                        }
                        if let Ok(aend) =
                            verify::stream_end_progress(&cli.ffmpeg, &muxed_path, "0:a:0")
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
    }

    // 11) CPU / 时间汇总。
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
    let audio2_requested = cli.audio2 != "off";
    let audio2_captured = audio2_out.is_some();
    let audio_ok_final = audio_ok;
    let base_ok = encode_ok && video_ok;
    report.status = if base_ok
        && (!audio_requested || (audio_ok_final && mux_ok))
        && (!audio2_requested || audio2_captured)
    {
        "ok".to_string()
    } else if base_ok {
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
    report.set("capture.media_s", format!("{:.3}", s.media_s()));
    report.set("capture.paused_total_s", format!("{:.3}", s.paused_total_s));
    report.set("capture.pause_windows", s.pause_windows.to_string());
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

fn record_tone(report: &mut Report, tone: &wasapi::ToneOutcome) {
    report.set("tone.endpoint_id", tone.endpoint_id.clone());
    report.set("tone.endpoint_name", tone.endpoint_name.clone());
    report.set("tone.frames_written", tone.frames_written.to_string());
    report.set("tone.duration_s", format!("{:.3}", tone.duration_s));
    if let Some(mix) = &tone.mix {
        report.set("tone.mix_rate", mix.sample_rate.to_string());
        report.set("tone.mix_channels", mix.channels.to_string());
        report.set("tone.mix_kind", mix.kind.name().to_string());
    }
    if let Some(err) = &tone.error {
        report.set("tone.render_error", err.clone());
    }
}

fn record_audio_source(report: &mut Report, prefix: &str, audio: &wasapi::AudioOutcome) {
    report.set(format!("{prefix}.label"), audio.label.clone());
    report.set(format!("{prefix}.kind"), audio.kind.to_string());
    report.set(format!("{prefix}.device_id"), audio.device_id.clone());
    report.set(format!("{prefix}.device_name"), audio.device_name.clone());
    if let Some(mix) = &audio.mix {
        report.set(format!("{prefix}.mix_format"), format!("{:?}", mix.kind));
        report.set(format!("{prefix}.mix_rate"), mix.sample_rate.to_string());
        report.set(format!("{prefix}.mix_channels"), mix.channels.to_string());
        report.set(format!("{prefix}.mix_bits"), mix.bits.to_string());
        report.set(
            format!("{prefix}.mix_block_align"),
            mix.block_align.to_string(),
        );
    }
    report.set(format!("{prefix}.frames"), audio.frames.to_string());
    report.set(format!("{prefix}.packets"), audio.packets.to_string());
    report.set(
        format!("{prefix}.silent_packets"),
        audio.silent_packets.to_string(),
    );
    report.set(
        format!("{prefix}.discarded_paused_frames"),
        audio.discarded_paused_frames.to_string(),
    );
    report.set(
        format!("{prefix}.pause_windows_seen"),
        audio.pause_windows_seen.to_string(),
    );
    report.set(format!("{prefix}.pcm_bytes"), audio.out_bytes.to_string());
    report.set(format!("{prefix}.wav_bytes"), audio.wav_bytes.to_string());
    report.set(
        format!("{prefix}.max_amplitude"),
        audio.max_amplitude.to_string(),
    );
    report.set(
        format!("{prefix}.nonzero_samples"),
        audio.nonzero_samples.to_string(),
    );
    report.set(
        format!("{prefix}.duration_s"),
        format!("{:.3}", audio.duration_s()),
    );
    report.set(format!("{prefix}.wall_s"), format!("{:.3}", audio.wall_s()));
    report.set(
        format!("{prefix}.first_packet_offset_s"),
        format!("{:.3}", audio.first_packet_offset_s),
    );
    report.set(
        format!("{prefix}.last_packet_offset_s"),
        format!("{:.3}", audio.last_packet_offset_s),
    );
    report.set(
        format!("{prefix}.max_packet_gap_ms"),
        format!("{:.2}", audio.max_packet_gap_ms),
    );
    if let Some(err) = &audio.error {
        report.set(format!("{prefix}.error"), err.clone());
    }
}

fn verify_audio_wav(cli: &Cli, report: &mut Report, prefix: &str, _audio: &wasapi::AudioOutcome) {
    let path = cli.out.join(format!("{prefix}.wav"));
    if !path.exists() {
        report.set(format!("{prefix}.wav_missing"), "true");
        logln!("[verify] {prefix}.wav missing: {}", path.display());
        return;
    }
    match verify::probe(&cli.ffmpeg, &path) {
        Ok(p) => {
            let _ = std::fs::write(cli.out.join(format!("probe-{prefix}.txt")), &p.raw);
            if let Some(a) = &p.audio {
                logln!("[verify] {prefix}.wav stream: {}", a.raw);
                report.set(
                    format!("{prefix}.probe_sample_rate"),
                    a.sample_rate.to_string(),
                );
                report.set(format!("{prefix}.probe_channels"), a.channels.clone());
            }
            report.set(
                format!("{prefix}.probe_duration_s"),
                p.duration_s.map(|d| format!("{d:.3}")).unwrap_or_default(),
            );
        }
        Err(e) => {
            logln!("[verify] {prefix}.wav probe FAILED: {e}");
            report.set(format!("{prefix}.verify_error"), e);
        }
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

/// 窗口目标变化场景：自建测试窗口，按时间线移动/遮挡/关闭/重解析目标窗口，
// 三种窗口采集方法各跑一遍，落盘窗口事件、时间轴与可解码证据。
mod scenario {
    use super::*;
    use std::time::Duration;

    const FPS: u32 = 30;
    const MAX_FILL: u64 = 10;

    pub fn run(cli: &Cli, scenario: &str, report: &mut Report) -> i32 {
        if scenario != "window-target" {
            logln!("[scenario] unknown scenario {scenario:?} (expected window-target)");
            report.set("scenario.error", format!("unknown scenario {scenario:?}"));
            write_report(&cli.out, report);
            return 2;
        }
        let methods = [
            WindowMethod::PrintWindow,
            WindowMethod::WindowDc,
            WindowMethod::Screen,
        ];
        let mut failures = 0usize;
        report.set("scenario.name", "window-target");
        report.set("scenario.visible", cli.scenario_visible.to_string());
        report.set("scenario.methods", "printwindow,window-dc,screen");
        for method in methods {
            let out = cli.out.join(method.name());
            let _ = std::fs::create_dir_all(&out);
            match run_one(cli, method, &out) {
                Ok(sub) => {
                    let status = sub
                        .iter()
                        .find(|(k, _)| k == "status")
                        .map(|(_, v)| v.clone())
                        .unwrap_or_else(|| "unknown".to_string());
                    if status != "ok" {
                        failures += 1;
                    }
                    report.set(format!("scenario.{}.status", method.name()), status);
                    for (k, v) in sub {
                        report.set(format!("scenario.{}.{}", method.name(), k), v);
                    }
                }
                Err(e) => {
                    failures += 1;
                    logln!("[scenario] {} FAILED (raw error): {e}", method.name());
                    report.set(format!("scenario.{}.error", method.name()), e);
                }
            }
        }
        report.status = if failures == 0 {
            "ok".to_string()
        } else {
            "partial".to_string()
        };
        logln!("[scenario] STATUS={}", report.status);
        write_report(&cli.out, report);
        if failures == 0 {
            0
        } else {
            1
        }
    }

    /// 单项方法场景：约 7.5s（隐藏）或 9.5s（可见 + 遮挡）。
    #[allow(clippy::type_complexity)]
    fn run_one(
        cli: &Cli,
        method: WindowMethod,
        out: &Path,
    ) -> Result<Vec<(String, String)>, String> {
        let mut metrics: Vec<(String, String)> = Vec::new();
        let visible = cli.scenario_visible;
        let pid = std::process::id();
        let title_a = format!("HLCAP-A-{pid}");
        let title_b = format!("HLCAP-B-{pid}");
        let title_cover = format!("HLCAP-COVER-{pid}");
        let window_w = 640i32;
        let window_h = 360i32;
        let a = testwin::TestWindow::spawn(&testwin::TestWindowSpec {
            title: title_a.clone(),
            x: 120,
            y: 120,
            width: window_w,
            height: window_h,
            visible,
        })?;
        let request = capture::WindowRequest {
            hwnd: None,
            title: Some("HLCAP".to_string()),
            exclude: vec!["COVER".to_string()],
            method,
            follow: true,
        };
        let resolved = capture::resolve(
            "gdi",
            true,
            capture::TargetSpec::Window(request),
            None,
            true,
        )?;
        let video_path = out.join("video.mp4");
        let keyint = FPS * 2;
        let encoder = ffmpeg::spawn_video_encoder(
            &cli.ffmpeg,
            &video_path,
            resolved.width,
            resolved.height,
            FPS,
            "libx264",
            "veryfast",
            23,
            keyint,
            cli.queue,
            0,
        )?;
        let seconds = if visible { 9.5 } else { 7.5 };
        let t0 = Instant::now();
        let tx = encoder.sender();
        let handle = std::thread::Builder::new()
            .name("scenario-capture".into())
            .spawn(move || capture::run(resolved, seconds, FPS, MAX_FILL, tx, t0, None, None))
            .map_err(|e| format!("spawn scenario capture failed: {e}"))?;
        // 编排时间线（相对 t0）。`ctx` 持有覆盖窗口/重定向窗口，收尾统一关闭。
        #[derive(Default)]
        struct ScenarioCtx {
            cover: Option<testwin::TestWindow>,
            retarget: Option<testwin::TestWindow>,
        }
        let mut actions: Vec<(
            f64,
            Box<dyn Fn(&mut ScenarioCtx, &testwin::TestWindow) + Send>,
        )> = Vec::new();
        // A 移动（所有方法）。
        actions.push((
            2.0,
            Box::new(|_ctx: &mut ScenarioCtx, a: &testwin::TestWindow| {
                a.move_to(340, 240);
            }),
        ));
        if visible {
            // 可见模式：用覆盖窗口制造遮挡（screen 应采到遮挡物，printwindow/window-dc 应采到 A）。
            actions.push((
                3.2,
                Box::new(move |ctx: &mut ScenarioCtx, a: &testwin::TestWindow| {
                    let rect = a.rect().unwrap_or_default();
                    let cover = testwin::TestWindow::spawn(&testwin::TestWindowSpec {
                        title: title_cover.clone(),
                        x: rect.left + 40,
                        y: rect.top + 40,
                        width: window_w,
                        height: window_h,
                        visible: true,
                    });
                    match cover {
                        Ok(c) => {
                            logln!("[scenario] cover window spawned");
                            // 暂存覆盖窗口，5.0s 时关闭。
                            ctx.cover = Some(c);
                        }
                        Err(e) => logln!("[scenario] cover window failed: {e}"),
                    }
                }),
            ));
            actions.push((
                5.0,
                Box::new(|ctx: &mut ScenarioCtx, _a: &testwin::TestWindow| {
                    if let Some(c) = ctx.cover.take() {
                        c.close();
                        logln!("[scenario] cover window closed");
                    }
                }),
            ));
        }
        // A 关闭。
        actions.push((
            if visible { 5.8 } else { 3.5 },
            Box::new(|_ctx: &mut ScenarioCtx, a: &testwin::TestWindow| {
                logln!("[scenario] closing target window A");
                // 通过 HWND 直接 PostMessage 关闭（a 的拥有权在调用方）。
                unsafe {
                    let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                        Some(windows::Win32::Foundation::HWND(
                            a.hwnd() as *mut core::ffi::c_void
                        )),
                        windows::Win32::UI::WindowsAndMessaging::WM_CLOSE,
                        windows::Win32::Foundation::WPARAM(0),
                        windows::Win32::Foundation::LPARAM(0),
                    );
                }
            }),
        ));
        // 重新出现目标窗口 B（follow 应按标题 "HLCAP" 重解析）。
        actions.push((
            if visible { 6.6 } else { 4.5 },
            Box::new(move |ctx: &mut ScenarioCtx, _a: &testwin::TestWindow| {
                match testwin::TestWindow::spawn(&testwin::TestWindowSpec {
                    title: title_b.clone(),
                    x: 200,
                    y: 160,
                    width: window_w,
                    height: window_h,
                    visible,
                }) {
                    Ok(w) => {
                        logln!("[scenario] retarget window B spawned");
                        // B 保持到采集结束；借用槽位在收尾时关闭。
                        ctx.retarget = Some(w);
                    }
                    Err(e) => logln!("[scenario] window B failed: {e}"),
                }
            }),
        ));
        let mut ctx = ScenarioCtx::default();
        // 主线程按时间线执行动作；注意闭包借用规则的简化：A 由外部持有，动作只读 A。
        let start = Instant::now();
        let mut idx = 0usize;
        while idx < actions.len() {
            let wait = t0 + Duration::from_secs_f64(actions[idx].0);
            let now = Instant::now();
            if wait > now {
                std::thread::sleep(wait - now);
            }
            if start.elapsed().as_secs_f64() > seconds {
                break;
            }
            let action = &actions[idx].1;
            action(&mut ctx, &a);
            idx += 1;
        }
        if let Some(c) = ctx.cover.take() {
            c.close();
        }
        let run = handle
            .join()
            .map_err(|_| "scenario capture thread panicked".to_string())??;
        // 采集结束后再关闭重解析出的目标窗口，保证“切换到另一窗口”的采集窗口完整。
        if let Some(r) = ctx.retarget.take() {
            r.close();
        }
        let enc = encoder.finish();
        // A 已关闭；关闭句柄带来的 join 可能已结束，忽略。
        metrics.push((
            "encode.exit_code".to_string(),
            format!("{:?}", enc.exit_code),
        ));
        metrics.push((
            "encode.frames_written".to_string(),
            enc.stats.frames_written.to_string(),
        ));
        metrics.push((
            "capture.written_frames".to_string(),
            run.stats.written.to_string(),
        ));
        metrics.push((
            "capture.delivered_frames".to_string(),
            run.stats.delivered.to_string(),
        ));
        metrics.push((
            "capture.media_s".to_string(),
            format!("{:.3}", run.stats.media_s()),
        ));
        if let Some(win) = &run.window {
            let mut text = format!("initial={}\nmethod={}\n", win.initial, method.name());
            for (t, ev) in &win.events {
                text.push_str(&format!("{t:.3}\t{ev}\n"));
            }
            text.push_str(&format!(
                "grabs={} failures={} invalid_events={} retargets={} moves={} size_changes={} visibility_changes={} printwindow_calls={} printwindow_failures={} wm_print_fallbacks={} black_frames={}\n",
                win.stats.grabs,
                win.stats.failures,
                win.stats.invalid_events,
                win.stats.retargets,
                win.stats.moves,
                win.stats.size_changes,
                win.stats.visibility_changes,
                win.stats.printwindow_calls,
                win.stats.printwindow_failures,
                win.stats.wm_print_fallbacks,
                win.stats.black_frames
            ));
            let _ = std::fs::write(out.join("window-events.txt"), text);
            metrics.push(("window.grabs".to_string(), win.stats.grabs.to_string()));
            metrics.push((
                "window.invalid_events".to_string(),
                win.stats.invalid_events.to_string(),
            ));
            metrics.push((
                "window.retargets".to_string(),
                win.stats.retargets.to_string(),
            ));
            metrics.push(("window.moves".to_string(), win.stats.moves.to_string()));
            metrics.push((
                "window.printwindow_failures".to_string(),
                win.stats.printwindow_failures.to_string(),
            ));
            metrics.push((
                "window.wm_print_fallbacks".to_string(),
                win.stats.wm_print_fallbacks.to_string(),
            ));
            metrics.push((
                "window.black_frames".to_string(),
                win.stats.black_frames.to_string(),
            ));
            metrics.push(("window.events".to_string(), win.events.len().to_string()));
        }
        // 产物验证。
        let mut status = "failed";
        let mut video_duration: Option<f64> = None;
        if video_path.exists() {
            metrics.push((
                "video.size_bytes".to_string(),
                ffmpeg::file_size(&video_path).to_string(),
            ));
            if let Ok(p) = verify::probe(&cli.ffmpeg, &video_path) {
                let _ = std::fs::write(out.join("probe-video.txt"), &p.raw);
                video_duration = p.duration_s;
                metrics.push((
                    "video.duration_s".to_string(),
                    p.duration_s.map(|d| format!("{d:.3}")).unwrap_or_default(),
                ));
            }
            if let Ok(pts) = verify::packet_pts(&cli.ffmpeg, &video_path, "0:v:0") {
                let check = verify::timeline_check(&pts, FPS as f64);
                metrics.push(("video.packets".to_string(), check.packets.to_string()));
                metrics.push((
                    "video.missing_slots".to_string(),
                    check.missing_slots.to_string(),
                ));
                metrics.push((
                    "video.effective_fps".to_string(),
                    format!("{:.3}", check.effective_fps),
                ));
            }
            match verify::decode_check(&cli.ffmpeg, &video_path) {
                Ok((code, _)) => {
                    metrics.push(("video.decode_exit".to_string(), code.to_string()));
                    status = if enc.exit_code == Some(0) && code == 0 {
                        "ok"
                    } else {
                        "partial"
                    };
                }
                Err(e) => metrics.push(("video.decode_error".to_string(), e)),
            }
        }
        if let Some(dur) = video_duration {
            let media = run.stats.media_s();
            metrics.push((
                "video.duration_deficit_vs_media_s".to_string(),
                format!("{:.3}", media - dur),
            ));
        }
        metrics.push(("status".to_string(), status.to_string()));
        let mut sub = Report {
            status: status.to_string(),
            metrics,
        };
        sub.set("method", method.name());
        write_report(out, &sub);
        Ok(sub.metrics)
    }
}
