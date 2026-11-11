//! ffmpeg 产物验证：只依赖 `ffmpeg.exe`（本机 ffmpeg-static 不含 ffprobe）。
//!
//! 三类证据：
//! 1. `ffmpeg -i` 文本輸出解析：容器时长/起始时间/分辨率/fps/编码器/音频采样率/声道/码率；
//! 2. `ffmpeg -v error -xerror -f null -` 全量解码：退出码非 0 即不可解码；
//! 3. `ffmpeg -debug_ts -c copy -f null -`：逐包 pts/duration，得到每个流首末时间戳，
//!    用于 A/V 起始偏移与尾部偏差测量（没有 ffprobe 时的替代方案）。

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug)]
pub struct VideoStreamInfo {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub raw: String,
}

#[derive(Clone, Debug)]
pub struct AudioStreamInfo {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: String,
    pub bitrate_kbps: Option<f64>,
    pub raw: String,
}

#[derive(Clone, Debug, Default)]
pub struct ProbeResult {
    pub duration_s: Option<f64>,
    pub start_s: Option<f64>,
    pub video: Option<VideoStreamInfo>,
    pub audio: Option<AudioStreamInfo>,
    pub raw: String,
}

fn run_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<(Option<i32>, String), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("spawn ffmpeg ({}) failed: {e}", ffmpeg.display()))?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code(), text))
}

fn parse_timestamp(text: &str) -> Option<f64> {
    // HH:MM:SS.xx
    let parts: Vec<&str> = text.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].trim().parse().ok()?;
    let m: f64 = parts[1].trim().parse().ok()?;
    let s: f64 = parts[2].trim().parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

fn find_resolution(line: &str) -> Option<(u32, u32)> {
    // 跳过十六进制标签（如 avc1 / 0x31637661）：要求 'x' 左右都是十进制数字串。
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'x' {
            let mut l = i;
            while l > 0 && bytes[l - 1].is_ascii_digit() {
                l -= 1;
            }
            let mut r = i + 1;
            while r < bytes.len() && bytes[r].is_ascii_digit() {
                r += 1;
            }
            if l < i && r > i + 1 {
                if let (Ok(w), Ok(h)) = (line[l..i].parse::<u32>(), line[i + 1..r].parse::<u32>()) {
                    if (16..=16384).contains(&w) && (16..=16384).contains(&h) {
                        return Some((w, h));
                    }
                }
            }
        }
        i += 1;
    }
    None
}

fn parse_fps(line: &str) -> Option<f64> {
    let idx = line.find(" fps")?;
    let head = &line[..idx];
    let token = head.split_whitespace().last()?;
    token.parse::<f64>().ok()
}

fn token_after<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    let idx = text.find(marker)?;
    let rest = text[idx + marker.len()..].trim_start();
    Some(rest.split(',').next().unwrap_or(rest).trim())
}

/// `ffmpeg -i <file>` 的文本解析。
pub fn probe(ffmpeg: &Path, file: &Path) -> Result<ProbeResult, String> {
    let args = vec![
        "-hide_banner".to_string(),
        "-i".to_string(),
        file.display().to_string(),
    ];
    // 注意：`ffmpeg -i <file>`（不给输出）在 ffmpeg 6.1 下解析完输入后以 exit 1
    // 退出并打印 "At least one output file must be specified"。因此这里不按退出码
    // 判失败，以能否解析出容器信息为准。
    let (_code, text) = run_ffmpeg(ffmpeg, &args)?;
    let mut probe = ProbeResult {
        raw: text.clone(),
        ..Default::default()
    };
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("Duration:") && probe.duration_s.is_none() {
            let after = &trimmed["Duration:".len()..];
            let dur_part = after.split(',').next().unwrap_or("").trim();
            probe.duration_s = parse_timestamp(dur_part);
            if let Some(pos) = after.find("start:") {
                let s = after[pos + "start:".len()..].trim();
                probe.start_s = s.split(',').next().and_then(|v| v.trim().parse().ok());
            }
        } else if line.contains("Video:") && probe.video.is_none() {
            let after = &line[line.find("Video:").unwrap() + "Video:".len()..];
            let codec = after.split_whitespace().next().unwrap_or("?").to_string();
            let (w, h) = find_resolution(after).unwrap_or((0, 0));
            probe.video = Some(VideoStreamInfo {
                codec,
                width: w,
                height: h,
                fps: parse_fps(line).unwrap_or(0.0),
                raw: line.trim().to_string(),
            });
        } else if line.contains("Audio:") && probe.audio.is_none() {
            let after = &line[line.find("Audio:").unwrap() + "Audio:".len()..];
            let codec = after.split_whitespace().next().unwrap_or("?").to_string();
            let sample_rate = line
                .find(" Hz")
                .and_then(|idx| {
                    let head = &line[..idx];
                    head.split_whitespace().last()?.parse::<u32>().ok()
                })
                .unwrap_or(0);
            let channels = if line.contains(" stereo") {
                "stereo".to_string()
            } else if line.contains(" mono") {
                "mono".to_string()
            } else {
                token_after(after, "Hz,")
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "?".to_string())
            };
            let bitrate_kbps = line.find(" kb/s").and_then(|idx| {
                let head = &line[..idx];
                head.split_whitespace().last()?.parse::<f64>().ok()
            });
            probe.audio = Some(AudioStreamInfo {
                codec,
                sample_rate,
                channels,
                bitrate_kbps,
                raw: line.trim().to_string(),
            });
        }
    }
    if probe.duration_s.is_none() && probe.video.is_none() && probe.audio.is_none() {
        return Err(format!(
            "ffmpeg -i {}: cannot parse container/streams: {}",
            file.display(),
            tail(&text, 800)
        ));
    }
    Ok(probe)
}

/// 全量解码检查：`-xerror` 保证任何解码错误立即以非 0 退出。
pub fn decode_check(ffmpeg: &Path, file: &Path) -> Result<(i32, f64), String> {
    let args: Vec<String> = [
        "-hide_banner",
        "-v",
        "error",
        "-xerror",
        "-i",
        &file.display().to_string(),
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let start = Instant::now();
    let (code, text) = run_ffmpeg(ffmpeg, &args)?;
    let elapsed = start.elapsed().as_secs_f64();
    match code {
        Some(0) => Ok((0, elapsed)),
        other => Err(format!(
            "decode check failed (exit {:?}) for {}: {}",
            other,
            file.display(),
            tail(&text, 1200)
        )),
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StreamSpan {
    pub first_pts_s: f64,
    pub last_end_s: f64,
    pub packets: u64,
}

/// 用 `-debug_ts` 读出某一路流的首/末包时间戳与总时长跨度。
pub fn stream_span(ffmpeg: &Path, file: &Path, map: &str) -> Result<StreamSpan, String> {
    let args: Vec<String> = [
        "-hide_banner",
        "-debug_ts",
        "-i",
        &file.display().to_string(),
        "-map",
        map,
        "-c",
        "copy",
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let (code, text) = run_ffmpeg(ffmpeg, &args)?;
    if code != Some(0) {
        return Err(format!(
            "stream_span {map} failed (exit {:?}): {}",
            code,
            tail(&text, 800)
        ));
    }
    let mut span = StreamSpan::default();
    let mut first = f64::INFINITY;
    let mut last = f64::NEG_INFINITY;
    let mut count = 0u64;
    for line in text.lines() {
        if !line.contains("demuxer+ffmpeg -> ist_index:") {
            continue;
        }
        let Some(pos) = line.find("pkt_pts_time:") else {
            continue;
        };
        let rest = &line[pos + "pkt_pts_time:".len()..];
        let pts_token = rest.split_whitespace().next().unwrap_or("");
        let Ok(pts) = pts_token.parse::<f64>() else {
            continue;
        };
        let dur = line
            .find("duration_time:")
            .and_then(|idx| {
                line[idx + "duration_time:".len()..]
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse::<f64>().ok())
            })
            .unwrap_or(0.0);
        first = first.min(pts);
        last = last.max(pts + dur);
        count += 1;
    }
    if count == 0 || !first.is_finite() {
        return Err(format!("stream_span {map}: no packet timestamps parsed"));
    }
    span.first_pts_s = first;
    span.last_end_s = last;
    span.packets = count;
    Ok(span)
}

/// 用 `-progress pipe:1` 读出单路流解码后的 end time（无 ffprobe 的第二种口径，
/// 与 stream_span 交叉核对）。
pub fn stream_end_progress(ffmpeg: &Path, file: &Path, map: &str) -> Result<f64, String> {
    let args: Vec<String> = [
        "-hide_banner",
        "-nostats",
        "-v",
        "error",
        "-progress",
        "pipe:1",
        "-i",
        &file.display().to_string(),
        "-map",
        map,
        "-c",
        "copy",
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let (code, text) = run_ffmpeg(ffmpeg, &args)?;
    if code != Some(0) {
        return Err(format!("progress {map} failed: {}", tail(&text, 500)));
    }
    let mut end = 0.0f64;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = v.trim().parse::<f64>() {
                end = end.max(us / 1e6);
            }
        }
    }
    Ok(end)
}

pub fn tail(text: &str, max: usize) -> String {
    let clean: String = text
        .chars()
        .map(|c| if c == '\r' { ' ' } else { c })
        .collect();
    if clean.len() <= max {
        clean
    } else {
        format!("…{}", &clean[clean.len() - max..])
    }
}

/// 逐包 pts 序列（`-debug_ts`，按解复用顺序）。用于验证输出视频时间轴是否连续
/// （暂停/继续后不得出现暂停时长的空洞）。
pub fn packet_pts(ffmpeg: &Path, file: &Path, map: &str) -> Result<Vec<f64>, String> {
    let args: Vec<String> = [
        "-hide_banner",
        "-debug_ts",
        "-i",
        &file.display().to_string(),
        "-map",
        map,
        "-c",
        "copy",
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let (code, text) = run_ffmpeg(ffmpeg, &args)?;
    if code != Some(0) {
        return Err(format!(
            "packet_pts {map} failed (exit {:?}): {}",
            code,
            tail(&text, 800)
        ));
    }
    let mut out = Vec::new();
    for line in text.lines() {
        if !line.contains("demuxer+ffmpeg -> ist_index:") {
            continue;
        }
        let Some(pos) = line.find("pkt_pts_time:") else {
            continue;
        };
        let rest = &line[pos + "pkt_pts_time:".len()..];
        let Some(token) = rest.split_whitespace().next() else {
            continue;
        };
        if let Ok(pts) = token.parse::<f64>() {
            out.push(pts);
        }
    }
    if out.is_empty() {
        return Err(format!("packet_pts {map}: no packet timestamps parsed"));
    }
    Ok(out)
}

/// 输出帧时间轴连续性检查结果。
#[derive(Clone, Debug, Default)]
pub struct TimelineCheck {
    pub packets: usize,
    pub first_pts_s: f64,
    pub last_pts_s: f64,
    pub span_s: f64,
    pub expected_frames: usize,
    pub missing_slots: u64,
    pub max_gap_ms: f64,
    pub median_gap_ms: f64,
    pub nonuniform_steps: u64,
    pub effective_fps: f64,
    /// 解复用顺序中 pts 回退的次数（B 帧重排；不是时间轴空洞）。
    pub reordered_steps: u64,
}

/// 期望帧间隔 `1000/fps` ms；`gap` 定义为间隔 > 1.5 个期望步长。
///
/// 注意：`-debug_ts` 按解复用（解码）顺序输出，含 B 帧时 pts 非单调；
/// 这里先按 pts 排序再判断连续性，否则会把 B 帧重排误判成时间轴空洞。
pub fn timeline_check(pts: &[f64], fps: f64) -> TimelineCheck {
    let mut out = TimelineCheck {
        packets: pts.len(),
        ..Default::default()
    };
    if pts.is_empty() || fps <= 0.0 {
        return out;
    }
    for w in pts.windows(2) {
        if w[1] < w[0] {
            out.reordered_steps += 1;
        }
    }
    let mut sorted = pts.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let step = 1.0 / fps;
    out.first_pts_s = sorted[0];
    out.last_pts_s = sorted[sorted.len() - 1];
    out.span_s = out.last_pts_s - out.first_pts_s;
    if out.span_s > 0.0 {
        out.expected_frames = (out.span_s * fps).round() as usize + 1;
    }
    let mut gaps_ms: Vec<f64> = Vec::with_capacity(sorted.len().saturating_sub(1));
    for w in sorted.windows(2) {
        let dt = w[1] - w[0];
        gaps_ms.push(dt * 1000.0);
        if dt > 1.5 * step {
            out.max_gap_ms = out.max_gap_ms.max(dt * 1000.0);
            let slots = (dt / step).round() as i64 - 1;
            if slots > 0 {
                out.missing_slots += slots as u64;
            }
        }
        if (dt - step).abs() > 0.25 * step {
            out.nonuniform_steps += 1;
        }
    }
    if !gaps_ms.is_empty() {
        let mut sorted_gaps = gaps_ms.clone();
        sorted_gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        out.median_gap_ms = sorted_gaps[sorted_gaps.len() / 2];
    }
    if out.span_s > 0.0 {
        out.effective_fps = (sorted.len() as f64 - 1.0) / out.span_s;
    }
    out
}
