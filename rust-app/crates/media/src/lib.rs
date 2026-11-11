//! 媒体 crate（计划 §3.1 `media`）。
//!
//! R0 只交付录屏导出限制的纯类型与校验（计划 §9.1），以及 R5 的 trait 骨架；
//! 采集、编码、FFmpeg 与发布流程属于 R5。
//!
//! 常量与语义基线是 `shared/recording-export-options.js`；Rust 不复制夹具内容，
//! 夹具落地后由集成测试对照（缺失时显式 skip）。
#![forbid(unsafe_code)]

pub mod backend;
pub mod export;

pub use backend::{
    AudioSources, ExportScheduler, ExportTaskId, ExportTaskRequest, ExportTaskState,
    FinishedRecording, RecordingBackend, RecordingHandle, RecordingTarget, StartRecordingRequest,
};
pub use export::{
    compute_gif_dimensions, estimate_gif_frames, normalize_gif_options, normalize_segments,
    ExportError, ExportLimits, ExportQueueLimits, GifDimensions, GifLimits, GifOptionsInput,
    NormalizedGifOptions, NormalizedSegments, QueueSlot, RawSegment, SegmentLimits, SourceSize,
    TimeRange, GIF_FRAME_RATES, GIF_MAX_DURATION_MS, GIF_MAX_EDGE_PX, GIF_MAX_FRAMES,
    GIF_MIN_EDGE_PX, MAX_ACTIVE_TASKS, MAX_QUEUED_TASKS, MAX_SEGMENTS, MIN_RANGE_MS,
    MIN_SEGMENT_MS,
};
