//! 录屏导出限制与纯校验（R0）。
//!
//! 基线：`shared/recording-export-options.js` 的 `LIMITS`/`GIF_FRAME_RATES`/
//! `MAX_SEGMENTS` 与计划 §9.1 的硬限制。这里只实现纯函数；编码、队列执行与发布在 R5。
//!
//! 语义对齐（与 JS 同源，改之前先读 JS 注释）：
//!
//! - 多段选择：1～20 段，按 start 排序，重叠显式报错（首尾相接合法且不合并），每段
//!   `[startMs, endMs)` 半开且 ≥ 100 ms；空数组表示整段；单段覆盖整段时规范化为
//!   `[{0, duration}]`。
//! - GIF：总保留时长 ≤ 60 s、输出长边 ≤ 1280 px、≤ 1200 帧、fps ∈ {10,15,20}；
//!   绝不放大；帧数用 `ceil(duration*fps/1000)`。
//! - 导出队列：同时 1 个编码任务，最多 2 个等待。

use std::fmt;

/// 同时编码任务数（计划 §9.1）。
pub const MAX_ACTIVE_TASKS: u32 = 1;
/// 排队等待上限（计划 §9.1）。
pub const MAX_QUEUED_TASKS: u32 = 2;
/// GIF 总保留时长上限（计划 §9.1：60 s）。
pub const GIF_MAX_DURATION_MS: u64 = 60_000;
/// GIF 输出长边上限（计划 §9.1：1280 px）。
pub const GIF_MAX_EDGE_PX: u32 = 1280;
/// GIF 请求长边下限（低于它是误操作，见 JS `GIF_MIN_EDGE_PX`）。
pub const GIF_MIN_EDGE_PX: u32 = 16;
/// GIF 帧数上限（计划 §9.1：1200 帧）。
pub const GIF_MAX_FRAMES: u32 = 1200;
/// 允许的 GIF 帧率（计划 §9.1：10/15/20 fps）。
pub const GIF_FRAME_RATES: [u32; 3] = [10, 15, 20];
/// 单段最小长度（计划 §9.1：≥ 100 ms）。
pub const MIN_RANGE_MS: u64 = 100;
/// 多段最小长度（与 [`MIN_RANGE_MS`] 同值；JS 里是两个符号，保留对照）。
pub const MIN_SEGMENT_MS: u64 = 100;
/// 多段数量上限（计划 §9.1：最多 20 段）。
pub const MAX_SEGMENTS: usize = 20;

/// 校验错误；`code()` 返回与 `shared/recording-export-options.js` 相同的稳定错误码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportError {
    /// 时长不可用（≤ 0 或缺失）。
    DurationUnavailable,
    /// 区间非法（start ≥ end、非整数等）。
    InvalidRange,
    /// 区间越界（超出源时长 ±1 ms 容差）。
    RangeOutOfBounds,
    /// 1～20 段但某段短于 100 ms。
    RangeTooShort,
    /// 段数超过 20。
    TooManySegments,
    /// 段之间重叠（首尾相接合法）。
    OverlappingSegments,
    /// 源尺寸非法（0/缺失）。
    InvalidSourceSize,
    /// GIF 总时长超过 60 s。
    GifTooLong,
    /// GIF fps 不在 10/15/20。
    GifInvalidFps,
    /// GIF `loop` 必须为 true/缺省。
    GifLoopRequired,
    /// GIF 长边参数非法或输出超限。
    GifInvalidEdge,
    /// GIF 帧数超过 1200。
    GifTooManyFrames,
    /// 导出队列已满（1 编码 + 2 等待）。
    QueueFull,
}

impl ExportError {
    /// 稳定错误码（与 JS `fail(code)` 的 code 字符串一致，供双端对照）。
    #[must_use]
    pub fn code(self) -> &'static str {
        match self {
            ExportError::DurationUnavailable => "duration-unavailable",
            ExportError::InvalidRange => "invalid-range",
            ExportError::RangeOutOfBounds => "range-out-of-bounds",
            ExportError::RangeTooShort => "range-too-short",
            ExportError::TooManySegments => "too-many-segments",
            ExportError::OverlappingSegments => "overlapping-segments",
            ExportError::InvalidSourceSize => "invalid-source-size",
            ExportError::GifTooLong => "gif-too-long",
            ExportError::GifInvalidFps => "gif-invalid-fps",
            ExportError::GifLoopRequired => "gif-loop-required",
            ExportError::GifInvalidEdge => "gif-invalid-edge",
            ExportError::GifTooManyFrames => "gif-too-many-frames",
            ExportError::QueueFull => "queue-full",
        }
    }
}

impl fmt::Display for ExportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ExportError {}

/// 导出队列限制。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportQueueLimits {
    /// 同时进行编码的任务数。
    pub max_concurrent_encodes: u32,
    /// 等待编码的任务数。
    pub max_pending: u32,
}

/// 队列槽位：可以立即编码，或进入等待。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueSlot {
    /// 立即占用编码槽。
    Encode,
    /// 进入等待队列。
    Pending,
}

impl ExportQueueLimits {
    /// 计划 §9.1 基线：1 编码 + 2 等待。
    #[must_use]
    pub fn baseline() -> Self {
        Self {
            max_concurrent_encodes: MAX_ACTIVE_TASKS,
            max_pending: MAX_QUEUED_TASKS,
        }
    }

    /// 尝试接纳一个导出任务。`encoding` 是正在编码的任务数，`pending` 是等待中的任务数。
    ///
    /// 与计划 §9.1 一致：queued/running/cancelling 都参与容量清理，调用方需按状态机
    /// 把它们分别计入这两个计数。
    pub fn admit(self, encoding: u32, pending: u32) -> Result<QueueSlot, ExportError> {
        if encoding < self.max_concurrent_encodes {
            Ok(QueueSlot::Encode)
        } else if pending < self.max_pending {
            Ok(QueueSlot::Pending)
        } else {
            Err(ExportError::QueueFull)
        }
    }
}

/// GIF 预算限制。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GifLimits {
    /// 总保留时长上限（毫秒）。
    pub max_duration_ms: u64,
    /// 输出长边上限（像素）。
    pub max_edge_px: u32,
    /// 请求长边下限（像素）。
    pub min_edge_px: u32,
    /// 帧数上限。
    pub max_frames: u32,
    /// 允许的帧率集合。
    pub frame_rates: [u32; 3],
}

impl GifLimits {
    /// 计划 §9.1 基线。
    #[must_use]
    pub fn baseline() -> Self {
        Self {
            max_duration_ms: GIF_MAX_DURATION_MS,
            max_edge_px: GIF_MAX_EDGE_PX,
            min_edge_px: GIF_MIN_EDGE_PX,
            max_frames: GIF_MAX_FRAMES,
            frame_rates: GIF_FRAME_RATES,
        }
    }
}

/// 多段限制。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentLimits {
    /// 段数上限。
    pub max_segments: usize,
    /// 单段最小长度（毫秒）。
    pub min_segment_ms: u64,
}

impl SegmentLimits {
    /// 计划 §9.1 基线。
    #[must_use]
    pub fn baseline() -> Self {
        Self {
            max_segments: MAX_SEGMENTS,
            min_segment_ms: MIN_SEGMENT_MS,
        }
    }
}

/// 计划 §9.1 的录屏导出硬限制集合。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportLimits {
    /// 导出队列。
    pub queue: ExportQueueLimits,
    /// GIF。
    pub gif: GifLimits,
    /// 多段。
    pub segments: SegmentLimits,
}

impl ExportLimits {
    /// 计划 §9.1 基线值（与 `shared/recording-export-options.js` 同源）。
    #[must_use]
    pub fn baseline() -> Self {
        Self {
            queue: ExportQueueLimits::baseline(),
            gif: GifLimits::baseline(),
            segments: SegmentLimits::baseline(),
        }
    }
}

impl Default for ExportLimits {
    fn default() -> Self {
        Self::baseline()
    }
}

/// 渲染层传入的原始区间（整数毫秒；允许 ±1 ms 越界容差）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawSegment {
    /// 半开区间开始（毫秒）。
    pub start_ms: i64,
    /// 半开区间结束（毫秒）。
    pub end_ms: i64,
}

/// 校验后的媒体时间区间 `[start_ms, end_ms)`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TimeRange {
    /// 开始（含）。
    pub start_ms: u64,
    /// 结束（不含）。
    pub end_ms: u64,
}

impl TimeRange {
    /// 区间长度（毫秒）；非法区间返回 0。
    #[must_use]
    pub fn duration_ms(self) -> u64 {
        self.end_ms.saturating_sub(self.start_ms)
    }

    /// 半开区间是否非空。
    #[must_use]
    pub fn is_valid(self) -> bool {
        self.start_ms < self.end_ms
    }
}

/// 多段规范化结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedSegments {
    /// 排序、去重叠、规范化后的段（空输入 → 整段）。
    pub segments: Vec<TimeRange>,
    /// 总保留时长（毫秒）。
    pub total_duration_ms: u64,
}

/// 规范化多段选择（移植 `normalizeSegments`，输入为整数毫秒）。
///
/// 规则见 JS 注释：1～20 段、排序、重叠显式报错（相接合法不合并）、每段 ≥ 100 ms、
/// `0 ≤ start < end ≤ duration`；空数组 = 整段；单段覆盖整段规范化为 `[{0,duration}]`。
pub fn normalize_segments(
    input: &[RawSegment],
    duration_ms: i64,
) -> Result<NormalizedSegments, ExportError> {
    if duration_ms <= 0 {
        return Err(ExportError::DurationUnavailable);
    }
    if input.len() > MAX_SEGMENTS {
        return Err(ExportError::TooManySegments);
    }
    if input.is_empty() {
        let duration = duration_ms as u64;
        return Ok(NormalizedSegments {
            segments: vec![TimeRange {
                start_ms: 0,
                end_ms: duration,
            }],
            total_duration_ms: duration,
        });
    }

    let mut segments = Vec::with_capacity(input.len());
    for raw in input {
        // ±1 ms 容差吸收滑块的浮点噪声；越界更远视为非法请求。
        if raw.start_ms < -1 || raw.end_ms > duration_ms + 1 {
            return Err(ExportError::RangeOutOfBounds);
        }
        let start = raw.start_ms.clamp(0, duration_ms);
        let end = raw.end_ms.clamp(0, duration_ms);
        if start >= end {
            return Err(ExportError::InvalidRange);
        }
        if ((end - start) as u64) < MIN_SEGMENT_MS {
            return Err(ExportError::RangeTooShort);
        }
        segments.push(TimeRange {
            start_ms: start as u64,
            end_ms: end as u64,
        });
    }

    segments.sort_unstable();
    for pair in segments.windows(2) {
        if pair[1].start_ms < pair[0].end_ms {
            return Err(ExportError::OverlappingSegments);
        }
    }

    let duration = duration_ms as u64;
    let canonical = canonical_segments(&segments, duration);
    let total_duration_ms = canonical.iter().map(|segment| segment.duration_ms()).sum();
    Ok(NormalizedSegments {
        segments: canonical,
        total_duration_ms,
    })
}

/// 单段覆盖整段时规范化为 `[{0, duration}]`；与 JS `canonicalSegments` 一致。
fn canonical_segments(segments: &[TimeRange], duration_ms: u64) -> Vec<TimeRange> {
    if segments.len() == 1 {
        let segment = segments[0];
        if segment.start_ms <= 1 && segment.end_ms >= duration_ms.saturating_sub(1) {
            return vec![TimeRange {
                start_ms: 0,
                end_ms: duration_ms,
            }];
        }
    }
    segments.to_vec()
}

/// 估算 GIF 帧数：`ceil(duration*fps/1000)`，至少 1 帧；与 JS `estimateGifFrames` 一致。
///
/// `fps == 0` 时 JS 回落到默认 15 fps（`finiteNumber(fps) || GIF_FRAME_RATES[1]`），
/// 这里保留同样行为；正常调用方应先用 [`normalize_gif_options`] 校验帧率。
#[must_use]
pub fn estimate_gif_frames(duration_ms: u64, fps: u32) -> u32 {
    if duration_ms == 0 {
        return 0;
    }
    let rate = if fps == 0 { GIF_FRAME_RATES[1] } else { fps };
    let frames = duration_ms.saturating_mul(u64::from(rate)).div_ceil(1000);
    frames.clamp(1, u64::from(u32::MAX)) as u32
}

/// GIF 输出尺寸（偶数对齐，绝不放大）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GifDimensions {
    /// 输出宽。
    pub width: u32,
    /// 输出高。
    pub height: u32,
    /// 输出长边。
    pub edge_px: u32,
}

/// 计算 GIF 输出尺寸（移植 `computeGifDimensions`）：
/// 长边取 `min(requested, source long edge)`，按比例缩放后每边取偶数（最小 2）。
pub fn compute_gif_dimensions(
    width: u32,
    height: u32,
    max_edge_px: Option<u32>,
) -> Result<GifDimensions, ExportError> {
    if width == 0 || height == 0 {
        return Err(ExportError::InvalidSourceSize);
    }
    let requested = max_edge_px.unwrap_or(GIF_MAX_EDGE_PX);
    if !(GIF_MIN_EDGE_PX..=GIF_MAX_EDGE_PX).contains(&requested) {
        return Err(ExportError::GifInvalidEdge);
    }
    let long_edge = width.max(height);
    let target_edge = requested.min(long_edge);
    let scale = f64::from(target_edge) / f64::from(long_edge);
    let even = |value: u32| -> u32 {
        let scaled = f64::from(value) * scale;
        let rounded = (scaled / 2.0).round() * 2.0;
        (rounded as u32).max(2)
    };
    let out_width = even(width);
    let out_height = even(height);
    if out_width > GIF_MAX_EDGE_PX || out_height > GIF_MAX_EDGE_PX {
        return Err(ExportError::GifInvalidEdge);
    }
    Ok(GifDimensions {
        width: out_width,
        height: out_height,
        edge_px: out_width.max(out_height),
    })
}

/// 探针给出的源视频尺寸。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceSize {
    /// 源宽。
    pub width: u32,
    /// 源高。
    pub height: u32,
}

/// GIF 请求的原始选项（整数毫秒/像素；R5 在 JSON 边界拒绝小数）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GifOptionsInput {
    /// 帧率；缺省视为 0（随后被拒绝）。
    pub fps: Option<u32>,
    /// 输出长边（R4 字段名 `edge`）。
    pub edge: Option<u32>,
    /// 旧字段名 `maxEdgePx`（与 `edge` 二选一，`edge` 优先）。
    pub max_edge_px: Option<u32>,
    /// `loop` 只能是 true/缺省；`Some(false)` 报错。
    pub loop_: Option<bool>,
}

/// 规范化后的 GIF 选项。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NormalizedGifOptions {
    /// 输出长边。
    pub edge: u32,
    /// 帧率。
    pub fps: u32,
    /// 固定为 true（当前只支持循环）。
    pub loop_: bool,
    /// 输出宽。
    pub width: u32,
    /// 输出高。
    pub height: u32,
    /// 预计帧数。
    pub frames: u32,
}

/// 规范化 GIF 选项（移植 `normalizeGifOptions`）；`kept_duration_ms` 是**保留总时长**，
/// 不是源片长度。返回稳定错误码，与 JS 一致。
pub fn normalize_gif_options(
    input: GifOptionsInput,
    source: SourceSize,
    kept_duration_ms: u64,
) -> Result<NormalizedGifOptions, ExportError> {
    if kept_duration_ms == 0 {
        return Err(ExportError::DurationUnavailable);
    }
    if kept_duration_ms > GIF_MAX_DURATION_MS {
        return Err(ExportError::GifTooLong);
    }
    let fps = input.fps.unwrap_or(0);
    if !GIF_FRAME_RATES.contains(&fps) {
        return Err(ExportError::GifInvalidFps);
    }
    if input.loop_ == Some(false) {
        return Err(ExportError::GifLoopRequired);
    }
    let requested_edge = input.edge.or(input.max_edge_px);
    let dimensions = compute_gif_dimensions(source.width, source.height, requested_edge)?;
    let frames = estimate_gif_frames(kept_duration_ms, fps);
    if frames > GIF_MAX_FRAMES {
        return Err(ExportError::GifTooManyFrames);
    }
    Ok(NormalizedGifOptions {
        edge: dimensions.edge_px,
        fps,
        loop_: true,
        width: dimensions.width,
        height: dimensions.height,
        frames,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_match_plan_section_9_1() {
        let limits = ExportLimits::default();
        assert_eq!(limits, ExportLimits::baseline());
        assert_eq!(limits.queue.max_concurrent_encodes, 1);
        assert_eq!(limits.queue.max_pending, 2);
        assert_eq!(limits.gif.max_duration_ms, 60_000);
        assert_eq!(limits.gif.max_edge_px, 1280);
        assert_eq!(limits.gif.min_edge_px, 16);
        assert_eq!(limits.gif.max_frames, 1200);
        assert_eq!(limits.gif.frame_rates, [10, 15, 20]);
        assert_eq!(limits.segments.max_segments, 20);
        assert_eq!(limits.segments.min_segment_ms, 100);
        // 计划 §9.1 的独立常量也要对齐。
        assert_eq!(MAX_ACTIVE_TASKS, 1);
        assert_eq!(MAX_QUEUED_TASKS, 2);
        assert_eq!(GIF_MAX_DURATION_MS, 60_000);
        assert_eq!(GIF_MAX_EDGE_PX, 1280);
        assert_eq!(GIF_MAX_FRAMES, 1200);
        assert_eq!(MAX_SEGMENTS, 20);
        assert_eq!(MIN_RANGE_MS, 100);
        assert_eq!(MIN_SEGMENT_MS, 100);
    }

    #[test]
    fn queue_admission_matches_baseline_capacity() {
        let queue = ExportQueueLimits::baseline();
        assert_eq!(queue.admit(0, 0), Ok(QueueSlot::Encode));
        assert_eq!(queue.admit(0, 2), Ok(QueueSlot::Encode));
        assert_eq!(queue.admit(1, 0), Ok(QueueSlot::Pending));
        assert_eq!(queue.admit(1, 1), Ok(QueueSlot::Pending));
        assert_eq!(queue.admit(1, 2), Err(ExportError::QueueFull));
        assert_eq!(queue.admit(2, 0), Ok(QueueSlot::Pending));
    }

    #[test]
    fn estimate_frames_uses_ceiling() {
        assert_eq!(estimate_gif_frames(0, 10), 0);
        assert_eq!(estimate_gif_frames(100, 10), 1);
        assert_eq!(estimate_gif_frames(1000, 10), 10);
        assert_eq!(estimate_gif_frames(1500, 15), 23, "22.5 frames ceil to 23");
        assert_eq!(estimate_gif_frames(60_000, 20), 1200);
        // JS `finiteNumber(fps) || GIF_FRAME_RATES[1]`：0 回落 15 fps。
        assert_eq!(estimate_gif_frames(1000, 0), 15);
    }

    #[test]
    fn gif_dimensions_clamp_and_never_upscale() {
        assert_eq!(
            compute_gif_dimensions(1920, 1080, None).expect("clamp to 1280 long edge"),
            GifDimensions {
                width: 1280,
                height: 720,
                edge_px: 1280
            }
        );
        assert_eq!(
            compute_gif_dimensions(640, 360, Some(1280)).expect("no upscale"),
            GifDimensions {
                width: 640,
                height: 360,
                edge_px: 640
            }
        );
        assert_eq!(
            compute_gif_dimensions(1280, 720, None).expect("exactly at cap"),
            GifDimensions {
                width: 1280,
                height: 720,
                edge_px: 1280
            }
        );
        let odd = compute_gif_dimensions(1281, 721, Some(1280)).expect("odd source");
        assert!(odd.edge_px <= 1280);
        assert_eq!(odd.edge_px, 1280);

        assert_eq!(
            compute_gif_dimensions(0, 100, None),
            Err(ExportError::InvalidSourceSize)
        );
        assert_eq!(
            compute_gif_dimensions(100, 0, None),
            Err(ExportError::InvalidSourceSize)
        );
        assert_eq!(
            compute_gif_dimensions(100, 100, Some(GIF_MIN_EDGE_PX - 1)),
            Err(ExportError::GifInvalidEdge)
        );
        assert_eq!(
            compute_gif_dimensions(100, 100, Some(GIF_MAX_EDGE_PX + 1)),
            Err(ExportError::GifInvalidEdge)
        );
    }

    #[test]
    fn normalize_gif_options_matches_js_rules() {
        let source = SourceSize {
            width: 1920,
            height: 1080,
        };
        let options = normalize_gif_options(
            GifOptionsInput {
                fps: Some(15),
                edge: Some(1280),
                max_edge_px: None,
                loop_: None,
            },
            source,
            5000,
        )
        .expect("valid gif options");
        assert_eq!(
            options,
            NormalizedGifOptions {
                edge: 1280,
                fps: 15,
                loop_: true,
                width: 1280,
                height: 720,
                frames: 75
            }
        );

        // `maxEdgePx` 旧字段名在没有 `edge` 时生效。
        let legacy_alias = normalize_gif_options(
            GifOptionsInput {
                fps: Some(15),
                edge: None,
                max_edge_px: Some(1280),
                loop_: None,
            },
            source,
            5000,
        )
        .expect("legacy alias accepted");
        assert_eq!(legacy_alias, options);

        assert_eq!(
            normalize_gif_options(
                GifOptionsInput {
                    fps: Some(15),
                    ..GifOptionsInput::default()
                },
                source,
                0
            ),
            Err(ExportError::DurationUnavailable)
        );
        assert_eq!(
            normalize_gif_options(
                GifOptionsInput {
                    fps: Some(15),
                    ..GifOptionsInput::default()
                },
                source,
                GIF_MAX_DURATION_MS + 1
            ),
            Err(ExportError::GifTooLong)
        );
        for bad_fps in [None, Some(0), Some(12), Some(30)] {
            assert_eq!(
                normalize_gif_options(
                    GifOptionsInput {
                        fps: bad_fps,
                        ..GifOptionsInput::default()
                    },
                    source,
                    1000
                ),
                Err(ExportError::GifInvalidFps),
                "fps={bad_fps:?}"
            );
        }
        assert_eq!(
            normalize_gif_options(
                GifOptionsInput {
                    fps: Some(15),
                    loop_: Some(false),
                    ..GifOptionsInput::default()
                },
                source,
                1000
            ),
            Err(ExportError::GifLoopRequired)
        );
        assert_eq!(
            normalize_gif_options(
                GifOptionsInput {
                    fps: Some(15),
                    edge: Some(GIF_MIN_EDGE_PX - 1),
                    ..GifOptionsInput::default()
                },
                source,
                1000
            ),
            Err(ExportError::GifInvalidEdge)
        );
        assert_eq!(
            normalize_gif_options(
                GifOptionsInput {
                    fps: Some(15),
                    ..GifOptionsInput::default()
                },
                SourceSize {
                    width: 0,
                    height: 0
                },
                1000
            ),
            Err(ExportError::InvalidSourceSize)
        );
    }

    #[test]
    fn normalize_segments_empty_means_full_recording() {
        let normalized = normalize_segments(&[], 10_000).expect("empty = full");
        assert_eq!(
            normalized.segments,
            [TimeRange {
                start_ms: 0,
                end_ms: 10_000
            }]
        );
        assert_eq!(normalized.total_duration_ms, 10_000);

        assert_eq!(
            normalize_segments(&[], 0),
            Err(ExportError::DurationUnavailable)
        );
        assert_eq!(
            normalize_segments(&[], -1),
            Err(ExportError::DurationUnavailable)
        );
    }

    #[test]
    fn normalize_segments_sorts_and_rejects_overlaps_but_allows_adjacency() {
        let input = [
            RawSegment {
                start_ms: 3000,
                end_ms: 3500,
            },
            RawSegment {
                start_ms: 1000,
                end_ms: 2000,
            },
        ];
        let normalized = normalize_segments(&input, 5000).expect("sorted");
        assert_eq!(
            normalized.segments,
            [
                TimeRange {
                    start_ms: 1000,
                    end_ms: 2000
                },
                TimeRange {
                    start_ms: 3000,
                    end_ms: 3500
                }
            ]
        );
        assert_eq!(normalized.total_duration_ms, 1500);

        let touching = [
            RawSegment {
                start_ms: 0,
                end_ms: 1000,
            },
            RawSegment {
                start_ms: 1000,
                end_ms: 2000,
            },
        ];
        let normalized = normalize_segments(&touching, 5000).expect("touching allowed");
        assert_eq!(
            normalized.segments.len(),
            2,
            "adjacent segments are never merged"
        );
        assert_eq!(normalized.total_duration_ms, 2000);

        let overlapping = [
            RawSegment {
                start_ms: 0,
                end_ms: 1000,
            },
            RawSegment {
                start_ms: 500,
                end_ms: 1500,
            },
        ];
        assert_eq!(
            normalize_segments(&overlapping, 5000),
            Err(ExportError::OverlappingSegments)
        );
    }

    #[test]
    fn normalize_segments_enforces_bounds_and_minimum_length() {
        // ±1 ms 容差内夹取，不报错。
        let slack = normalize_segments(
            &[RawSegment {
                start_ms: -1,
                end_ms: 500,
            }],
            5000,
        )
        .expect("start -1 clamps to 0");
        assert_eq!(
            slack.segments,
            [TimeRange {
                start_ms: 0,
                end_ms: 500
            }]
        );
        let tail_slack = normalize_segments(
            &[RawSegment {
                start_ms: 0,
                end_ms: 5001,
            }],
            5000,
        )
        .expect("end duration+1 clamps to duration");
        assert_eq!(
            tail_slack.segments,
            [TimeRange {
                start_ms: 0,
                end_ms: 5000
            }]
        );

        assert_eq!(
            normalize_segments(
                &[RawSegment {
                    start_ms: -2,
                    end_ms: 500
                }],
                5000
            ),
            Err(ExportError::RangeOutOfBounds)
        );
        assert_eq!(
            normalize_segments(
                &[RawSegment {
                    start_ms: 0,
                    end_ms: 5002
                }],
                5000
            ),
            Err(ExportError::RangeOutOfBounds)
        );
        assert_eq!(
            normalize_segments(
                &[RawSegment {
                    start_ms: 1000,
                    end_ms: 1000
                }],
                5000
            ),
            Err(ExportError::InvalidRange)
        );
        assert_eq!(
            normalize_segments(
                &[RawSegment {
                    start_ms: 1000,
                    end_ms: 1099
                }],
                5000
            ),
            Err(ExportError::RangeTooShort)
        );
        normalize_segments(
            &[RawSegment {
                start_ms: 1000,
                end_ms: 1100,
            }],
            5000,
        )
        .expect("exactly 100 ms is legal");
    }

    #[test]
    fn normalize_segments_limits_the_segment_count() {
        let twenty: Vec<RawSegment> = (0..20)
            .map(|index| RawSegment {
                start_ms: (index as i64) * 1000,
                end_ms: (index as i64) * 1000 + 500,
            })
            .collect();
        normalize_segments(&twenty, 100_000).expect("20 segments are legal");

        let mut twenty_one = twenty.clone();
        twenty_one.push(RawSegment {
            start_ms: 99_000,
            end_ms: 99_500,
        });
        assert_eq!(
            normalize_segments(&twenty_one, 100_000),
            Err(ExportError::TooManySegments)
        );
    }

    #[test]
    fn normalize_segments_canonicalises_full_coverage() {
        for (start, end) in [(0, 10_000), (1, 10_000), (0, 9_999), (1, 9_999)] {
            let normalized = normalize_segments(
                &[RawSegment {
                    start_ms: start,
                    end_ms: end,
                }],
                10_000,
            )
            .expect("full range");
            assert_eq!(
                normalized.segments,
                [TimeRange {
                    start_ms: 0,
                    end_ms: 10_000
                }],
                "start={start} end={end}"
            );
            assert_eq!(normalized.total_duration_ms, 10_000);
        }
    }

    #[test]
    fn error_codes_match_the_js_fail_codes() {
        for (error, code) in [
            (ExportError::DurationUnavailable, "duration-unavailable"),
            (ExportError::InvalidRange, "invalid-range"),
            (ExportError::RangeOutOfBounds, "range-out-of-bounds"),
            (ExportError::RangeTooShort, "range-too-short"),
            (ExportError::TooManySegments, "too-many-segments"),
            (ExportError::OverlappingSegments, "overlapping-segments"),
            (ExportError::InvalidSourceSize, "invalid-source-size"),
            (ExportError::GifTooLong, "gif-too-long"),
            (ExportError::GifInvalidFps, "gif-invalid-fps"),
            (ExportError::GifLoopRequired, "gif-loop-required"),
            (ExportError::GifInvalidEdge, "gif-invalid-edge"),
            (ExportError::GifTooManyFrames, "gif-too-many-frames"),
            (ExportError::QueueFull, "queue-full"),
        ] {
            assert_eq!(error.code(), code);
            assert_eq!(error.to_string(), code);
        }
    }
}
