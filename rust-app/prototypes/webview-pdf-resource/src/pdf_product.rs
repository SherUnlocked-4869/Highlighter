//! 产品真实 `capture/print.html` 的 WebView2 打印模式（`--pdf-product`）。
//!
//! 与 Electron 侧 `scripts/rust/probe-electron-product-pdf.js` 共用
//! `.tmp-r0-pdf/product/product-cases.json`（由 `scripts/rust/pdf-product-cases.js` 调用产品
//! `main/services/pdf-export.js` 生成）。两后端拿到的是**同一份**参数与**同一段**注入脚本：
//!
//! - 纸张参数：manifest 的 `rustOptions`（产品 `computePaperOptions()` 的 micron/scale 结果换算成
//!   WebView2 的英寸口径）与 `electronOptions`（产品 `buildPrintOptions()` 原样）；
//! - DOM 注入：manifest 的 `steps[].script` 是产品 `buildImageInjectionScript()` /
//!   `buildPagesSetupScript()` / `buildPageAppendScript()` 的原文，本模块用
//!   `ICoreWebView2::ExecuteScript` 执行同一段文本，并记录每次调用的 HRESULT/返回 JSON/耗时；
//! - 页面：本进程内置一个只读 HTTP 服务，从仓库根目录原样提供 `capture/print.html` 与
//!   `shared/tokens.css`（不复制、不改产品代码），因此 CSP、`../shared/tokens.css` 引用都是真实页；
//! - 就绪：宿主轮询 `document.readyState`/`location`/`#print-image`，逐步轮询 DOM（图片
//!   decode/追加完成），再调 `PrintToPdfStream`；
//! - 页面来源：真实 print.html 没有 `<script>`，因此不存在页面脚本竞态；ExecuteScript 是否
//!   受页面 CSP 限制、`img-src data:` 是否允许注入图片，都由真实页 CSP 下实测。
//!
//! 一个隐藏窗口按用例导航（URL 带唯一 `?case=`，每次都是全新文档），窗口尺寸取产品
//! `clampWindowSize()`；打印产物 `.tmp-r0-pdf/product/webview2-<name>.pdf`，报告
//! `webview2-product-report.json`。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalSize, Manager, Size, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use webview2_com::ExecuteScriptCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ExecuteScriptCompletedHandler;
use windows::core::PCWSTR;

use crate::pdf::{self, PrintSpec};
use crate::shared::{elapsed_ms, ensure_dir, now_millis, write_json};

/// 产品页打印窗口 label（单窗口按用例导航，降低多 WebView2 环境的内存/数据目录开销）。
pub const PRODUCT_WINDOW_LABEL: &str = "pdf-product";
/// 页面加载就绪 + 逐步 DOM 轮询的超时。
const PAGE_LOAD_TIMEOUT: Duration = Duration::from_secs(45);
const STEP_POLL_TIMEOUT: Duration = Duration::from_secs(30);
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

// ---------------------------------------------------------------------------
// manifest（与 scripts/rust/pdf-product-cases.js 的 JSON 结构一一对应）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: String,
    pub generated_at: String,
    pub root: String,
    pub paths: ManifestPaths,
    pub source_hashes: serde_json::Value,
    pub fixtures: Vec<FixtureRecord>,
    pub cases: Vec<ProductCase>,
    pub constants: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestPaths {
    pub print_page: String,
    pub tokens_css: String,
    pub preload_capture: String,
    pub out_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureRecord {
    pub id: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseImage {
    pub fixture_id: String,
    pub path: String,
    pub px_w: u32,
    pub px_h: u32,
    pub dpi: f64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RustPrintOptions {
    pub page_width_inches: f64,
    pub page_height_inches: f64,
    pub margin_inches: f64,
    pub print_backgrounds: bool,
    pub scale: f64,
    pub landscape: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub kind: String,
    pub index: u32,
    pub script: String,
    pub poll_script: Option<String>,
    pub poll_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductCase {
    pub name: String,
    pub kind: String,
    pub description: String,
    pub mode: String,
    pub dpi: f64,
    pub inject: String,
    pub images: Vec<CaseImage>,
    pub paper: serde_json::Value,
    pub electron_options: serde_json::Value,
    pub rust_options: RustPrintOptions,
    pub window_size: WindowSize,
    pub steps: Vec<Step>,
    pub dom_probe_script: String,
    pub expected: serde_json::Value,
    pub inject_css_px: Option<serde_json::Value>,
    pub batch_layout: Option<serde_json::Value>,
}

fn load_manifest(path: &Path) -> Result<Manifest, String> {
    let data = std::fs::read(path)
        .map_err(|error| format!("读取 manifest 失败 {}: {error}", path.display()))?;
    serde_json::from_slice(&data).map_err(|error| {
        format!(
            "解析 manifest 失败 {}（先用 scripts/rust/pdf-product-cases.js 生成）: {error}",
            path.display()
        )
    })
}

// ---------------------------------------------------------------------------
// 只读 HTTP 服务：从仓库根目录原样提供真实 capture/print.html + shared/tokens.css
// ---------------------------------------------------------------------------

struct StaticServer {
    base_url: String,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl StaticServer {
    fn start(root: PathBuf, allowlist: Vec<String>) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("绑定本地 HTTP 端口失败: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("读取本地 HTTP 端口失败: {error}"))?
            .port();
        let requests: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let requests_for_thread = Arc::clone(&requests);
        let root_for_thread = root.clone();
        let allowlist_for_thread = allowlist.clone();
        let root_display = root.display().to_string();
        let base_url = format!("http://127.0.0.1:{port}");
        let base_url_for_log = base_url.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let root = root_for_thread.clone();
                        let allowlist = allowlist_for_thread.clone();
                        let requests = Arc::clone(&requests_for_thread);
                        std::thread::spawn(move || {
                            if let Err(error) = handle_http(stream, &root, &allowlist, &requests) {
                                println!("[http] 连接处理失败: {error}");
                            }
                        });
                    }
                    Err(error) => println!("[http] accept 失败: {error}"),
                }
            }
        });
        println!(
            "[r0-pdf-product] 只读 HTTP 服务已启动 {base_url_for_log}（root={root_display}, 白名单={allowlist:?}）"
        );
        Ok(Self { base_url, requests })
    }

    fn requests_handle(&self) -> Arc<Mutex<Vec<serde_json::Value>>> {
        Arc::clone(&self.requests)
    }
}

fn handle_http(
    mut stream: TcpStream,
    root: &Path,
    allowlist: &[String],
    requests: &Arc<Mutex<Vec<serde_json::Value>>>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut buffer = [0u8; 16384];
    let mut total = 0usize;
    loop {
        if total >= buffer.len() {
            break;
        }
        let read = stream.read(&mut buffer[total..])?;
        if read == 0 {
            break;
        }
        total += read;
        if buffer[..total]
            .windows(4)
            .any(|window| window == b"\r\n\r\n")
        {
            break;
        }
    }
    let request = String::from_utf8_lossy(&buffer[..total]);
    let first_line = request.lines().next().unwrap_or_default();
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let raw_target = parts.next().unwrap_or_default();
    let path_only = raw_target.split('?').next().unwrap_or_default();
    let relative = path_only.trim_start_matches('/');

    let (status, body, content_type) = if method != "GET" && method != "HEAD" {
        (
            405u16,
            b"method not allowed".to_vec(),
            "text/plain; charset=utf-8",
        )
    } else if !allowlist.iter().any(|allowed| allowed == relative) {
        (404u16, b"not found".to_vec(), "text/plain; charset=utf-8")
    } else {
        match std::fs::read(root.join(relative)) {
            Ok(data) => (200u16, data, content_type_for(relative)),
            Err(error) => {
                println!("[http] 读取失败 {}: {error}", root.join(relative).display());
                (500u16, b"read failed".to_vec(), "text/plain; charset=utf-8")
            }
        }
    };

    let mut response = Vec::new();
    response.extend_from_slice(format!("HTTP/1.1 {status} OK\r\n").as_bytes());
    response.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
    response.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
    response.extend_from_slice(b"Cache-Control: no-store\r\nConnection: close\r\n\r\n");
    if method != "HEAD" {
        response.extend_from_slice(&body);
    }
    stream.write_all(&response)?;
    let _ = stream.flush();
    println!("[http] {method} /{relative} -> {status} {} B", body.len());
    if let Ok(mut guard) = requests.lock() {
        guard.push(serde_json::json!({
            "method": method,
            "path": relative,
            "status": status,
            "bytes": body.len(),
            "atUnixMs": now_millis(),
        }));
    }
    Ok(())
}

fn content_type_for(relative: &str) -> &'static str {
    if relative.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if relative.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if relative.ends_with(".png") {
        "image/png"
    } else if relative.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

// ---------------------------------------------------------------------------
// ExecuteScript / 轮询
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ScriptOutcome {
    json: String,
    elapsed_ms: u128,
}

fn execute_script(window: &WebviewWindow, script: String) -> Result<ScriptOutcome, String> {
    let started = Instant::now();
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let tx_handler = tx.clone();
    let tx_call = tx.clone();
    window
        .with_webview(move |webview| {
            // SAFETY: with_webview 保证闭包在 WebView2 UI 线程执行。
            let core = match unsafe { webview.controller().CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    let _ = tx_call.send(Err(format!("获取 CoreWebView2 失败: {error}")));
                    return;
                }
            };
            let handler: ICoreWebView2ExecuteScriptCompletedHandler =
                ExecuteScriptCompletedHandler::create(Box::new(move |status, json: String| {
                    let payload = match status {
                        Ok(()) => Ok(json),
                        Err(error) => Err(format!(
                            "ExecuteScript 完成回调失败 HRESULT=0x{:08X} message={}",
                            error.code().0,
                            error.message()
                        )),
                    };
                    let _ = tx_handler.send(payload);
                    Ok(())
                }));
            let wide: Vec<u16> = script.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: wide 在调用期间保持存活；core/handler 为本线程合法 COM 对象。
            if let Err(error) = unsafe { core.ExecuteScript(PCWSTR(wide.as_ptr()), &handler) } {
                let _ = tx_call.send(Err(format!("ExecuteScript 调用失败: {error}")));
            }
        })
        .map_err(|error| format!("with_webview 调度失败: {error}"))?;
    let json = rx
        .recv_timeout(SCRIPT_TIMEOUT)
        .map_err(|error| format!("等待 ExecuteScript 完成超时/通道断开: {error}"))??;
    Ok(ScriptOutcome {
        json,
        elapsed_ms: elapsed_ms(&started),
    })
}

/// 轮询一个返回布尔值的观察脚本，直到它返回 true（或超时）。
fn poll_script(
    window: &WebviewWindow,
    script: &str,
    timeout: Duration,
) -> Result<(serde_json::Value, u128, u32, Option<String>), String> {
    let started = Instant::now();
    let mut attempts = 0u32;
    let mut last_error: Option<String> = None;
    loop {
        attempts += 1;
        match execute_script(window, script.to_string()) {
            Ok(outcome) => {
                let value: serde_json::Value =
                    serde_json::from_str(&outcome.json).unwrap_or(serde_json::Value::Null);
                if value.as_bool() == Some(true) {
                    return Ok((value, elapsed_ms(&started), attempts, None));
                }
            }
            Err(error) => last_error = Some(error),
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "轮询超时（{} ms，{} 次尝试）{}",
                timeout.as_millis(),
                attempts,
                last_error
                    .as_deref()
                    .map(|error| format!("，最近错误: {error}"))
                    .unwrap_or_default()
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn load_ready_script(case_name: &str) -> String {
    format!(
        "(() => {{
  const image = document.getElementById('print-image')
  const pages = document.getElementById('print-pages')
  return document.readyState === 'complete' &&
    location.href.indexOf('/capture/print.html?case={case_name}') >= 0 &&
    !!image && !!pages
}})()"
    )
}

fn case_url(base_url: &str, case_name: &str) -> String {
    format!("{base_url}/capture/print.html?case={case_name}")
}

fn set_window_size(window: &WebviewWindow, size: &WindowSize) -> Result<(), String> {
    window
        .set_size(Size::Logical(LogicalSize::new(
            f64::from(size.width),
            f64::from(size.height),
        )))
        .map_err(|error| format!("设置窗口尺寸失败: {error}"))
}

fn navigate(window: &WebviewWindow, url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|error| format!("解析 URL 失败 {url}: {error}"))?;
    window
        .navigate(parsed)
        .map_err(|error| format!("导航到 {url} 失败: {error}"))
}

// ---------------------------------------------------------------------------
// 用例执行
// ---------------------------------------------------------------------------

struct StepOutcome {
    kind: String,
    index: u32,
    execute_elapsed_ms: u128,
    execute_result: serde_json::Value,
    execute_result_raw: String,
    poll_elapsed_ms: Option<u128>,
    poll_attempts: Option<u32>,
    error: Option<String>,
}

impl StepOutcome {
    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "kind": self.kind,
            "index": self.index,
            "executeElapsedMs": self.execute_elapsed_ms,
            "executeResult": self.execute_result,
            "executeResultRaw": self.execute_result_raw,
            "pollElapsedMs": self.poll_elapsed_ms,
            "pollAttempts": self.poll_attempts,
            "error": self.error,
        })
    }
}

struct CaseOutcome {
    load_elapsed_ms: u128,
    load_attempts: u32,
    dom_before_steps: serde_json::Value,
    dom_after_steps: serde_json::Value,
    steps: Vec<StepOutcome>,
    settings_readback: serde_json::Value,
    interface_probe: serde_json::Value,
    print_elapsed_ms: u128,
    bytes: usize,
}

fn execute_case(
    window: &WebviewWindow,
    base_url: &str,
    case: &ProductCase,
    out_dir: &Path,
    first_case: bool,
) -> Result<CaseOutcome, String> {
    set_window_size(window, &case.window_size)?;
    if !first_case {
        navigate(window, &case_url(base_url, &case.name))?;
    }
    let (_, load_elapsed_ms, load_attempts, _) =
        poll_script(window, &load_ready_script(&case.name), PAGE_LOAD_TIMEOUT)?;

    let dom_before_steps =
        parse_script_json(execute_script(window, case.dom_probe_script.clone())?);
    let mut steps = Vec::with_capacity(case.steps.len());
    for step in &case.steps {
        let execute = execute_script(window, step.script.clone());
        let mut outcome = StepOutcome {
            kind: step.kind.clone(),
            index: step.index,
            execute_elapsed_ms: 0,
            execute_result: serde_json::Value::Null,
            execute_result_raw: String::new(),
            poll_elapsed_ms: None,
            poll_attempts: None,
            error: None,
        };
        match execute {
            Ok(executed) => {
                outcome.execute_elapsed_ms = executed.elapsed_ms;
                outcome.execute_result = serde_json::from_str(&executed.json)
                    .unwrap_or(serde_json::Value::String(executed.json.clone()));
                outcome.execute_result_raw = truncate(&executed.json, 4096);
            }
            Err(error) => {
                outcome.error = Some(error);
            }
        }
        if outcome.error.is_none() {
            if let Some(poll) = &step.poll_script {
                let timeout = step
                    .poll_timeout_ms
                    .map(Duration::from_millis)
                    .unwrap_or(STEP_POLL_TIMEOUT);
                match poll_script(window, poll, timeout) {
                    Ok((_, poll_elapsed, attempts, _)) => {
                        outcome.poll_elapsed_ms = Some(poll_elapsed);
                        outcome.poll_attempts = Some(attempts);
                    }
                    Err(error) => outcome.error = Some(error),
                }
            }
        }
        println!(
            "[step] {}#{} execute={}ms poll={:?} error={:?}",
            outcome.kind,
            outcome.index,
            outcome.execute_elapsed_ms,
            outcome.poll_elapsed_ms,
            outcome.error
        );
        let failed = outcome.error.is_some();
        steps.push(outcome);
        if failed {
            let last = steps.last().expect("just pushed");
            return Err(format!(
                "步骤 {}#{} 失败: {}",
                last.kind,
                last.index,
                last.error.clone().unwrap_or_default()
            ));
        }
    }
    let dom_after_steps = parse_script_json(execute_script(window, case.dom_probe_script.clone())?);

    let options = &case.rust_options;
    let spec = PrintSpec {
        page_width_inches: Some(options.page_width_inches),
        page_height_inches: Some(options.page_height_inches),
        margin_inches: Some(options.margin_inches),
        print_backgrounds: Some(options.print_backgrounds),
        scale: Some(options.scale),
        landscape: options.landscape,
    };
    let print_started = Instant::now();
    let payload = pdf::print_with_stream(window, spec)?;
    let print_elapsed_ms = elapsed_ms(&print_started);
    let file_name = format!("webview2-{}.pdf", case.name);
    let file_path = out_dir.join(&file_name);
    std::fs::write(&file_path, &payload.bytes)
        .map_err(|error| format!("写入 PDF 失败 {}: {error}", file_path.display()))?;
    println!(
        "[print] {}: {} B, {} ms -> {}",
        case.name,
        payload.bytes.len(),
        print_elapsed_ms,
        file_path.display()
    );
    Ok(CaseOutcome {
        load_elapsed_ms,
        load_attempts,
        dom_before_steps,
        dom_after_steps,
        steps,
        settings_readback: payload.settings_readback,
        interface_probe: payload.interface_probe,
        print_elapsed_ms,
        bytes: payload.bytes.len(),
    })
}

fn parse_script_json(outcome: ScriptOutcome) -> serde_json::Value {
    serde_json::from_str(&outcome.json).unwrap_or(serde_json::Value::String(outcome.json))
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        let truncated: String = value.chars().take(max_chars).collect();
        format!("{truncated}…（截断）")
    }
}

// ---------------------------------------------------------------------------
// 后台 worker / 入口
// ---------------------------------------------------------------------------

fn worker(
    app: &AppHandle,
    manifest: &Manifest,
    out_dir: &Path,
    base_url: &str,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
) -> i32 {
    let started_at = now_millis();
    let mut report = serde_json::json!({
        "backend": "webview2",
        "mode": "pdf-product",
        "webview2Version": tauri::webview_version().unwrap_or_else(|error| format!("unavailable: {error}")),
        "manifestGeneratedAt": manifest.generated_at,
        "manifestSchema": manifest.schema,
        "printPage": manifest.source_hashes.get("printPage"),
        "tokensCss": manifest.source_hashes.get("tokensCss"),
        "preloadCapture": manifest.paths.preload_capture,
        "fixtures": manifest.fixtures,
        "constants": manifest.constants,
        "outDir": out_dir.display().to_string(),
        "windowLabel": PRODUCT_WINDOW_LABEL,
        // 页面请求在用例跑完后回填（见下方），确保真实页/tokens.css/favicon 请求都有记录。
        "httpRequests": [],
        "startedAtUnixMs": started_at,
        "cases": [],
        "failures": [],
    });

    if let Err(error) = ensure_dir(out_dir) {
        println!("[FAIL] {error}");
        return 3;
    }

    let window = match app.get_webview_window(PRODUCT_WINDOW_LABEL) {
        Some(window) => window,
        None => {
            println!("[FAIL] 产品打印窗口不存在: {PRODUCT_WINDOW_LABEL}");
            return 3;
        }
    };

    let mut failures: Vec<serde_json::Value> = Vec::new();
    for (index, case) in manifest.cases.iter().enumerate() {
        let case_started = Instant::now();
        let mut outcome = serde_json::json!({
            "name": case.name,
            "kind": case.kind,
            "description": case.description,
            "mode": case.mode,
            "dpi": case.dpi,
            "inject": case.inject,
            "images": case.images,
            "paper": case.paper,
            "electronOptions": case.electron_options,
            "rustOptions": case.rust_options,
            "windowSize": case.window_size,
            "injectCssPx": case.inject_css_px,
            "batchLayout": case.batch_layout,
            "expected": case.expected,
            "stepCount": case.steps.len(),
            "loadElapsedMs": null,
            "loadAttempts": null,
            "domBeforeSteps": null,
            "domAfterSteps": null,
            "steps": [],
            "settingsReadback": null,
            "interfaceProbe": null,
            "printElapsedMs": null,
            "bytes": 0,
            "file": null,
            "elapsedMs": null,
            "error": null,
        });
        println!("[case] {}（{}）", case.name, case.kind);
        match execute_case(&window, base_url, case, out_dir, index == 0) {
            Ok(result) => {
                outcome["loadElapsedMs"] = serde_json::json!(result.load_elapsed_ms);
                outcome["loadAttempts"] = serde_json::json!(result.load_attempts);
                outcome["domBeforeSteps"] = result.dom_before_steps;
                outcome["domAfterSteps"] = result.dom_after_steps;
                outcome["steps"] = serde_json::Value::Array(
                    result.steps.iter().map(StepOutcome::to_json).collect(),
                );
                outcome["settingsReadback"] = result.settings_readback;
                outcome["interfaceProbe"] = result.interface_probe;
                outcome["printElapsedMs"] = serde_json::json!(result.print_elapsed_ms);
                outcome["bytes"] = serde_json::json!(result.bytes);
                outcome["file"] = serde_json::json!(out_dir
                    .join(format!("webview2-{}.pdf", case.name))
                    .display()
                    .to_string());
            }
            Err(error) => {
                println!("[FAIL] {}: {error}", case.name);
                outcome["error"] = serde_json::json!(error);
                failures.push(serde_json::json!({
                    "stage": "case",
                    "case": case.name,
                    "error": outcome["error"].clone(),
                }));
            }
        }
        outcome["elapsedMs"] = serde_json::json!(elapsed_ms(&case_started));
        if let Some(array) = report["cases"].as_array_mut() {
            array.push(outcome);
        }
    }
    report["failures"] = serde_json::Value::Array(failures);
    report["httpRequests"] = serde_json::Value::Array(
        requests
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default(),
    );
    report["finishedAtUnixMs"] = serde_json::json!(now_millis());
    let failure_count = report["failures"]
        .as_array()
        .map(|array| array.len())
        .unwrap_or(0);
    report["summary"] = serde_json::json!({
        "caseCount": manifest.cases.len(),
        "failureCount": failure_count,
    });
    let report_path = out_dir.join("webview2-product-report.json");
    match write_json(&report_path, &report) {
        Ok(()) => println!("[report] {}", report_path.display()),
        Err(error) => println!("[FAIL] 写报告失败: {error}"),
    }
    if failure_count == 0 {
        println!(
            "[PASS] webview2 product pdf: {} cases",
            manifest.cases.len()
        );
        0
    } else {
        println!(
            "[FAIL] webview2 product pdf: {} / {} cases",
            manifest.cases.len() - failure_count,
            manifest.cases.len()
        );
        3
    }
}

/// 启动产品页模式：内置 HTTP 服务 + 一个隐藏窗口 + 后台打印 worker。
pub fn run(options: crate::cli::Options) -> i32 {
    let manifest_path = options.cases_file.clone().unwrap_or_else(|| {
        crate::shared::pdf_dir()
            .join("product")
            .join("product-cases.json")
    });
    let manifest = match load_manifest(&manifest_path) {
        Ok(manifest) => manifest,
        Err(error) => {
            eprintln!("[r0-pdf-product] {error}");
            return 2;
        }
    };
    let first_case = match manifest.cases.first() {
        Some(case) => case.clone(),
        None => {
            eprintln!(
                "[r0-pdf-product] manifest 没有用例: {}",
                manifest_path.display()
            );
            return 2;
        }
    };
    let out_dir = options
        .out_dir
        .clone()
        .unwrap_or_else(|| crate::shared::pdf_dir().join("product"));
    if let Err(error) = ensure_dir(&out_dir) {
        eprintln!("[FAIL] {error}");
        return 3;
    }
    let root = PathBuf::from(&manifest.root);
    // 只暴露真实页需要的两个文件（相对仓库根的路径）。
    let allowlist = vec![
        relative_to(&root, Path::new(&manifest.paths.print_page)),
        relative_to(&root, Path::new(&manifest.paths.tokens_css)),
    ];
    let server = match StaticServer::start(root, allowlist) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("[FAIL] {error}");
            return 3;
        }
    };
    let base_url = server.base_url.clone();
    let initial_url = case_url(&base_url, &first_case.name);

    let manifest_state = Arc::new(manifest);
    let manifest_for_setup = Arc::clone(&manifest_state);
    let out_dir_for_setup = out_dir.clone();
    let base_url_for_setup = base_url.clone();
    let hold_ms = options.hold_ms;
    let initial_window_size = (first_case.window_size.width, first_case.window_size.height);

    // 产品真实页没有 <script>，也不调用 Tauri 命令（页面经本地 HTTP 加载，无 IPC），
    // 因此本模式不注册 invoke_handler，避免给打印窗口任何应用命令面。
    let app = tauri::Builder::default()
        .setup(move |app| {
            let url = match tauri::Url::parse(&initial_url) {
                Ok(url) => url,
                Err(error) => {
                    println!("[FAIL] 解析初始 URL 失败: {error}");
                    app.handle().exit(3);
                    return Ok(());
                }
            };
            let mut builder = WebviewWindowBuilder::new(
                app.handle(),
                PRODUCT_WINDOW_LABEL,
                WebviewUrl::External(url),
            )
            .title("Highlighter R0-06 product print window")
            .inner_size(
                f64::from(initial_window_size.0),
                f64::from(initial_window_size.1),
            )
            .visible(false)
            .decorations(false)
            .skip_taskbar(true)
            .focused(false)
            .shadow(false);
            #[cfg(windows)]
            {
                let data_directory = out_dir_for_setup
                    .join("webview2-data")
                    .join("product-print");
                if let Err(error) = crate::shared::ensure_dir(&data_directory) {
                    println!("[r0-pdf-product] 创建 WebView2 数据目录失败: {error}");
                }
                builder = builder.data_directory(data_directory);
            }
            match builder.build() {
                Ok(_) => println!("[r0-pdf-product] 隐藏窗口已创建: {PRODUCT_WINDOW_LABEL}"),
                Err(error) => {
                    println!("[FAIL] 创建产品打印窗口失败: {error}");
                    app.handle().exit(3);
                    return Ok(());
                }
            }
            let app_handle = app.handle().clone();
            let manifest_for_worker = Arc::clone(&manifest_for_setup);
            let requests = server.requests_handle();
            spawn_worker(
                app_handle,
                manifest_for_worker,
                out_dir_for_setup.clone(),
                base_url_for_setup.clone(),
                requests,
                hold_ms,
            );
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("[r0-pdf-product] 构建 Tauri 应用失败: {error}");
            return 3;
        }
    };
    let exit_code = app.run_return(|_app, _event| {});
    println!("[r0-pdf-product] event loop exited code={exit_code}");
    exit_code
}

fn spawn_worker(
    app: AppHandle,
    manifest: Arc<Manifest>,
    out_dir: PathBuf,
    base_url: String,
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    hold_ms: u64,
) {
    std::thread::spawn(move || {
        let code = worker(&app, &manifest, &out_dir, &base_url, requests);
        if hold_ms > 0 {
            std::thread::sleep(Duration::from_millis(hold_ms));
        }
        app.exit(code);
    });
}

/// 绝对路径 → 相对仓库根的 `/` 分隔路径（HTTP 白名单用）。
fn relative_to(root: &Path, path: &Path) -> String {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let canonical_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical_path
        .strip_prefix(&canonical_root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_ready_script_contains_case_query() {
        let script = load_ready_script("p1-a4-portrait-intrinsic");
        assert!(script.contains("/capture/print.html?case=p1-a4-portrait-intrinsic"));
        assert!(script.contains("print-image"));
    }

    #[test]
    fn case_url_uses_base_url() {
        assert_eq!(
            case_url("http://127.0.0.1:1234", "p1"),
            "http://127.0.0.1:1234/capture/print.html?case=p1"
        );
    }

    #[test]
    fn content_types() {
        assert!(content_type_for("capture/print.html").starts_with("text/html"));
        assert!(content_type_for("shared/tokens.css").starts_with("text/css"));
        assert_eq!(content_type_for("x.bin"), "application/octet-stream");
    }

    #[test]
    fn truncate_keeps_short_values() {
        assert_eq!(truncate("{}", 10), "{}");
        assert!(truncate(&"x".repeat(20), 5).contains("截断"));
    }

    #[test]
    fn relative_to_strips_root() {
        let root = Path::new("D:/workspace/Highlighter");
        let relative = relative_to(
            root,
            Path::new("D:/workspace/Highlighter/capture/print.html"),
        );
        assert!(relative.ends_with("capture/print.html"));
        assert!(!relative.starts_with("D:"));
    }
}
