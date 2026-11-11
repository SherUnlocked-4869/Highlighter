//! 采集暂停/继续控制器（R0-05 扩展：暂停续录证据）。
//!
//! 语义（本原型选择的最小语义，不等于产品最终语义）：
//! - 暂停**不写入媒体时间轴**：暂停期间视频不采帧、音频包被丢弃，媒体时钟
//!   `media_time = wall_time - t0 - paused_total` 在暂停期间冻结；
//! - 恢复后视频槽位从“暂停前最后槽位 + 1”继续（由 `FramePusher` 记录并核对），
//!   音频样本数约等于媒体时长；两者换算到同一媒体时钟后做 A/V 偏差测量。
//!
//! 触发方式：`--pause-at <媒体秒> --pause-ms <毫秒>`（可逗号分隔多个），
//! 由采集主循环（视频线程）驱动状态机；音频线程只读取 `is_paused()` 并丢弃暂停期间的包。
//!
//! 已知边界（写进证据文档，不当作产品结论）：
//! - 音频线程按 5 ms 轮询暂停状态，暂停边界处最多约 5 ms 的音频样点归属误差；
//! - WGC 路径本机不可用，暂停状态机只接入 GDI 路径；
//! - 暂停时长由计划值控制（不是用户按键），不实现跨暂停的设备重连。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::capture::FramePusher;

/// 跨线程“暂停中”标志：音频线程只读它（不持有控制器，避免控制器 t0 的启动顺序问题）。
#[derive(Clone, Default)]
pub struct PauseGate {
    paused: Arc<AtomicBool>,
}

impl PauseGate {
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }
    fn set(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
    }
}

/// 一次暂停的完整记录（写入 `pause-windows.txt`，供文档引用）。
#[derive(Clone, Debug, Default)]
pub struct PauseWindow {
    pub index: usize,
    /// 计划触发的媒体时间（秒，不含暂停时长）。
    pub scheduled_media_s: f64,
    /// 实际暂停开始时距 t0 的墙钟秒数。
    pub start_wall_s: f64,
    pub planned_ms: u64,
    pub actual_ms: f64,
    /// 暂停开始时的媒体时间（秒）。
    pub media_start_s: f64,
    /// 恢复后的媒体时间（秒）。
    pub media_end_s: f64,
    /// 暂停前最后写入的槽位。
    pub last_slot_before: Option<u64>,
    /// 恢复后第一个视频帧写入的槽位。
    pub first_slot_after: Option<u64>,
    /// `first_slot_after - last_slot_before`，期望 1（若恢复瞬间恰好跨过一个槽位则为 1）。
    pub resume_slot_delta: Option<i64>,
}

#[derive(Default)]
struct PauseState {
    schedule: Vec<(f64, u64)>,
    next: usize,
    paused: bool,
    pause_start_wall: Option<Instant>,
    paused_total: Duration,
    windows: Vec<PauseWindow>,
    /// 当前暂停窗口下标。
    active: Option<usize>,
}

pub struct PauseController {
    t0: Instant,
    gate: PauseGate,
    state: Mutex<PauseState>,
}

impl PauseController {
    pub fn new(schedule: Vec<(f64, u64)>, t0: Instant, gate: PauseGate) -> Arc<Self> {
        Arc::new(Self {
            t0,
            gate,
            state: Mutex::new(PauseState {
                schedule,
                ..Default::default()
            }),
        })
    }

    /// 供音频线程读取的暂停标志（与控制器共享同一个 gate）。
    pub fn gate(&self) -> PauseGate {
        self.gate.clone()
    }

    /// 媒体时间（秒）：墙钟减去累计暂停时长。
    pub fn media_now(&self, now: Instant) -> f64 {
        let paused = self
            .state
            .lock()
            .map(|s| s.paused_total)
            .unwrap_or_default();
        (now - self.t0).saturating_sub(paused).as_secs_f64()
    }

    pub fn is_paused(&self) -> bool {
        self.state.lock().map(|s| s.paused).unwrap_or(false)
    }

    pub fn paused_total(&self) -> Duration {
        self.state
            .lock()
            .map(|s| s.paused_total)
            .unwrap_or_default()
    }

    pub fn windows(&self) -> Vec<PauseWindow> {
        self.state
            .lock()
            .map(|s| s.windows.clone())
            .unwrap_or_default()
    }

    /// 视频采集循环每帧前调用：若到达计划暂停点则在此阻塞到暂停结束并返回 true。
    ///
    /// `pusher` 用于记录暂停前后槽位并累计媒体时钟；只应由视频采集线程调用。
    pub fn wait_if_due(&self, pusher: &mut FramePusher) -> bool {
        let mut st = match self.state.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if st.paused {
            return false; // 不可能发生在单线程驱动下；防御性返回。
        }
        let due = st.schedule.get(st.next).copied().filter(|(at, _)| {
            let media = (Instant::now() - self.t0)
                .saturating_sub(st.paused_total)
                .as_secs_f64();
            media >= *at
        });
        let Some((scheduled_media_s, planned_ms)) = due else {
            return false;
        };
        let pause_start = Instant::now();
        let media_start_s = (pause_start - self.t0)
            .saturating_sub(st.paused_total)
            .as_secs_f64();
        let index = st.windows.len();
        st.windows.push(PauseWindow {
            index,
            scheduled_media_s,
            start_wall_s: (pause_start - self.t0).as_secs_f64(),
            planned_ms,
            actual_ms: 0.0,
            media_start_s,
            media_end_s: media_start_s,
            last_slot_before: pusher.last_slot(),
            first_slot_after: None,
            resume_slot_delta: None,
        });
        st.active = Some(index);
        st.paused = true;
        st.next += 1;
        self.gate.set(true);
        logln!(
            "[pause] #{} start at media={:.3}s wall={:.3}s planned={}ms last_slot={:?}",
            index,
            media_start_s,
            (pause_start - self.t0).as_secs_f64(),
            planned_ms,
            st.windows[index].last_slot_before
        );
        drop(st);

        let planned = Duration::from_millis(planned_ms.max(1));
        loop {
            std::thread::sleep(Duration::from_millis(2).min(planned));
            if (Instant::now() - pause_start) >= planned {
                break;
            }
        }

        let mut st = match self.state.lock() {
            Ok(g) => g,
            Err(_) => return true,
        };
        let resume = Instant::now();
        let actual = (resume - pause_start).as_secs_f64();
        st.paused_total += resume - pause_start;
        st.paused = false;
        self.gate.set(false);
        let index = st.active.take();
        if let Some(i) = index {
            st.windows[i].actual_ms = actual * 1000.0;
            st.windows[i].media_end_s = (resume - self.t0)
                .saturating_sub(st.paused_total)
                .as_secs_f64();
        }
        pusher.add_pause(resume - pause_start);
        logln!(
            "[pause] #{} resumed after {:.1}ms; media clock {:.3}s",
            index.unwrap_or(0),
            actual * 1000.0,
            st.windows
                .get(index.unwrap_or(0))
                .map(|w| w.media_end_s)
                .unwrap_or(0.0)
        );
        true
    }

    /// 由 `FramePusher` 在暂停后第一帧写入时回调，补齐槽位连续性证据。
    pub fn note_resume_slot(&self, slot: u64) {
        let mut st = match self.state.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let Some(w) = st.windows.last_mut() else {
            return;
        };
        if w.first_slot_after.is_none() {
            w.first_slot_after = Some(slot);
            w.resume_slot_delta = w.last_slot_before.map(|last| slot as i64 - last as i64);
        }
    }
}

/// 解析 `--pause-at` / `--pause-ms`：两者都是逗号分隔；`pause-ms` 单值广播到所有触发点。
pub fn parse_schedule(at: Option<&str>, ms: Option<&str>) -> Result<Vec<(f64, u64)>, String> {
    let Some(at) = at else {
        return Ok(Vec::new());
    };
    let ats: Vec<f64> = at
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<f64>().map_err(|e| format!("--pause-at: {e}")))
        .collect::<Result<_, _>>()?;
    let ms_values: Vec<u64> = match ms {
        Some(v) => v
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.parse::<u64>().map_err(|e| format!("--pause-ms: {e}")))
            .collect::<Result<_, _>>()?,
        None => {
            return Err("--pause-at requires --pause-ms".to_string());
        }
    };
    if ms_values.is_empty() {
        return Err("--pause-ms is empty".to_string());
    }
    let mut schedule = Vec::with_capacity(ats.len());
    for (i, at) in ats.into_iter().enumerate() {
        let dur = ms_values[i.min(ms_values.len() - 1)];
        schedule.push((at, dur));
    }
    Ok(schedule)
}

/// 写暂停窗口证据文件；失败时只记日志（证据辅助，不是主链路）。
pub fn write_windows(path: &std::path::Path, windows: &[PauseWindow], paused_total_s: f64) {
    let mut text = String::new();
    text.push_str("index\tscheduled_media_s\tstart_wall_s\tplanned_ms\tactual_ms\tmedia_start_s\tmedia_end_s\tlast_slot_before\tfirst_slot_after\tresume_slot_delta\n");
    for w in windows {
        text.push_str(&format!(
            "{}\t{:.3}\t{:.3}\t{}\t{:.2}\t{:.3}\t{:.3}\t{}\t{}\t{}\n",
            w.index,
            w.scheduled_media_s,
            w.start_wall_s,
            w.planned_ms,
            w.actual_ms,
            w.media_start_s,
            w.media_end_s,
            w.last_slot_before
                .map(|v| v.to_string())
                .unwrap_or_else(|| "-".into()),
            w.first_slot_after
                .map(|v| v.to_string())
                .unwrap_or_else(|| "-".into()),
            w.resume_slot_delta
                .map(|v| v.to_string())
                .unwrap_or_else(|| "-".into()),
        ));
    }
    text.push_str(&format!("paused_total_s={paused_total_s:.3}\n"));
    let _ = std::fs::write(path, text);
    logln!("[pause] wrote {}", path.display());
}
