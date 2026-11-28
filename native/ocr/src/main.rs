use std::env;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use image::imageops::FilterType;
use ort::execution_providers::CPUExecutionProvider;
use ort::session::builder::{GraphOptimizationLevel, SessionBuilder};
use paddle_ocr_rs::ocr_lite::OcrLite;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DET_MODEL: &str = "ch_PP-OCRv4_det_mobile.onnx";
const CLS_MODEL: &str = "ch_ppocr_mobile_v2.0_cls_mobile.onnx";
const REC_MODEL: &str = "ch_PP-OCRv4_rec_mobile.onnx";
const DEFAULT_MAX_SIDE: u32 = 2048;
const MAX_MAX_SIDE: u32 = 4096;
const MIN_OCR_SCALE: f32 = 1.5;
const MAX_UPSCALED_PIXELS: f32 = 2_000_000.0;

// DEV-06: optional stdin binary image frames. The legacy newline JSON protocol
// with an `imagePath` stays fully supported; frames are only used when the main
// process sees the `stdin-frame-v1` token below in this sidecar's ready line.
//
// Wire layout (all integers little endian):
//   0..4   magic b"HLOC"
//   4      version (currently 1)
//   5      kind (1 = recognize; reserved for future request kinds)
//   6..8   reserved, must be zero
//   8..12  header length in bytes (1..=FRAME_HEADER_LIMIT)
//   12..16 body length in bytes (1..=FRAME_BODY_LIMIT)
//   16..   header: UTF-8 JSON object with the request id and options
//   ..     body: exactly body_length encoded image bytes (PNG from the main process)
const FRAME_MAGIC: &[u8; 4] = b"HLOC";
const FRAME_VERSION: u8 = 1;
const FRAME_KIND_RECOGNIZE: u8 = 1;
const FRAME_FIXED_BYTES: usize = 16;
const FRAME_PREFIX_BYTES: usize = FRAME_FIXED_BYTES - FRAME_MAGIC.len();
const FRAME_HEADER_LIMIT: usize = 8 * 1024;
const FRAME_BODY_LIMIT: usize = 64 * 1024 * 1024;
const IMAGE_TRANSFER_FRAME: &str = "stdin-frame-v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: Option<String>,
    action: String,
    image_path: Option<PathBuf>,
    scale_factor: Option<f32>,
    detect_angle: Option<bool>,
    max_side: Option<u32>,
    min_confidence: Option<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetectResponse {
    engine: &'static str,
    model: &'static str,
    image_width: u32,
    image_height: u32,
    duration_ms: u128,
    text: String,
    text_blocks: Vec<paddle_ocr_rs::ocr_result::TextBlock>,
}

fn emit(value: &Value) {
    let mut stdout = io::stdout().lock();
    if serde_json::to_writer(&mut stdout, value).is_ok() {
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
}

fn require_models(model_dir: &Path) -> Result<[PathBuf; 3], String> {
    let models = [
        model_dir.join(DET_MODEL),
        model_dir.join(CLS_MODEL),
        model_dir.join(REC_MODEL),
    ];
    for model in &models {
        if !model.is_file() {
            return Err(format!("OCR model is missing: {}", model.display()));
        }
    }
    Ok(models)
}

fn create_engine(model_dir: &Path) -> Result<OcrLite, String> {
    let [det, cls, rec] = require_models(model_dir)?;
    let mut engine = OcrLite::new();
    engine
        .init_models_custom(
            &det.to_string_lossy(),
            &cls.to_string_lossy(),
            &rec.to_string_lossy(),
            configure_session,
        )
        .map_err(|error| format!("Failed to initialize OCR models: {error}"))?;
    Ok(engine)
}

fn configure_session(builder: SessionBuilder) -> Result<SessionBuilder, ort::Error> {
    let threads = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(2)
        .clamp(1, 4);
    builder
        .with_execution_providers([CPUExecutionProvider::default()
            .with_arena_allocator(true)
            .build()])?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(threads)?
        .with_inter_threads(1)?
        .with_memory_pattern(false)
}

fn calculate_resize_factor(
    image_width: u32,
    image_height: u32,
    requested_scale: f32,
    max_side: u32,
) -> f32 {
    let desired_factor = (MIN_OCR_SCALE / requested_scale.max(0.1)).max(1.0);
    if desired_factor <= 1.0 {
        return 1.0;
    }

    let source_max_side = image_width.max(image_height).max(1) as f32;
    let source_pixels = (image_width as f32 * image_height as f32).max(1.0);
    let side_factor = max_side as f32 / source_max_side;
    let area_factor = (MAX_UPSCALED_PIXELS / source_pixels).sqrt();
    desired_factor.min(side_factor).min(area_factor).max(1.0)
}

fn recognize(engine: &mut OcrLite, request: &Request) -> Result<DetectResponse, String> {
    let image_path = request
        .image_path
        .as_deref()
        .ok_or_else(|| "Missing imagePath".to_string())?;
    let source = image::open(image_path)
        .map_err(|error| format!("Failed to open OCR image: {error}"))?
        .to_rgb8();
    recognize_source(engine, request, source)
}

/// Decodes the encoded image carried by a stdin binary frame. The bytes never
/// touch the file system: the frame body is decoded straight from memory.
fn decode_image_bytes(body: &[u8]) -> Result<image::RgbImage, String> {
    if body.is_empty() {
        return Err("OCR image frame is empty".to_string());
    }
    image::load_from_memory(body)
        .map_err(|error| format!("Failed to decode OCR image: {error}"))
        .map(|image| image.to_rgb8())
}

/// Runs the detector on already-decoded pixels. The legacy `imagePath` line and
/// the binary frame both land here, so resizing, filtering and `textBlocks`
/// coordinates are identical for both transports.
fn recognize_source(
    engine: &mut OcrLite,
    request: &Request,
    source: image::RgbImage,
) -> Result<DetectResponse, String> {
    let (image_width, image_height) = source.dimensions();
    if image_width < 3 || image_height < 3 {
        return Err("OCR image is too small".to_string());
    }

    let max_side = request
        .max_side
        .unwrap_or(DEFAULT_MAX_SIDE)
        .clamp(640, MAX_MAX_SIDE);
    let requested_scale = request.scale_factor.unwrap_or(1.0);
    let resize_factor =
        calculate_resize_factor(image_width, image_height, requested_scale, max_side);
    let input = if resize_factor > 1.001 {
        image::imageops::resize(
            &source,
            ((image_width as f32 * resize_factor).round() as u32).max(1),
            ((image_height as f32 * resize_factor).round() as u32).max(1),
            FilterType::CatmullRom,
        )
    } else {
        source
    };

    let started = Instant::now();
    let mut result = engine
        .detect_angle_rollback(
            &input,
            50,
            max_side,
            0.5,
            0.3,
            1.6,
            request.detect_angle.unwrap_or(false),
            false,
            0.9,
        )
        .map_err(|error| format!("OCR detection failed: {error}"))?;

    if resize_factor > 1.001 {
        for block in &mut result.text_blocks {
            for point in &mut block.box_points {
                point.x = ((point.x as f32 / resize_factor).round() as u32).min(image_width);
                point.y = ((point.y as f32 / resize_factor).round() as u32).min(image_height);
            }
        }
    }

    let min_confidence = request.min_confidence.unwrap_or(0.3).clamp(0.0, 1.0);
    result.text_blocks.retain(|block| {
        !block.text.trim().is_empty()
            && block.text_score.is_finite()
            && block.text_score >= min_confidence
    });
    let text = result
        .text_blocks
        .iter()
        .map(|block| block.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    Ok(DetectResponse {
        engine: "paddleocr",
        model: "ppocr-v4-ch",
        image_width,
        image_height,
        duration_ms: started.elapsed().as_millis(),
        text,
        text_blocks: result.text_blocks,
    })
}

// ==================== Stdin frame protocol ====================

enum Incoming {
    Line(String),
    Frame { header: Value, body: Vec<u8> },
}

#[derive(Debug, PartialEq)]
enum FrameError {
    Truncated(String),
    Invalid(String),
    Io(String),
}

impl FrameError {
    fn message(&self) -> String {
        match self {
            FrameError::Truncated(detail) => format!("truncated stdin frame: {detail}"),
            FrameError::Invalid(detail) => format!("invalid stdin frame: {detail}"),
            FrameError::Io(detail) => format!("stdin read failed: {detail}"),
        }
    }
}

fn read_exact_frame<R: Read>(reader: &mut R, buffer: &mut [u8], what: &str) -> Result<(), FrameError> {
    reader.read_exact(buffer).map_err(|error| match error.kind() {
        io::ErrorKind::UnexpectedEof => FrameError::Truncated(format!("{what} ended mid-frame")),
        _ => FrameError::Io(error.to_string()),
    })
}

/// Reads exactly the declared number of bytes for each field. A frame arriving
/// split across pipe reads is reassembled here without losing the stream
/// position; a frame that ends early is a truncation error, never a silent
/// short read.
fn read_frame<R: Read>(reader: &mut R) -> Result<(Value, Vec<u8>), FrameError> {
    let mut magic = [0u8; 4];
    read_exact_frame(reader, &mut magic, "frame magic")?;
    if magic != *FRAME_MAGIC {
        return Err(FrameError::Invalid("magic mismatch".to_string()));
    }
    let mut fixed = [0u8; FRAME_PREFIX_BYTES];
    read_exact_frame(reader, &mut fixed, "frame prefix")?;
    if fixed[0] != FRAME_VERSION {
        return Err(FrameError::Invalid(format!("unsupported frame version {}", fixed[0])));
    }
    if fixed[1] != FRAME_KIND_RECOGNIZE {
        return Err(FrameError::Invalid(format!("unsupported frame kind {}", fixed[1])));
    }
    if u16::from_le_bytes([fixed[2], fixed[3]]) != 0 {
        return Err(FrameError::Invalid("reserved field is not zero".to_string()));
    }
    let header_len = u32::from_le_bytes(fixed[4..8].try_into().unwrap()) as usize;
    let body_len = u32::from_le_bytes(fixed[8..12].try_into().unwrap()) as usize;
    if header_len == 0 || header_len > FRAME_HEADER_LIMIT {
        return Err(FrameError::Invalid(format!("header length {header_len} is out of range")));
    }
    if body_len == 0 || body_len > FRAME_BODY_LIMIT {
        return Err(FrameError::Invalid(format!("body length {body_len} is out of range")));
    }
    let mut header_bytes = vec![0u8; header_len];
    read_exact_frame(reader, &mut header_bytes, "frame header")?;
    let header: Value = serde_json::from_slice(&header_bytes)
        .map_err(|error| FrameError::Invalid(format!("header is not valid JSON: {error}")))?;
    if !header.is_object() {
        return Err(FrameError::Invalid("header must be a JSON object".to_string()));
    }
    let mut body = vec![0u8; body_len];
    read_exact_frame(reader, &mut body, "frame body")?;
    Ok((header, body))
}

/// Dispatches on the first non-whitespace byte of the stream. Legacy requests
/// are newline-delimited JSON objects and therefore start with `{`; binary
/// frames start with the `H` of the `HLOC` magic. A frame is consumed by its
/// declared lengths, so the request after its body starts immediately and
/// adjacent frames never run together.
fn read_incoming<R: BufRead>(reader: &mut R) -> Result<Option<Incoming>, FrameError> {
    loop {
        let buffer = reader
            .fill_buf()
            .map_err(|error| FrameError::Io(error.to_string()))?;
        if buffer.is_empty() {
            return Ok(None);
        }
        match buffer[0] {
            b'\n' | b'\r' | b' ' | b'\t' => reader.consume(1),
            b'H' => {
                let (header, body) = read_frame(reader)?;
                return Ok(Some(Incoming::Frame { header, body }));
            }
            _ => {
                let mut line = Vec::new();
                let read = reader
                    .read_until(b'\n', &mut line)
                    .map_err(|error| FrameError::Io(error.to_string()))?;
                if read == 0 {
                    return Ok(None);
                }
                let text = String::from_utf8(line)
                    .map_err(|_| FrameError::Invalid("request line is not UTF-8".to_string()))?;
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                return Ok(Some(Incoming::Line(trimmed.to_string())));
            }
        }
    }
}

fn ready_message(init_duration_ms: u128) -> Value {
    json!({
        "type": "ready",
        "engine": "paddleocr",
        "model": "ppocr-v4-ch",
        "initDurationMs": init_duration_ms,
        // DEV-06 capability negotiation. Unknown members are ignored by an old
        // main process, which keeps using the legacy imagePath line protocol and
        // still works against this sidecar. The new main process sends binary
        // frames only when this exact token is advertised.
        "protocol": {
            "imageTransfer": IMAGE_TRANSFER_FRAME,
            "maxFrameHeaderBytes": FRAME_HEADER_LIMIT as u64,
            "maxFrameBodyBytes": FRAME_BODY_LIMIT as u64,
        }
    })
}

fn process_request(engine: &mut OcrLite, request: Request) -> bool {
    let id = request.id.clone();
    if request.action == "shutdown" {
        emit(&json!({ "id": id, "ok": true }));
        return false;
    }
    if request.action != "recognize" {
        emit(&json!({ "id": id, "ok": false, "error": "Unsupported OCR action" }));
        return true;
    }
    match recognize(engine, &request) {
        Ok(result) => emit(&json!({ "id": id, "ok": true, "result": result })),
        Err(error) => emit(&json!({ "id": id, "ok": false, "error": error })),
    }
    true
}

fn process_line(engine: &mut OcrLite, line: &str) -> bool {
    if line.trim().is_empty() {
        return true;
    }
    match serde_json::from_str::<Request>(line) {
        Ok(request) => process_request(engine, request),
        Err(error) => {
            emit(&json!({ "ok": false, "error": format!("Invalid request: {error}") }));
            true
        }
    }
}

/// Handles one binary image frame. Responses stay in the same newline JSON
/// shape as the legacy protocol, so the main process parses both paths with the
/// same response reader.
fn process_frame(engine: &mut OcrLite, header: Value, body: Vec<u8>) -> bool {
    let request = match serde_json::from_value::<Request>(header) {
        Ok(request) => request,
        Err(error) => {
            emit(&json!({ "ok": false, "error": format!("Invalid frame request: {error}") }));
            return true;
        }
    };
    let id = request.id.clone();
    if request.action == "shutdown" {
        emit(&json!({ "id": id, "ok": true }));
        return false;
    }
    if request.action != "recognize" {
        emit(&json!({ "id": id, "ok": false, "error": "Unsupported OCR action" }));
        return true;
    }
    let source = match decode_image_bytes(&body) {
        Ok(source) => source,
        Err(error) => {
            emit(&json!({ "id": id, "ok": false, "error": error }));
            return true;
        }
    };
    match recognize_source(engine, &request, source) {
        Ok(result) => emit(&json!({ "id": id, "ok": true, "result": result })),
        Err(error) => emit(&json!({ "id": id, "ok": false, "error": error })),
    }
    true
}

fn parse_args() -> Result<PathBuf, String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let position = args
        .iter()
        .position(|arg| arg == "--model-dir")
        .ok_or_else(|| "Usage: HighlighterOcrSidecar.exe --model-dir <path>".to_string())?;
    args.get(position + 1)
        .map(PathBuf::from)
        .ok_or_else(|| "Missing value for --model-dir".to_string())
}

fn run() -> Result<(), String> {
    let model_dir = parse_args()?;
    let started = Instant::now();
    let mut engine = create_engine(&model_dir)?;
    emit(&ready_message(started.elapsed().as_millis()));

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    loop {
        match read_incoming(&mut reader) {
            Ok(None) => break,
            Ok(Some(Incoming::Line(line))) => {
                if !process_line(&mut engine, &line) {
                    break;
                }
            }
            Ok(Some(Incoming::Frame { header, body })) => {
                if !process_frame(&mut engine, header, body) {
                    break;
                }
            }
            Err(error) => {
                // After a truncated or malformed frame the stream position is
                // unknown, so the process must not keep reading. Exiting lets
                // the main process drop every pending request and start a fresh
                // handshake instead of trusting a desynchronised pipe.
                return Err(format!("OCR protocol error: {}", error.message()));
            }
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        emit(&json!({ "type": "fatal", "error": error }));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upscales_small_low_dpi_images() {
        assert!((calculate_resize_factor(800, 600, 1.0, 2048) - 1.5).abs() < f32::EPSILON);
        assert!((calculate_resize_factor(800, 600, 1.25, 2048) - 1.2).abs() < f32::EPSILON);
    }

    #[test]
    fn does_not_upscale_full_hd_images() {
        assert!((calculate_resize_factor(1920, 1080, 1.0, 2048) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn respects_max_side_for_wide_images() {
        let factor = calculate_resize_factor(1600, 400, 1.0, 2048);
        assert!((factor - 1.28).abs() < 0.001);
    }

    #[test]
    fn does_not_downscale_in_the_upscale_stage() {
        assert!((calculate_resize_factor(3840, 2160, 1.0, 2048) - 1.0).abs() < f32::EPSILON);
        assert!((calculate_resize_factor(800, 600, 2.0, 2048) - 1.0).abs() < f32::EPSILON);
    }

    // ===================== DEV-06: stdin binary frames =====================

    /// Delivers at most `chunk` bytes per `Read::read` call, which is how a pipe
    /// hands a frame over in several pieces.
    struct ChunkedReader<'a> {
        data: &'a [u8],
        position: usize,
        chunk: usize,
    }

    impl<'a> ChunkedReader<'a> {
        fn new(data: &'a [u8], chunk: usize) -> Self {
            Self { data, position: 0, chunk }
        }
    }

    impl Read for ChunkedReader<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let remaining = self.data.len() - self.position;
            if remaining == 0 {
                return Ok(0);
            }
            let count = remaining.min(buffer.len()).min(self.chunk);
            buffer[..count].copy_from_slice(&self.data[self.position..self.position + count]);
            self.position += count;
            Ok(count)
        }
    }

    fn raw_frame(header: &[u8], body: &[u8], header_len: u32, body_len: u32) -> Vec<u8> {
        let mut frame = Vec::with_capacity(FRAME_FIXED_BYTES + header.len() + body.len());
        frame.extend_from_slice(FRAME_MAGIC);
        frame.push(FRAME_VERSION);
        frame.push(FRAME_KIND_RECOGNIZE);
        frame.extend_from_slice(&0u16.to_le_bytes());
        frame.extend_from_slice(&header_len.to_le_bytes());
        frame.extend_from_slice(&body_len.to_le_bytes());
        frame.extend_from_slice(header);
        frame.extend_from_slice(body);
        frame
    }

    fn encode_frame(header: &Value, body: &[u8]) -> Vec<u8> {
        let header_bytes = serde_json::to_vec(header).unwrap();
        raw_frame(&header_bytes, body, header_bytes.len() as u32, body.len() as u32)
    }

    fn read_error(frame: &[u8]) -> FrameError {
        let mut reader = BufReader::new(frame);
        match read_incoming(&mut reader) {
            Err(error) => error,
            Ok(_) => panic!("stream must be rejected"),
        }
    }

    #[test]
    fn dev06_frame_layout_matches_the_node_contract() {
        let body = b"\x89PNG\r\n\x1a\nframe-body";
        let header = json!({ "id": "req-1", "action": "recognize", "scaleFactor": 1.25 });
        let header_bytes = serde_json::to_vec(&header).unwrap();
        let frame = encode_frame(&header, body);
        assert_eq!(&frame[0..4], FRAME_MAGIC);
        assert_eq!(frame[4], FRAME_VERSION);
        assert_eq!(frame[5], FRAME_KIND_RECOGNIZE);
        assert_eq!(u16::from_le_bytes([frame[6], frame[7]]), 0);
        let header_len = u32::from_le_bytes(frame[8..12].try_into().unwrap()) as usize;
        let body_len = u32::from_le_bytes(frame[12..16].try_into().unwrap()) as usize;
        assert_eq!(header_len, header_bytes.len());
        assert_eq!(body_len, body.len());
        assert_eq!(frame.len(), FRAME_FIXED_BYTES + header_len + body_len);
        assert_eq!(&frame[FRAME_FIXED_BYTES..FRAME_FIXED_BYTES + header_len], header_bytes.as_slice());
        assert_eq!(&frame[FRAME_FIXED_BYTES + header_len..], body);
    }

    #[test]
    fn dev06_reads_split_frames_and_stops_exactly_after_the_declared_body() {
        let first = encode_frame(&json!({ "id": "a", "action": "recognize" }), b"first-body");
        let second = encode_frame(&json!({ "id": "b", "action": "recognize" }), b"second-body");
        let mut stream = first.clone();
        stream.extend_from_slice(&second);
        stream.extend_from_slice(b"{\"id\":\"c\",\"action\":\"shutdown\"}\n");

        // One byte per read: no field ever arrives in one piece.
        let mut reader = BufReader::new(ChunkedReader::new(&stream, 1));
        match read_incoming(&mut reader).unwrap().unwrap() {
            Incoming::Frame { header, body } => {
                assert_eq!(header["id"], "a");
                assert_eq!(body, b"first-body");
            }
            Incoming::Line(_) => panic!("expected the first frame"),
        }
        // Adjacent frame: its magic starts immediately after the previous body.
        match read_incoming(&mut reader).unwrap().unwrap() {
            Incoming::Frame { header, body } => {
                assert_eq!(header["id"], "b");
                assert_eq!(body, b"second-body");
            }
            Incoming::Line(_) => panic!("expected the second frame"),
        }
        // A JSON control line follows the frames on the same stream.
        match read_incoming(&mut reader).unwrap().unwrap() {
            Incoming::Line(line) => assert!(line.contains("\"shutdown\"")),
            Incoming::Frame { .. } => panic!("expected a JSON line after the frames"),
        }
        assert!(read_incoming(&mut reader).unwrap().is_none());
    }

    #[test]
    fn dev06_reports_truncated_frames_as_truncation() {
        let frame = encode_frame(&json!({ "id": "a", "action": "recognize" }), b"0123456789");
        for cut in [
            2usize,
            6,
            14,
            FRAME_FIXED_BYTES,
            FRAME_FIXED_BYTES + 3,
            frame.len() - 1,
        ] {
            let error = read_error(&frame[..cut]);
            assert!(
                matches!(error, FrameError::Truncated(_)),
                "cut at {cut} bytes must be a truncation error, got {error:?}"
            );
        }
    }

    #[test]
    fn dev06_rejects_invalid_frame_fields_and_lengths() {
        let body = b"body";
        let valid_header = serde_json::to_vec(&json!({ "id": "a", "action": "recognize" })).unwrap();

        let mut mutated = raw_frame(&valid_header, body, valid_header.len() as u32, body.len() as u32);
        mutated[1] = b'X'; // magic damaged; still dispatched as a frame because it starts with H
        assert!(matches!(read_error(&mutated), FrameError::Invalid(_)), "magic mismatch");

        let mut mutated = raw_frame(&valid_header, body, valid_header.len() as u32, body.len() as u32);
        mutated[4] = 99; // unsupported version
        assert!(matches!(read_error(&mutated), FrameError::Invalid(_)), "version");

        let mut mutated = raw_frame(&valid_header, body, valid_header.len() as u32, body.len() as u32);
        mutated[5] = 9; // unsupported kind
        assert!(matches!(read_error(&mutated), FrameError::Invalid(_)), "kind");

        let mut mutated = raw_frame(&valid_header, body, valid_header.len() as u32, body.len() as u32);
        mutated[6] = 1; // reserved must stay zero
        assert!(matches!(read_error(&mutated), FrameError::Invalid(_)), "reserved");

        let header_len_zero = raw_frame(&valid_header, body, 0, body.len() as u32);
        assert!(matches!(read_error(&header_len_zero), FrameError::Invalid(_)), "zero header length");

        let header_len_huge = raw_frame(&valid_header, body, (FRAME_HEADER_LIMIT + 1) as u32, body.len() as u32);
        assert!(matches!(read_error(&header_len_huge), FrameError::Invalid(_)), "oversized header");

        let body_len_zero = raw_frame(&valid_header, body, valid_header.len() as u32, 0);
        assert!(matches!(read_error(&body_len_zero), FrameError::Invalid(_)), "zero body length");

        let body_len_huge = raw_frame(&valid_header, body, valid_header.len() as u32, (FRAME_BODY_LIMIT + 1) as u32);
        assert!(matches!(read_error(&body_len_huge), FrameError::Invalid(_)), "oversized body");

        let broken_json = raw_frame(b"not-json", body, 8, body.len() as u32);
        assert!(matches!(read_error(&broken_json), FrameError::Invalid(_)), "header JSON");

        let not_an_object = raw_frame(b"[1,2]", body, 5, body.len() as u32);
        assert!(matches!(read_error(&not_an_object), FrameError::Invalid(_)), "header object");
    }

    #[test]
    fn dev06_decodes_png_body_in_memory() {
        let source = image::RgbImage::from_pixel(3, 2, image::Rgb([10, 20, 30]));
        let mut png = Vec::new();
        source
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode test png");
        let decoded = decode_image_bytes(&png).expect("decode png from frame body");
        assert_eq!(decoded.dimensions(), (3, 2));
        assert_eq!(*decoded.get_pixel(1, 1), image::Rgb([10, 20, 30]));
        let error = decode_image_bytes(b"definitely not an image").unwrap_err();
        assert!(error.contains("Failed to decode OCR image"), "{error}");
    }

    #[test]
    fn dev06_legacy_image_path_line_still_parses_and_ready_keeps_old_fields() {
        let line = "{\"id\":\"old-1\",\"action\":\"recognize\",\"imagePath\":\"C:\\\\tmp\\\\shot.png\",\"scaleFactor\":1.25}\n";
        let mut reader = BufReader::new(line.as_bytes());
        match read_incoming(&mut reader).unwrap().unwrap() {
            Incoming::Line(text) => {
                let request: Request = serde_json::from_str(&text).expect("legacy line parses");
                assert_eq!(request.id.as_deref(), Some("old-1"));
                assert_eq!(request.image_path.as_deref(), Some(Path::new("C:\\tmp\\shot.png")));
                assert_eq!(request.scale_factor, Some(1.25));
            }
            Incoming::Frame { .. } => panic!("a JSON line must not be parsed as a frame"),
        }
        assert!(read_incoming(&mut reader).unwrap().is_none());

        let ready = ready_message(1234);
        assert_eq!(ready["type"], "ready");
        assert_eq!(ready["engine"], "paddleocr");
        assert_eq!(ready["model"], "ppocr-v4-ch");
        assert_eq!(ready["initDurationMs"], 1234);
        assert_eq!(ready["protocol"]["imageTransfer"], IMAGE_TRANSFER_FRAME);
        assert_eq!(ready["protocol"]["maxFrameBodyBytes"], FRAME_BODY_LIMIT as u64);
        assert_eq!(ready["protocol"]["maxFrameHeaderBytes"], FRAME_HEADER_LIMIT as u64);
    }
}
