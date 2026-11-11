//! 采集后端公共部分：显示器枚举、采集目标（显示器/区域/窗口）、按时间轴重采样的
//! 帧推送器（含暂停/继续的媒体时钟）、统计结构。
//!
//! 暂停语义见 `pause.rs`：`FramePusher` 的槽位计算减去累计暂停时长，暂停期间不产生
//! 媒体帧；恢复后第一帧与暂停前最后槽位的差记录在 `pause_resume_deltas`。

pub mod gdi;
pub mod wgc;
pub mod window;

use std::sync::mpsc::SyncSender;
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::BOOL;
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

use crate::ffmpeg::Frame;
use crate::pause::PauseController;
use crate::util::{summarize_intervals, IntervalStats};
use window::{WindowMethod, WindowSource, WindowStats};

#[derive(Clone, Debug)]
pub struct MonitorInfo {
    pub index: usize,
    pub device: String,
    pub hmon: isize,
    pub rect: RECT,
    pub work: RECT,
    pub primary: bool,
    pub dpi: u32,
}

impl MonitorInfo {
    pub fn width(&self) -> u32 {
        (self.rect.right - self.rect.left) as u32
    }
    pub fn height(&self) -> u32 {
        (self.rect.bottom - self.rect.top) as u32
    }
    pub fn describe(&self) -> String {
        format!(
            "#{} {} {}x{} rect=({},{}..{}, {}) primary={} dpi={}",
            self.index,
            self.device,
            self.width(),
            self.height(),
            self.rect.left,
            self.rect.top,
            self.rect.right,
            self.rect.bottom,
            self.primary,
            self.dpi
        )
    }
}

unsafe extern "system" fn enum_monitor_cb(
    hmon: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let list = unsafe { &mut *(data.0 as *mut Vec<MonitorInfo>) };
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    let ok = unsafe {
        GetMonitorInfoW(
            hmon,
            &mut info as *mut MONITORINFOEXW as *mut windows::Win32::Graphics::Gdi::MONITORINFO,
        )
    };
    if ok.as_bool() {
        let mut dpi_x = 0u32;
        let mut dpi_y = 0u32;
        let _ = unsafe { GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
        let device = {
            let len = info
                .szDevice
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(info.szDevice.len());
            String::from_utf16_lossy(&info.szDevice[..len])
        };
        let primary = info.monitorInfo.dwFlags & 1 != 0; // MONITORINFOF_PRIMARY
        list.push(MonitorInfo {
            index: list.len(),
            device,
            hmon: hmon.0 as isize,
            rect: info.monitorInfo.rcMonitor,
            work: info.monitorInfo.rcWork,
            primary,
            dpi: dpi_x,
        });
    }
    BOOL(1)
}

/// 枚举显示器（进程必须已 per-monitor DPI aware v2，否则读到的是被 DPI 虚拟化放大的坐标）。
pub fn enumerate_monitors() -> Result<Vec<MonitorInfo>, String> {
    let mut list: Vec<MonitorInfo> = Vec::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(enum_monitor_cb),
            LPARAM(&mut list as *mut Vec<MonitorInfo> as isize),
        )
    };
    if !ok.as_bool() || list.is_empty() {
        return Err("EnumDisplayMonitors returned no monitors".to_string());
    }
    // 稳定顺序：主屏在前，其余按 (left, top) 排序，保证 --monitor 索引可复跑。
    list.sort_by(|a, b| {
        (!a.primary, a.rect.left, a.rect.top).cmp(&(!b.primary, b.rect.left, b.rect.top))
    });
    for (i, m) in list.iter_mut().enumerate() {
        m.index = i;
    }
    Ok(list)
}

/// 固定屏幕矩形（显示器或区域），虚拟桌面物理像素坐标。
#[derive(Clone, Copy, Debug)]
pub struct ScreenRect {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

impl ScreenRect {
    pub fn from_monitor(m: &MonitorInfo) -> Self {
        Self {
            left: m.rect.left,
            top: m.rect.top,
            width: m.width(),
            height: m.height(),
        }
    }

    pub fn describe(&self) -> String {
        format!(
            "({},{}..{}, {})",
            self.left,
            self.top,
            self.left + self.width as i32,
            self.top + self.height as i32
        )
    }
}

/// 窗口采集请求（CLI 解析结果）。
#[derive(Clone, Debug)]
pub struct WindowRequest {
    pub hwnd: Option<isize>,
    pub title: Option<String>,
    pub exclude: Vec<String>,
    pub method: WindowMethod,
    pub follow: bool,
}

/// 采集目标：屏幕固定矩形或跟随目标窗口。
pub enum CaptureTarget {
    Screen(ScreenRect),
    Window(Box<WindowSource>),
}

impl CaptureTarget {
    pub fn output_size(&self) -> (u32, u32) {
        match self {
            Self::Screen(r) => (r.width, r.height),
            Self::Window(w) => (w.out_width as u32, w.out_height as u32),
        }
    }

    pub fn describe(&self) -> String {
        match self {
            Self::Screen(r) => format!("screen {}", r.describe()),
            Self::Window(w) => format!(
                "window target=0x{:X} method={} out={}x{}",
                w.initial.hwnd,
                w.method.name(),
                w.out_width,
                w.out_height
            ),
        }
    }
}

/// CLI 目标规格（在 resolve 阶段解析成 `CaptureTarget` 并确定编码尺寸）。
#[derive(Clone, Debug)]
pub enum TargetSpec {
    Monitor(MonitorInfo),
    Region(ScreenRect),
    Window(WindowRequest),
}

#[derive(Debug, Default, Clone)]
pub struct CaptureStats {
    /// 回调送来的原始帧数（未经时间轴重采样）。
    pub delivered: u64,
    /// 实际写入 ffmpeg 的帧数（含缺口复制帧）。
    pub written: u64,
    /// 因到达过快（同一 1/fps 槽位内多于 1 帧）被丢弃的帧。
    pub pacing_drops: u64,
    /// 到达过慢时用上一帧补齐时间轴的重复帧数。
    pub duplicated: u64,
    /// 到达间隔 > 1.5/fps 的次数（采集侧丢帧）。
    pub arrival_gaps: u64,
    /// `send()` 阻塞 > 1ms 的次数（背压事件）。
    pub backpressure_events: u64,
    pub backpressure_total_ms: f64,
    pub backpressure_max_ms: f64,
    /// 因编码通道断开（ffmpeg 失败）导致的发送失败次数。
    pub send_errors: u64,
    pub first_frame: Option<Instant>,
    pub last_frame: Option<Instant>,
    pub capture_start: Option<Instant>,
    pub capture_end: Option<Instant>,
    pub intervals: IntervalStats,
    pub intervals_raw: Vec<f64>,
    pub error: Option<String>,
    /// 累计暂停时长（秒），用于从墙钟得到媒体时长。
    pub paused_total_s: f64,
    /// 完成的暂停窗口数（由 PauseController 驱动）。
    pub pause_windows: u64,
    /// 每次暂停恢复后第一帧相对暂停前最后槽位的槽位差（期望 1）。
    pub pause_resume_deltas: Vec<i64>,
}

impl CaptureStats {
    /// 采集墙钟（包含暂停时长）。
    pub fn wall_s(&self) -> f64 {
        match (self.capture_start, self.capture_end) {
            (Some(a), Some(b)) => (b - a).as_secs_f64(),
            _ => 0.0,
        }
    }
    /// 媒体时长（墙钟 − 暂停）。
    pub fn media_s(&self) -> f64 {
        (self.wall_s() - self.paused_total_s).max(0.0)
    }
}

/// 把采集到的帧按"捕获时间 → 输出时间轴槽位"重采样后送入有界通道。
///
/// `media_time = arrival - t0 - paused_total`；暂停期间不产生帧，恢复后槽位连续。
pub struct FramePusher {
    tx: SyncSender<Frame>,
    fps: f64,
    t0: Instant,
    seq: u64,
    last_slot: Option<u64>,
    last_data: Option<Arc<Vec<u8>>>,
    max_fill: u64,
    paused_total: Duration,
    pending_resume: bool,
    resume_last_slot: Option<u64>,
    pub stats: CaptureStats,
    gap_threshold_s: f64,
    last_arrival: Option<Instant>,
}

impl FramePusher {
    pub fn new(tx: SyncSender<Frame>, fps: u32, t0: Instant, max_fill: u64) -> Self {
        Self {
            tx,
            fps: fps as f64,
            t0,
            seq: 0,
            last_slot: None,
            last_data: None,
            max_fill,
            paused_total: Duration::ZERO,
            pending_resume: false,
            resume_last_slot: None,
            stats: CaptureStats {
                capture_start: Some(t0),
                ..Default::default()
            },
            gap_threshold_s: 1.5 / fps as f64,
            last_arrival: None,
        }
    }

    pub fn last_slot(&self) -> Option<u64> {
        self.last_slot
    }

    pub fn paused_total(&self) -> Duration {
        self.paused_total
    }

    /// 暂停结束：把暂停时长从媒体时钟中扣除，并标记下一帧用于槽位连续性证据。
    pub fn add_pause(&mut self, duration: Duration) {
        self.paused_total += duration;
        self.pending_resume = true;
        self.resume_last_slot = self.last_slot;
        self.stats.pause_windows += 1;
        self.stats.paused_total_s = self.paused_total.as_secs_f64();
    }

    pub fn push(&mut self, data: Vec<u8>, t_arrival: Instant) {
        self.stats.delivered += 1;
        if let Some(prev) = self.last_arrival {
            let dt = (t_arrival - prev).as_secs_f64();
            self.stats.intervals_raw.push(dt * 1000.0);
            if dt > self.gap_threshold_s {
                self.stats.arrival_gaps += 1;
            }
        }
        self.last_arrival = Some(t_arrival);
        self.stats.first_frame.get_or_insert(t_arrival);
        self.stats.last_frame = Some(t_arrival);

        let media = (t_arrival - self.t0).saturating_sub(self.paused_total);
        let slot = (media.as_secs_f64() * self.fps).floor().max(0.0) as u64;
        if self.pending_resume {
            if let Some(before) = self.resume_last_slot {
                self.stats
                    .pause_resume_deltas
                    .push(slot as i64 - before as i64);
            }
            self.pending_resume = false;
            self.resume_last_slot = None;
        }
        match self.last_slot {
            None => {
                self.dispatch(Arc::new(data), t_arrival);
                self.last_slot = Some(slot);
            }
            Some(last) => {
                if slot <= last {
                    self.stats.pacing_drops += 1;
                    return;
                }
                let gap = (slot - last - 1).min(self.max_fill);
                if gap > 0 {
                    if let Some(prev) = self.last_data.clone() {
                        for _ in 0..gap {
                            self.dispatch(prev.clone(), t_arrival);
                            self.stats.duplicated += 1;
                        }
                    }
                }
                self.dispatch(Arc::new(data), t_arrival);
                self.last_slot = Some(slot);
            }
        }
    }

    fn dispatch(&mut self, data: Arc<Vec<u8>>, t_arrival: Instant) {
        self.seq += 1;
        let frame = Frame {
            data: data.clone(),
            seq: self.seq,
            t_capture: t_arrival,
        };
        let start = Instant::now();
        match self.tx.send(frame) {
            Ok(()) => {
                self.stats.written += 1;
                self.last_data = Some(data);
            }
            Err(_) => {
                self.stats.send_errors += 1;
                if self.stats.error.is_none() {
                    self.stats.error =
                        Some("encoder channel closed (ffmpeg exited early?)".to_string());
                }
            }
        }
        let blocked = start.elapsed().as_secs_f64() * 1000.0;
        if blocked > 1.0 {
            self.stats.backpressure_events += 1;
            self.stats.backpressure_total_ms += blocked;
            self.stats.backpressure_max_ms = self.stats.backpressure_max_ms.max(blocked);
        }
    }

    pub fn backend_error(&self) -> Option<String> {
        self.stats.error.clone()
    }

    /// 收尾：记录结束时间并计算到达间隔统计（保留原始间隔供文档引用）。
    pub fn finish(&mut self) -> CaptureStats {
        self.stats.capture_end = Some(Instant::now());
        self.stats.paused_total_s = self.paused_total.as_secs_f64();
        let intervals = self.stats.intervals_raw.clone();
        self.stats.intervals = summarize_intervals(&intervals);
        self.stats.clone()
    }
}

/// 窗口采集运行期证据（屏幕目标为 None）。
pub struct WindowRuntime {
    pub stats: WindowStats,
    /// (媒体时间秒, 事件文本)
    pub events: Vec<(f64, String)>,
    pub initial: String,
}

/// 解析后的采集后端与输出尺寸（编码器参数必须在采集启动前确定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Wgc,
    Gdi,
}

pub struct ResolvedCapture {
    pub backend: Backend,
    pub width: u32,
    pub height: u32,
    /// WGC 解析失败回退 GDI 时的原始错误。
    pub fallback_reason: Option<String>,
    pub target: CaptureTarget,
    /// GDI 是否使用 CAPTUREBLT（抓分层窗口；--no-captureblt 关闭以降低 DWM 抓取成本）。
    pub captureblt: bool,
}

fn make_task_ok(
    backend: Backend,
    width: u32,
    height: u32,
    target: CaptureTarget,
    captureblt: bool,
) -> Result<ResolvedCapture, String> {
    Ok(ResolvedCapture {
        backend,
        width,
        height,
        fallback_reason: None,
        target,
        captureblt,
    })
}

/// 在启动 ffmpeg 之前确定后端、目标与尺寸。
pub fn resolve(
    mode: &str,
    allow_fallback: bool,
    spec: TargetSpec,
    fault_wgc_hmon: Option<isize>,
    captureblt: bool,
) -> Result<ResolvedCapture, String> {
    match spec {
        TargetSpec::Monitor(monitor) => {
            let screen = CaptureTarget::Screen(ScreenRect::from_monitor(&monitor));
            match mode {
                "gdi" => make_task_ok(
                    Backend::Gdi,
                    monitor.width(),
                    monitor.height(),
                    screen,
                    captureblt,
                ),
                "wgc" | "auto" => match wgc::probe_size(&monitor, fault_wgc_hmon) {
                    Ok((width, height)) => {
                        if width % 2 != 0 || height % 2 != 0 {
                            let msg = format!(
                                "WGC item size {width}x{height} is odd; yuv420p H.264 requires even dimensions"
                            );
                            if mode == "auto" && allow_fallback {
                                return Ok(ResolvedCapture {
                                    backend: Backend::Gdi,
                                    width: monitor.width(),
                                    height: monitor.height(),
                                    fallback_reason: Some(msg),
                                    target: screen,
                                    captureblt,
                                });
                            }
                            return Err(msg);
                        }
                        if width != monitor.width() || height != monitor.height() {
                            logln!(
                                "[capture] note: WGC content size {}x{} != monitor rect {}x{} (DPI/虚拟化差异，以 WGC 为准)",
                                width,
                                height,
                                monitor.width(),
                                monitor.height()
                            );
                        }
                        Ok(ResolvedCapture {
                            backend: Backend::Wgc,
                            width,
                            height,
                            fallback_reason: None,
                            target: screen,
                            captureblt,
                        })
                    }
                    Err(err) => {
                        if mode == "wgc" || !allow_fallback {
                            return Err(format!("WGC unavailable: {err}"));
                        }
                        logln!("[capture] WGC probe failed (raw error): {err}");
                        logln!("[capture] falling back to GDI BitBlt");
                        Ok(ResolvedCapture {
                            backend: Backend::Gdi,
                            width: monitor.width(),
                            height: monitor.height(),
                            fallback_reason: Some(format!("WGC probe failed: {err}")),
                            target: screen,
                            captureblt,
                        })
                    }
                },
                other => Err(format!(
                    "unknown --capture value '{other}' (expected wgc|gdi|auto)"
                )),
            }
        }
        TargetSpec::Region(rect) => {
            if mode == "wgc" {
                return Err(
                    "--capture wgc is not implemented for --region (prototype only supports GDI region capture)"
                        .to_string(),
                );
            }
            if rect.width == 0 || rect.height == 0 {
                return Err("--region width/height must be > 0".to_string());
            }
            let (width, height) = ensure_even(rect.width, rect.height);
            make_task_ok(
                Backend::Gdi,
                width,
                height,
                CaptureTarget::Screen(rect),
                captureblt,
            )
        }
        TargetSpec::Window(request) => {
            if mode == "wgc" {
                return Err(
                    "--capture wgc is not implemented for --window (prototype only supports GDI window capture)"
                        .to_string(),
                );
            }
            let initial = if let Some(hwnd) = request.hwnd {
                match window::resolve_by_hwnd(hwnd) {
                    Some(m) => m,
                    None => {
                        return Err(format!(
                            "--window-hwnd 0x{hwnd:X} is not a valid top-level window"
                        ))
                    }
                }
            } else if let Some(title) = &request.title {
                match window::resolve_by_title(title, &request.exclude) {
                    Some(m) => m,
                    None => {
                        return Err(format!(
                            "--window-title {title:?} matched no top-level window (exclude={:?})",
                            request.exclude
                        ))
                    }
                }
            } else {
                return Err("--window needs --window-title or --window-hwnd".to_string());
            };
            let rect = initial.rect;
            let rect_w = (rect.right - rect.left).max(0) as u32;
            let rect_h = (rect.bottom - rect.top).max(0) as u32;
            if rect_w == 0 || rect_h == 0 {
                return Err(format!(
                    "window target has empty rect: {:?}",
                    initial.describe()
                ));
            }
            let (width, height) = ensure_even(rect_w, rect_h);
            logln!("[capture] window target resolved: {}", initial.describe());
            let source = WindowSource::new(
                initial,
                request.method,
                request.title.clone(),
                request.exclude.clone(),
                request.follow,
                width as i32,
                height as i32,
            );
            Ok(ResolvedCapture {
                backend: Backend::Gdi,
                width,
                height,
                fallback_reason: None,
                target: CaptureTarget::Window(Box::new(source)),
                captureblt,
            })
        }
    }
}

fn ensure_even(width: u32, height: u32) -> (u32, u32) {
    let w = if width.is_multiple_of(2) {
        width
    } else {
        width.saturating_sub(1)
    };
    let h = if height.is_multiple_of(2) {
        height
    } else {
        height.saturating_sub(1)
    };
    if w != width || h != height {
        logln!("[capture] note: even dimensions required for yuv420p; output {w}x{h} (target {width}x{height})");
    }
    (w.max(2), h.max(2))
}

pub struct CaptureRun {
    pub backend: &'static str,
    pub fallback_reason: Option<String>,
    pub stats: CaptureStats,
    pub requested_seconds: f64,
    pub requested_fps: u32,
    pub target_description: String,
    pub window: Option<WindowRuntime>,
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    mut resolved: ResolvedCapture,
    seconds: f64,
    fps: u32,
    max_fill: u64,
    tx: SyncSender<Frame>,
    t0: Instant,
    pause: Option<Arc<PauseController>>,
    fault_wgc_hmon: Option<isize>,
) -> Result<CaptureRun, String> {
    let backend_name: &'static str = match resolved.backend {
        Backend::Wgc => "wgc",
        Backend::Gdi => "gdi",
    };
    let target_description = resolved.target.describe();
    logln!(
        "[capture] backend={} target={} out={}x{}",
        backend_name,
        target_description,
        resolved.width,
        resolved.height
    );
    let monitor = MonitorInfo {
        index: 0,
        device: String::new(),
        hmon: 0,
        rect: RECT {
            left: 0,
            top: 0,
            right: resolved.width as i32,
            bottom: resolved.height as i32,
        },
        work: RECT::default(),
        primary: true,
        dpi: 0,
    };
    match resolved.backend {
        Backend::Wgc => {
            // WGC 路径只支持显示器/区域（本机 WGC 不可用，保留原实现）。
            let screen_rect = match &resolved.target {
                CaptureTarget::Screen(r) => *r,
                CaptureTarget::Window(_) => {
                    return Err("WGC window capture is not implemented".to_string())
                }
            };
            let monitor_full = MonitorInfo {
                rect: RECT {
                    left: screen_rect.left,
                    top: screen_rect.top,
                    right: screen_rect.left + screen_rect.width as i32,
                    bottom: screen_rect.top + screen_rect.height as i32,
                },
                ..monitor
            };
            let stats = wgc::run(
                &monitor_full,
                seconds,
                fps,
                max_fill,
                tx,
                t0,
                (resolved.width, resolved.height),
                fault_wgc_hmon,
            )?;
            Ok(CaptureRun {
                backend: backend_name,
                fallback_reason: resolved.fallback_reason.clone(),
                stats,
                requested_seconds: seconds,
                requested_fps: fps,
                target_description,
                window: None,
            })
        }
        Backend::Gdi => {
            let result = gdi::run(
                &mut resolved.target,
                seconds,
                fps,
                max_fill,
                tx,
                t0,
                pause,
                resolved.captureblt,
            )?;
            Ok(CaptureRun {
                backend: backend_name,
                fallback_reason: resolved.fallback_reason.clone(),
                stats: result.stats,
                requested_seconds: seconds,
                requested_fps: fps,
                target_description,
                window: result.window,
            })
        }
    }
}
