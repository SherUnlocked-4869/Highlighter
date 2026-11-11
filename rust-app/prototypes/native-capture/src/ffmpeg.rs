//! ffmpeg 管道编码与 mux。
//!
//! 视频链路（唯一路径）：Rust 采集 BGRA 帧 → 有界 `sync_channel`（默认 4 帧）
//! → 写线程 `stdin.write_all` → `ffmpeg -f rawvideo -pix_fmt bgra -s WxH -framerate FPS -i pipe:0`
//! → libx264 MP4。
//!
//! 有界通道是背压的设计点：编码/写盘慢时 `send()` 阻塞在采集回调里，
//! WGC 帧池随后自行丢帧（GDI 路径则是采样节拍滑移），因此不会出现无界内存增长。
//! 写线程额外提供 `slow_consumer_ms`（每帧人为 sleep）来复现“慢盘”分支。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use crate::cpumon::{CpuTimes, ProcessCpuCounter};
use crate::util::{analyze_frame, human_bytes, log, FrameQuality};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Frame {
    pub data: Arc<Vec<u8>>,
    pub seq: u64,
    pub t_capture: Instant,
}

#[derive(Debug, Default)]
pub struct EncodeStats {
    pub frames_written: u64,
    pub bytes_written: u64,
    pub black_frames: u64,
    pub unique_hashes: u64,
    pub repeated_hashes: u64,
    pub min_luma: f64,
    pub max_luma: f64,
    pub mean_luma: f64,
    pub quality_mode: String,
    pub write_error: Option<String>,
}

#[derive(Debug)]
pub struct EncodeOutcome {
    pub args: Vec<String>,
    pub stats: EncodeStats,
    pub exit_code: Option<i32>,
    pub ffmpeg_stderr: String,
    pub wall_s: f64,
    pub ffmpeg_cpu: Option<CpuTimes>,
}

pub struct VideoEncoder {
    tx: Option<SyncSender<Frame>>,
    join: Option<JoinHandle<EncodeOutcome>>,
    pub args: Vec<String>,
}

impl VideoEncoder {
    pub fn sender(&self) -> SyncSender<Frame> {
        self.tx.as_ref().expect("encoder sender taken").clone()
    }

    /// 停止送帧并等待 ffmpeg 落盘；返回编码统计（即使 ffmpeg 失败也返回，便于记录原始错误）。
    pub fn finish(mut self) -> EncodeOutcome {
        self.tx.take();
        match self.join.take() {
            Some(handle) => handle.join().unwrap_or_else(|_| EncodeOutcome {
                args: self.args.clone(),
                stats: EncodeStats::default(),
                exit_code: None,
                ffmpeg_stderr: "encoder thread panicked".to_string(),
                wall_s: 0.0,
                ffmpeg_cpu: None,
            }),
            None => EncodeOutcome {
                args: self.args.clone(),
                stats: EncodeStats::default(),
                exit_code: None,
                ffmpeg_stderr: "encoder thread missing".to_string(),
                wall_s: 0.0,
                ffmpeg_cpu: None,
            },
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn spawn_video_encoder(
    ffmpeg: &Path,
    out_file: &Path,
    width: u32,
    height: u32,
    fps: u32,
    codec: &str,
    preset: &str,
    crf: u32,
    keyint: u32,
    queue: usize,
    slow_consumer_ms: u64,
) -> Result<VideoEncoder, String> {
    if let Some(parent) = out_file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create out dir {} failed: {e}", parent.display()))?;
    }
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "warning".into(),
        "-y".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "bgra".into(),
        "-s".into(),
        format!("{width}x{height}"),
        "-framerate".into(),
        fps.to_string(),
        "-i".into(),
        "pipe:0".into(),
        "-an".into(),
        "-c:v".into(),
        codec.into(),
        "-preset".into(),
        preset.into(),
        "-crf".into(),
        crf.to_string(),
        "-g".into(),
        keyint.to_string(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-movflags".into(),
        "+faststart".into(),
        out_file.display().to_string(),
    ];
    let mut cmd = Command::new(ffmpeg);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "spawn ffmpeg failed: {} (path={}): {e}",
            e,
            ffmpeg.display()
        )
    })?;
    let pid = child.id();
    let mut stdin = child.stdin.take().ok_or("ffmpeg stdin pipe missing")?;
    let stderr = child.stderr.take().ok_or("ffmpeg stderr pipe missing")?;
    let cpu_counter = ProcessCpuCounter::open(pid);
    let (tx, rx) = sync_channel::<Frame>(queue.max(1));

    let args_for_thread = args.clone();
    let start = Instant::now();
    let join = std::thread::Builder::new()
        .name("ffmpeg-writer".into())
        .spawn(move || {
            // stderr 必须持续排空，否则 ffmpeg 写日志会阻塞。
            let stderr_thread = std::thread::spawn(move || -> String {
                use std::io::Read;
                let mut buf = Vec::new();
                let mut reader = stderr;
                let _ = reader.read_to_end(&mut buf);
                String::from_utf8_lossy(&buf).into_owned()
            });

            let quality_full = !cfg!(debug_assertions);
            let quality_mode = if quality_full {
                "full-frame"
            } else {
                "sampled-1of16"
            };
            let mut stats = EncodeStats {
                unique_hashes: 0,
                repeated_hashes: 0,
                min_luma: f64::MAX,
                max_luma: f64::MIN,
                quality_mode: quality_mode.to_string(),
                ..Default::default()
            };
            let mut prev_hash: Option<u64> = None;
            let mut duplicate_of_prev = false;
            while let Ok(frame) = rx.recv() {
                if slow_consumer_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(slow_consumer_ms));
                }
                let q: FrameQuality = analyze_frame(&frame.data, quality_full);
                if let Some(prev) = prev_hash {
                    if prev == q.hash {
                        stats.repeated_hashes += 1;
                        duplicate_of_prev = true;
                    } else {
                        stats.unique_hashes += 1;
                        duplicate_of_prev = false;
                    }
                } else {
                    stats.unique_hashes += 1;
                }
                let _ = duplicate_of_prev;
                prev_hash = Some(q.hash);
                if q.black {
                    stats.black_frames += 1;
                }
                stats.min_luma = stats.min_luma.min(q.mean_luma);
                stats.max_luma = stats.max_luma.max(q.mean_luma);
                stats.mean_luma += q.mean_luma;

                if let Err(e) = stdin.write_all(&frame.data) {
                    stats.write_error = Some(format!(
                        "ffmpeg stdin write failed at frame {}: {e}",
                        frame.seq
                    ));
                    break;
                }
                stats.frames_written += 1;
                stats.bytes_written += frame.data.len() as u64;
                if stats.frames_written.is_multiple_of(150) {
                    logln!(
                        "[encode] frames={} bytes={}",
                        stats.frames_written,
                        human_bytes(stats.bytes_written)
                    );
                }
            }
            // 关闭 stdin 让 ffmpeg flush 并退出。
            drop(stdin);
            let status = child.wait();
            let ffmpeg_stderr = stderr_thread.join().unwrap_or_default();
            let ffmpeg_cpu = cpu_counter.as_ref().and_then(|c| c.sample());
            if stats.frames_written > 0 {
                stats.mean_luma /= stats.frames_written as f64;
            } else {
                stats.mean_luma = 0.0;
                stats.min_luma = 0.0;
                stats.max_luma = 0.0;
            }
            EncodeOutcome {
                args: args_for_thread,
                stats,
                exit_code: status.ok().and_then(|s| s.code()),
                ffmpeg_stderr,
                wall_s: start.elapsed().as_secs_f64(),
                ffmpeg_cpu,
            }
        })
        .map_err(|e| format!("spawn writer thread failed: {e}"))?;

    Ok(VideoEncoder {
        tx: Some(tx),
        join: Some(join),
        args,
    })
}

#[derive(Debug)]
pub struct MuxOutcome {
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub stderr: String,
    pub wall_s: f64,
}

/// 视频-only MP4 + WAV → 带 AAC 音轨的 MP4。
///
/// `audio_lead_s` = 采集侧音频起点早于首帧视频的时间（秒）。
/// 用输入侧 `-ss` 精确裁掉这段前导（WAV/PCM 定位到采样），使两轨都从 0 开始。
pub fn mux_av(
    ffmpeg: &Path,
    video: &Path,
    audio: &Path,
    out_file: &Path,
    audio_lead_s: f64,
) -> Result<MuxOutcome, String> {
    let lead = if audio_lead_s.is_finite() && audio_lead_s > 0.0 {
        audio_lead_s.min(2.0)
    } else {
        0.0
    };
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "warning".into(),
        "-y".into(),
        "-i".into(),
        video.display().to_string(),
    ];
    if lead > 0.0 {
        args.push("-ss".into());
        args.push(format!("{lead:.6}"));
    }
    args.extend([
        "-i".into(),
        audio.display().to_string(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "1:a:0".into(),
        "-c:v".into(),
        "copy".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        out_file.display().to_string(),
    ]);
    let mut cmd = Command::new(ffmpeg);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let start = Instant::now();
    let out = cmd
        .output()
        .map_err(|e| format!("spawn ffmpeg mux failed: {e}"))?;
    if out.status.code() != Some(0) {
        logln!(
            "[mux] FAILED exit={:?} stderr={}",
            out.status.code(),
            crate::verify::tail(&String::from_utf8_lossy(&out.stderr), 1200)
        );
    }
    Ok(MuxOutcome {
        args,
        exit_code: out.status.code(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        wall_s: start.elapsed().as_secs_f64(),
    })
}

pub fn encoder_args_pretty(args: &[String]) -> String {
    args.iter()
        .map(|a| {
            if a.contains(' ') {
                format!("\"{a}\"")
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub fn default_mp4(path: &Path) -> PathBuf {
    let mut p = path.to_path_buf();
    p.set_extension("mp4");
    p
}

pub fn log_line_to_file(path: &Path, text: &str) {
    let _ = std::fs::write(path, text);
    log(&format!("[verify] wrote {}", path.display()));
}
