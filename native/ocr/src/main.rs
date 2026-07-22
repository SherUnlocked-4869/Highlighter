use std::env;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use image::imageops::FilterType;
use paddle_ocr_rs::ocr_lite::OcrLite;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DET_MODEL: &str = "ch_PP-OCRv4_det_mobile.onnx";
const CLS_MODEL: &str = "ch_ppocr_mobile_v2.0_cls_mobile.onnx";
const REC_MODEL: &str = "ch_PP-OCRv4_rec_mobile.onnx";

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
    let threads = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(2)
        .clamp(1, 8);
    let mut engine = OcrLite::new();
    engine
        .init_models(
            &det.to_string_lossy(),
            &cls.to_string_lossy(),
            &rec.to_string_lossy(),
            threads,
        )
        .map_err(|error| format!("Failed to initialize OCR models: {error}"))?;
    Ok(engine)
}

fn recognize(engine: &mut OcrLite, request: &Request) -> Result<DetectResponse, String> {
    let image_path = request
        .image_path
        .as_deref()
        .ok_or_else(|| "Missing imagePath".to_string())?;
    let source = image::open(image_path)
        .map_err(|error| format!("Failed to open OCR image: {error}"))?
        .to_rgb8();
    let (image_width, image_height) = source.dimensions();
    if image_width < 3 || image_height < 3 {
        return Err("OCR image is too small".to_string());
    }

    let requested_scale = request.scale_factor.unwrap_or(1.0).max(0.1);
    let resize_factor = if requested_scale < 1.5 {
        1.5 / requested_scale
    } else {
        1.0
    };
    let input = if resize_factor > 1.001 {
        image::imageops::resize(
            &source,
            ((image_width as f32 * resize_factor).round() as u32).max(1),
            ((image_height as f32 * resize_factor).round() as u32).max(1),
            FilterType::Lanczos3,
        )
    } else {
        source
    };

    let started = Instant::now();
    let max_side = request.max_side.unwrap_or(4096).clamp(640, 8192);
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
    emit(&json!({
        "type": "ready",
        "engine": "paddleocr",
        "model": "ppocr-v4-ch",
        "initDurationMs": started.elapsed().as_millis()
    }));

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("Failed to read request: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Request>(&line) {
            Ok(request) => {
                if !process_request(&mut engine, request) {
                    break;
                }
            }
            Err(error) => {
                emit(&json!({ "ok": false, "error": format!("Invalid request: {error}") }))
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
