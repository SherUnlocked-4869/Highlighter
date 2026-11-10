//! 采集后端公共部分：显示器枚举、按时间轴重采样的帧推送器、统计结构。

pub mod gdi;
pub mod wgc;

use std::sync::mpsc::SyncSender;
use std::sync::Arc;
use std::time::Instant;

use windows::core::BOOL;
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

use crate::ffmpeg::Frame;
use crate::util::{summarize_intervals, IntervalStats};

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
}

impl CaptureStats {
    pub fn wall_s(&self) -> f64 {
        match (self.capture_start, self.capture_end) {
            (Some(a), Some(b)) => (b - a).as_secs_f64(),
            _ => 0.0,
        }
    }
}

/// 把采集到的帧按"捕获时间 → 输出时间轴槽位"重采样后送入有界通道。
///
/// 目的：输出视频固定 fps，时长与采集墙钟时间对齐；WGC 帧到达速率可能略高于或低于 fps
/// （取决于桌面内容变化率），因此：
/// - 同一槽位内多余帧丢弃（计数 `pacing_drops`）；
/// - 跨槽缺口用上一帧复制补齐（计数 `duplicated`，单次缺口上限 `max_fill`）。
///
/// `send()` 是阻塞发送：通道满表示编码/写盘落后，这里记录阻塞时长（背压证据）。
pub struct FramePusher {
    tx: SyncSender<Frame>,
    fps: f64,
    t0: Instant,
    seq: u64,
    last_slot: Option<u64>,
    last_data: Option<Arc<Vec<u8>>>,
    max_fill: u64,
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
            stats: CaptureStats {
                capture_start: Some(t0),
                ..Default::default()
            },
            gap_threshold_s: 1.5 / fps as f64,
            last_arrival: None,
        }
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

        let slot = ((t_arrival - self.t0).as_secs_f64() * self.fps)
            .floor()
            .max(0.0) as u64;
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
        let intervals = self.stats.intervals_raw.clone();
        self.stats.intervals = summarize_intervals(&intervals);
        self.stats.clone()
    }
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
}

/// 在启动 ffmpeg 之前确定后端与尺寸。
///
/// - `--capture wgc` 严格模式：WGC 失败直接失败（回退需显式 `auto`）；
/// - `--capture gdi` 强制 GDI；
/// - `--capture auto`：WGC 探测失败回退 GDI，并保留原始错误。
pub fn resolve(
    mode: &str,
    allow_fallback: bool,
    monitor: &MonitorInfo,
    fault_wgc_hmon: Option<isize>,
) -> Result<ResolvedCapture, String> {
    match mode {
        "gdi" => Ok(ResolvedCapture {
            backend: Backend::Gdi,
            width: monitor.width(),
            height: monitor.height(),
            fallback_reason: None,
        }),
        "wgc" | "auto" => match wgc::probe_size(monitor, fault_wgc_hmon) {
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
                })
            }
        },
        other => Err(format!(
            "unknown --capture value '{other}' (expected wgc|gdi|auto)"
        )),
    }
}

pub struct CaptureRun {
    pub backend: &'static str,
    pub fallback_reason: Option<String>,
    pub stats: CaptureStats,
    pub requested_seconds: f64,
    pub requested_fps: u32,
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    resolved: &ResolvedCapture,
    monitor: &MonitorInfo,
    seconds: f64,
    fps: u32,
    max_fill: u64,
    tx: SyncSender<Frame>,
    t0: Instant,
    fault_wgc_hmon: Option<isize>,
) -> Result<CaptureRun, String> {
    let backend_name: &'static str = match resolved.backend {
        Backend::Wgc => "wgc",
        Backend::Gdi => "gdi",
    };
    logln!(
        "[capture] backend={} target={} out={}x{}",
        backend_name,
        monitor.describe(),
        resolved.width,
        resolved.height
    );
    let stats = match resolved.backend {
        Backend::Wgc => wgc::run(
            monitor,
            seconds,
            fps,
            max_fill,
            tx,
            t0,
            (resolved.width, resolved.height),
            fault_wgc_hmon,
        )?,
        Backend::Gdi => gdi::run(monitor, seconds, fps, max_fill, tx, t0)?,
    };
    Ok(CaptureRun {
        backend: backend_name,
        fallback_reason: resolved.fallback_reason.clone(),
        stats,
        requested_seconds: seconds,
        requested_fps: fps,
    })
}
