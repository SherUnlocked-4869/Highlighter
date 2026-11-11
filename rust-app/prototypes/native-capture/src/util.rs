//! 日志、哈希/亮度分析、区间统计等与 Windows API 无关的小工具。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

static LOGGER: OnceLock<Mutex<File>> = OnceLock::new();

/// 初始化日志文件。日志同时写 stdout（本程序为 windows_subsystem="windows"，
/// 只有调用方重定向 stdout 时才可见）与文件，保证自动化时可追溯。
pub fn init_log(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    let _ = LOGGER.set(Mutex::new(file));
    Ok(())
}

pub fn log(msg: &str) {
    let mut line = String::with_capacity(msg.len() + 1);
    line.push_str(msg);
    line.push('\n');
    let mut out = std::io::stdout();
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
    if let Some(logger) = LOGGER.get() {
        if let Ok(mut file) = logger.lock() {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }
}

/// 逐行日志。写文件失败时静默忽略：日志是证据辅助，不是主链路结果。
/// 由 `#[macro_use] mod util;` 引入 crate 根，对后续模块可见。
macro_rules! logln {
    ($($arg:tt)*) => {
        $crate::util::log(&format!($($arg)*))
    };
}

pub const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
pub const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

#[inline]
fn fnv_mix(h: u64, byte: u8) -> u64 {
    (h ^ byte as u64).wrapping_mul(FNV_PRIME)
}

/// 单帧质量指标。
///
/// - `hash`：样本哈希。Release 下对每个像素的 B/G/R 三字节做 FNV-1a 64；
///   Debug 下每 16 个像素取 1 个（见 `quality_mode`）。哈希用于判断帧内容是否重复、
///   以及“全黑帧/静止帧”检测。
/// - `mean_luma`：采样点的平均亮度（0..255，BT.601 近似）。
/// - `black`：全帧（Release）/ 全部采样点（Debug）亮度 <= 1，即近似全黑帧。
/// - `sampled`：是否采样模式。
#[derive(Clone, Copy, Debug)]
pub struct FrameQuality {
    pub hash: u64,
    pub mean_luma: f64,
    pub black: bool,
    pub sampled: bool,
}

/// `full=true`：全帧逐像素（Release 默认）；`full=false`：每 16 像素取 1（Debug 默认，
/// 避免 Debug 构建下逐字节哈希把 4K/竖屏帧处理拖到 30fps 预算之外）。
pub fn analyze_frame(data: &[u8], full: bool) -> FrameQuality {
    let pixel_count = data.len() / 4;
    if pixel_count == 0 {
        return FrameQuality {
            hash: FNV_OFFSET,
            mean_luma: 0.0,
            black: true,
            sampled: !full,
        };
    }
    let step = if full { 1usize } else { 16usize };
    let mut hash = FNV_OFFSET;
    let mut luma_sum: u64 = 0;
    let mut sampled: u64 = 0;
    let mut black = true;
    let mut idx = 0usize;
    while idx < pixel_count {
        let p = idx * 4;
        let b = data[p] as u32;
        let g = data[p + 1] as u32;
        let r = data[p + 2] as u32;
        hash = fnv_mix(hash, b as u8);
        hash = fnv_mix(hash, g as u8);
        hash = fnv_mix(hash, r as u8);
        // BT.601 近似亮度，避免浮点运算。
        let luma = (299 * r + 587 * g + 114 * b) / 1000;
        luma_sum += luma as u64;
        sampled += 1;
        if luma > 1 {
            black = false;
        }
        idx += step;
    }
    FrameQuality {
        hash,
        mean_luma: luma_sum as f64 / sampled as f64,
        black: black && sampled > 0,
        sampled: !full,
    }
}

/// 毫秒区间统计：mean / p50 / p95 / max。
#[derive(Clone, Copy, Debug, Default)]
pub struct IntervalStats {
    pub count: usize,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

pub fn summarize_intervals(values: &[f64]) -> IntervalStats {
    if values.is_empty() {
        return IntervalStats::default();
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    let mean = sorted.iter().sum::<f64>() / n as f64;
    let pick = |q: f64| -> f64 {
        if n == 1 {
            sorted[0]
        } else {
            let pos = q * (n - 1) as f64;
            let lo = pos.floor() as usize;
            let hi = pos.ceil() as usize;
            if lo == hi {
                sorted[lo]
            } else {
                sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64)
            }
        }
    };
    IntervalStats {
        count: n,
        mean_ms: mean,
        p50_ms: pick(0.50),
        p95_ms: pick(0.95),
        max_ms: *sorted.last().unwrap(),
    }
}

pub fn now_stamp() -> String {
    // 不引入 chrono：用 std 本地风格 HH:MM:SS.mmm 由调用方提供相对时间即可。
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", d.as_secs(), d.subsec_millis())
}

pub fn human_bytes(bytes: u64) -> String {
    if bytes >= 1 << 30 {
        format!("{:.2} GiB", bytes as f64 / (1u64 << 30) as f64)
    } else if bytes >= 1 << 20 {
        format!("{:.2} MiB", bytes as f64 / (1u64 << 20) as f64)
    } else if bytes >= 1 << 10 {
        format!("{:.2} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

/// 极简 JSON 字符串转义（仅用于 summary.json；不引入 serde 以保持原型依赖最小）。
pub fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 运行环境摘要行（构建 profile、OS build、CPU/GPU 名称由 PowerShell 侧补，见文档）。
pub fn build_profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}
