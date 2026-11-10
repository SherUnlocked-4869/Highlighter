//! 对 Node 生成的 `test/fixtures/host-parity/recording-export-options/` 做对照。
//!
//! - `kind: limits`：逐字段严格对照 [`ExportLimits::baseline`]（计划 §9.1 的硬限制）。
//! - `kind: normalize`：用 R0 已移植的 GIF / 多段纯函数对照期望输出或 `reason` 错误码。
//!   视频分辨率/质量/fps 规范化属于 R5（`normalizeVideoOptions`），R0 未移植，**不伪造**
//!   通过，只在输出中登记未覆盖字段。
//!
//! 夹具缺失即失败（不再 skip）：这是 Lead 要求对接的真实产物。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use highlighter_media::{
    estimate_gif_frames, normalize_gif_options, normalize_segments, ExportLimits, GifOptionsInput,
    RawSegment, SourceSize,
};
use serde::de::DeserializeOwned;
use serde::Deserialize;

const FORMAT: &str = "recording-export-options.v1";

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("rust-app/crates/media is three levels below the repository root")
        .join("test")
        .join("fixtures")
        .join("host-parity")
        .join("recording-export-options")
}

fn load_json<T: DeserializeOwned>(path: &Path) -> T {
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|error| panic!("parse {} as UTF-8 JSON: {error}", path.display()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    schema_version: u32,
    case_id: String,
    format: String,
    source: Vec<String>,
    expect: String,
    kind: String,
    #[serde(default)]
    expected_limits: Option<LimitsCase>,
    #[serde(default)]
    request: Option<RequestCase>,
    #[serde(default)]
    metadata: Option<MetadataCase>,
    #[serde(default)]
    expected: Option<ExpectedCase>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitsCase {
    queue: QueueLimitsCase,
    gif: GifLimitsCase,
    segments: SegmentLimitsCase,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueLimitsCase {
    max_concurrent_encodes: u32,
    max_pending: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GifLimitsCase {
    max_duration_ms: u64,
    max_long_edge_px: u32,
    max_frames: u32,
    fps: Vec<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SegmentLimitsCase {
    max_segments: usize,
    max_segment_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestCase {
    format: String,
    #[serde(default)]
    segments: Vec<SegmentCase>,
    #[serde(default)]
    gif: Option<GifRequestCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SegmentCase {
    start_ms: i64,
    end_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GifRequestCase {
    #[serde(default)]
    edge: Option<u32>,
    #[serde(default)]
    max_edge_px: Option<u32>,
    #[serde(default)]
    fps: Option<u32>,
    #[serde(default, rename = "loop")]
    loop_: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataCase {
    duration_ms: i64,
    video: VideoSizeCase,
}

#[derive(Debug, Deserialize)]
struct VideoSizeCase {
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedCase {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    segments: Vec<SegmentCase>,
    #[serde(default)]
    total_duration_ms: Option<u64>,
    #[serde(default)]
    gif: Option<GifExpectedCase>,
    #[serde(default)]
    source_width: Option<u32>,
    #[serde(default)]
    source_height: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GifExpectedCase {
    edge: u32,
    max_edge_px: u32,
    fps: u32,
    #[serde(rename = "loop")]
    loop_: bool,
    width: u32,
    height: u32,
    frames: u32,
}

fn check_limits(case: &Case) {
    let expected = case
        .expected_limits
        .as_ref()
        .unwrap_or_else(|| panic!("{}: expectedLimits missing", case.case_id));
    let baseline = ExportLimits::baseline();

    assert_eq!(
        expected.queue.max_concurrent_encodes, baseline.queue.max_concurrent_encodes,
        "{}: queue.maxConcurrentEncodes",
        case.case_id
    );
    assert_eq!(
        expected.queue.max_pending, baseline.queue.max_pending,
        "{}: queue.maxPending",
        case.case_id
    );
    assert_eq!(
        expected.gif.max_duration_ms, baseline.gif.max_duration_ms,
        "{}: gif.maxDurationMs",
        case.case_id
    );
    assert_eq!(
        expected.gif.max_long_edge_px, baseline.gif.max_edge_px,
        "{}: gif.maxLongEdgePx",
        case.case_id
    );
    assert_eq!(
        expected.gif.max_frames, baseline.gif.max_frames,
        "{}: gif.maxFrames",
        case.case_id
    );
    assert_eq!(
        expected.gif.fps,
        baseline.gif.frame_rates.to_vec(),
        "{}: gif.fps",
        case.case_id
    );
    assert_eq!(
        expected.segments.max_segments, baseline.segments.max_segments,
        "{}: segments.maxSegments",
        case.case_id
    );
    assert_eq!(
        expected.segments.max_segment_ms, baseline.segments.min_segment_ms,
        "{}: segments.maxSegmentMs",
        case.case_id
    );
    assert_eq!(case.expect, "valid", "{}: limits case", case.case_id);
}

fn normalize_request(request: &RequestCase) -> Vec<RawSegment> {
    request
        .segments
        .iter()
        .map(|segment| RawSegment {
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
        })
        .collect()
}

fn expected_segments(expected: &ExpectedCase) -> Vec<(i64, i64)> {
    expected
        .segments
        .iter()
        .map(|segment| (segment.start_ms, segment.end_ms))
        .collect()
}

fn assert_expected_source(case: &Case, metadata: &MetadataCase, expected: &ExpectedCase) {
    assert_eq!(
        expected.source_width,
        Some(metadata.video.width),
        "{}: sourceWidth",
        case.case_id
    );
    assert_eq!(
        expected.source_height,
        Some(metadata.video.height),
        "{}: sourceHeight",
        case.case_id
    );
}

fn check_gif_normalize(
    case: &Case,
    request: &RequestCase,
    metadata: &MetadataCase,
    duration_ms: i64,
) {
    let gif = request
        .gif
        .as_ref()
        .unwrap_or_else(|| panic!("{}: request.gif missing", case.case_id));
    let options = GifOptionsInput {
        fps: gif.fps,
        edge: gif.edge,
        max_edge_px: gif.max_edge_px,
        loop_: gif.loop_,
    };
    let source = SourceSize {
        width: metadata.video.width,
        height: metadata.video.height,
    };
    let duration = u64::try_from(duration_ms)
        .unwrap_or_else(|_| panic!("{}: durationMs must be positive", case.case_id));

    if case.expect == "invalid" {
        let reason = case
            .reason
            .as_deref()
            .unwrap_or_else(|| panic!("{}: invalid normalize case must give reason", case.case_id));
        let error = normalize_gif_options(options, source, duration)
            .expect_err("fixture expects an invalid request");
        assert_eq!(error.code(), reason, "{}: error code", case.case_id);
        return;
    }

    let normalized = normalize_gif_options(options, source, duration).unwrap_or_else(|error| {
        panic!("{}: expected valid GIF, got {}", case.case_id, error.code())
    });
    let expected = case
        .expected
        .as_ref()
        .unwrap_or_else(|| panic!("{}: expected missing", case.case_id));
    assert_expected_source(case, metadata, expected);
    assert_eq!(
        expected
            .gif
            .as_ref()
            .map(|gif| (gif.edge, gif.fps, gif.width, gif.height, gif.frames)),
        Some((
            normalized.edge,
            normalized.fps,
            normalized.width,
            normalized.height,
            normalized.frames
        )),
        "{}: expected.gif tuple (edge, fps, width, height, frames)",
        case.case_id
    );
    let gif_expected = expected.gif.as_ref().expect("checked above");
    assert_eq!(
        normalized.edge, gif_expected.edge,
        "{}: gif.edge",
        case.case_id
    );
    assert_eq!(
        normalized.edge, gif_expected.max_edge_px,
        "{}: gif.maxEdgePx alias",
        case.case_id
    );
    assert_eq!(
        normalized.fps, gif_expected.fps,
        "{}: gif.fps",
        case.case_id
    );
    assert_eq!(
        normalized.loop_, gif_expected.loop_,
        "{}: gif.loop",
        case.case_id
    );
    assert_eq!(
        normalized.width, gif_expected.width,
        "{}: gif.width",
        case.case_id
    );
    assert_eq!(
        normalized.height, gif_expected.height,
        "{}: gif.height",
        case.case_id
    );
    assert_eq!(
        normalized.frames, gif_expected.frames,
        "{}: gif.frames",
        case.case_id
    );
    assert_eq!(
        normalized.frames,
        estimate_gif_frames(duration, normalized.fps),
        "{}: frames must agree with estimate_gif_frames",
        case.case_id
    );
    assert_eq!(
        expected.format.as_deref(),
        Some("gif"),
        "{}: expected.format",
        case.case_id
    );

    // GIF 请求没有显式 segments：空 = 整段，用同一规则交叉校验期望值。
    let segments = normalize_segments(&[], duration_ms)
        .unwrap_or_else(|error| panic!("{}: full-range segments: {}", case.case_id, error.code()));
    let actual: Vec<(i64, i64)> = segments
        .segments
        .iter()
        .map(|segment| (segment.start_ms as i64, segment.end_ms as i64))
        .collect();
    assert_eq!(
        actual,
        expected_segments(expected),
        "{}: segments",
        case.case_id
    );
    assert_eq!(
        Some(segments.total_duration_ms),
        expected.total_duration_ms,
        "{}: totalDurationMs",
        case.case_id
    );
}

fn check_segment_normalize(
    case: &Case,
    request: &RequestCase,
    metadata: &MetadataCase,
    duration_ms: i64,
) {
    let raw = normalize_request(request);
    let normalized = normalize_segments(&raw, duration_ms)
        .unwrap_or_else(|error| panic!("{}: segments rejected: {}", case.case_id, error.code()));
    let expected = case
        .expected
        .as_ref()
        .unwrap_or_else(|| panic!("{}: expected missing", case.case_id));
    assert_expected_source(case, metadata, expected);

    let actual: Vec<(i64, i64)> = normalized
        .segments
        .iter()
        .map(|segment| (segment.start_ms as i64, segment.end_ms as i64))
        .collect();
    assert_eq!(
        actual,
        expected_segments(expected),
        "{}: segments",
        case.case_id
    );
    assert_eq!(
        Some(normalized.total_duration_ms),
        expected.total_duration_ms,
        "{}: totalDurationMs",
        case.case_id
    );
    assert_eq!(
        expected.format.as_deref(),
        Some(request.format.as_str()),
        "{}: expected.format",
        case.case_id
    );
    eprintln!(
        "note {}: video normalisation (resolution/quality/fps) is R5 scope, not verified here",
        case.case_id
    );
}

fn check_normalize(case: &Case) {
    let request = case
        .request
        .as_ref()
        .unwrap_or_else(|| panic!("{}: request missing", case.case_id));
    let metadata = case
        .metadata
        .as_ref()
        .unwrap_or_else(|| panic!("{}: metadata missing", case.case_id));
    match request.format.as_str() {
        "gif" => check_gif_normalize(case, request, metadata, metadata.duration_ms),
        "mp4" | "webm" => check_segment_normalize(case, request, metadata, metadata.duration_ms),
        other => panic!("{}: unsupported normalize format `{other}`", case.case_id),
    }
}

#[test]
fn recording_export_options_fixtures_match_the_rust_validation() {
    let dir = fixtures_dir();
    assert!(
        dir.is_dir(),
        "recording-export-options fixtures missing at {} (contract-inventory must generate them)",
        dir.display()
    );

    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
        .map(|entry| {
            entry
                .unwrap_or_else(|error| panic!("read entry: {error}"))
                .path()
        })
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect();
    assert!(
        !paths.is_empty(),
        "{} contains no fixture cases",
        dir.display()
    );
    paths.sort();

    let mut seen = BTreeSet::new();
    let mut kinds = BTreeSet::new();
    for path in &paths {
        let case: Case = load_json(path);
        assert_eq!(case.schema_version, 1, "{}: schemaVersion", case.case_id);
        assert_eq!(case.format, FORMAT, "{}: format", case.case_id);
        assert!(
            case.case_id.starts_with("recording-export-options/"),
            "{}: caseId prefix",
            case.case_id
        );
        assert!(
            seen.insert(case.case_id.clone()),
            "{}: duplicate caseId",
            case.case_id
        );
        assert!(
            case.source
                .iter()
                .any(|source| source == "shared/recording-export-options.js"),
            "{}: source must include shared/recording-export-options.js",
            case.case_id
        );
        assert!(
            matches!(case.expect.as_str(), "valid" | "invalid"),
            "{}: expect must be valid|invalid",
            case.case_id
        );

        kinds.insert(case.kind.clone());
        match case.kind.as_str() {
            "limits" => check_limits(&case),
            "normalize" => check_normalize(&case),
            other => panic!("{}: unsupported fixture kind `{other}`", case.case_id),
        }
    }

    assert!(kinds.contains("limits"), "a `limits` case is mandatory");
    assert!(kinds.contains("normalize"), "normalize cases are expected");
    eprintln!(
        "recording-export-options: {} cases checked (limits + GIF/segment normalize strict; \
         video normalize deferred to R5)",
        paths.len()
    );
}
