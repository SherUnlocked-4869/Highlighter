//! A. WebView2 PDF 打印链路（PrintToPdfStream / 旧 API PrintToPdf）。
//!
//! 设计要点（与 docs/plans/rust-migration/r0-pdf-spike.md 对应）：
//! - 隐藏窗口加载合成打印样例（`prototype-ui/print-sample*.html`），页面在
//!   `load` + 字体/图片解码完成后通过 `pdf_page_ready` 命令通知宿主；
//! - 宿主在后台线程里调用 `WebviewWindow::with_webview`，在主线程拿到
//!   `ICoreWebView2Controller` / `ICoreWebView2Environment6`，`CreatePrintSettings()`
//!   后设置纸张（英寸）/边距/背景/缩放；
//! - `ICoreWebView2_16::PrintToPdfStream(settings, handler)` 的完成回调交付 `IStream`，
//!   回调里把流读成 `Vec<u8>` 再经 mpsc 交回后台线程写盘（回调运行在 WebView2 线程，
//!   不阻塞 Tauri 事件循环以外的线程）；
//! - 旧 API `ICoreWebView2_7::PrintToPdf(path, settings, handler)` 也实测一次，用于
//!   记录 bindings 里的真实方法名（不是 `PrintToPdfAsync`）。
//!
//! 所有 COM 调用都集中在本文件，`unsafe` 块只在确实调用 COM 方法处出现。

use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2PrintToPdfCompletedHandler,
    ICoreWebView2PrintToPdfStreamCompletedHandler, ICoreWebView2_16, ICoreWebView2_7,
    COREWEBVIEW2_PRINT_ORIENTATION, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
};
use webview2_com::{PrintToPdfCompletedHandler, PrintToPdfStreamCompletedHandler};
use windows::core::{Interface, BOOL, PCWSTR};
use windows::Win32::System::Com::IStream;

use crate::monitors::MonitorSnapshot;
use crate::shared::{elapsed_ms, ensure_dir, now_millis, write_json};

/// 三个隐藏打印窗口的 label（capability 里登记同名窗口）。
pub const PRIMARY_LABEL: &str = "pdf-primary";
pub const CSPAGE_LABEL: &str = "pdf-csspage";
pub const PLAIN_LABEL: &str = "pdf-plain";

/// A4 英寸值（1in = 25.4mm）。
pub const A4_WIDTH_INCHES: f64 = 210.0 / 25.4;
pub const A4_HEIGHT_INCHES: f64 = 297.0 / 25.4;
/// 合成样例里 6.25in × 4.166667in 自定义纸张（基线实测单位证据）。
pub const CUSTOM_PAPER_WIDTH_INCHES: f64 = 6.25;
pub const CUSTOM_PAPER_HEIGHT_INCHES: f64 = 4.166_667;
/// 15mm 边距（英寸）。
pub const MARGIN_15MM_INCHES: f64 = 15.0 / 25.4;
/// 单次打印等待完成回调的超时。
const PRINT_TIMEOUT: Duration = Duration::from_secs(60);
/// 等待页面 ready 的超时。
pub const PAGE_READY_TIMEOUT: Duration = Duration::from_secs(45);

/// 打印设置（None = 沿用 WebView2 默认值，用于读默认纸张）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintSpec {
    pub page_width_inches: Option<f64>,
    pub page_height_inches: Option<f64>,
    /// 四边统一边距（英寸）；原型只需统一值。
    pub margin_inches: Option<f64>,
    pub print_backgrounds: Option<bool>,
    pub scale: Option<f64>,
    pub landscape: bool,
}

/// 一个打印用例。
#[derive(Debug, Clone)]
pub struct PdfCase {
    pub name: &'static str,
    pub window_label: &'static str,
    pub document: &'static str,
    pub spec: PrintSpec,
    /// true = 走旧 API `PrintToPdf(path, ...)`；false = `PrintToPdfStream`。
    pub legacy_print_to_pdf: bool,
    pub note: &'static str,
}

/// 打印结果（写进 webview2-print-report.json）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintOutcome {
    pub name: String,
    pub window: String,
    pub document: String,
    pub api: String,
    pub note: String,
    pub spec: PrintSpec,
    pub file: Option<String>,
    pub bytes: usize,
    pub elapsed_ms: u128,
    pub settings_readback: Option<serde_json::Value>,
    pub interface_probe: Option<serde_json::Value>,
    pub error: Option<String>,
}

/// 打印矩阵（与 Electron 侧 probe-electron-pdf.js 的 e* 用例一一对应）。
pub fn cases() -> Vec<PdfCase> {
    let a4 = |margin_inches: f64, backgrounds: bool, scale: f64| PrintSpec {
        page_width_inches: Some(A4_WIDTH_INCHES),
        page_height_inches: Some(A4_HEIGHT_INCHES),
        margin_inches: Some(margin_inches),
        print_backgrounds: Some(backgrounds),
        scale: Some(scale),
        landscape: false,
    };
    vec![
        PdfCase {
            name: "w0-default-settings",
            window_label: PRIMARY_LABEL,
            document: "print-sample-v1",
            spec: PrintSpec::default(),
            legacy_print_to_pdf: false,
            note: "不设置任何 PrintSettings，读取 WebView2 默认纸张（对照 Electron e0 默认参数）",
        },
        PdfCase {
            name: "w1-a4-margin0-bg",
            window_label: PRIMARY_LABEL,
            document: "print-sample-v1",
            spec: a4(0.0, true, 1.0),
            legacy_print_to_pdf: false,
            note: "A4、零边距、打印背景（产品 pdf-export.js A4 档等价设置）",
        },
        PdfCase {
            name: "w1b-a4-electron-inches",
            window_label: PRIMARY_LABEL,
            document: "print-sample-v1",
            spec: PrintSpec {
                // Electron 侧实测 A4 MediaBox = 595.92 x 842.88 pt，反推英寸值。
                // 若该用例输出同一 MediaBox，说明 WebView2 的 PageWidth/PageHeight 单位就是英寸。
                page_width_inches: Some(595.92 / 72.0),
                page_height_inches: Some(842.88 / 72.0),
                margin_inches: Some(0.0),
                print_backgrounds: Some(true),
                scale: Some(1.0),
                landscape: false,
            },
            legacy_print_to_pdf: false,
            note: "用 Electron 实测 A4 尺寸（595.92x842.88pt 反推英寸）验证 WebView2 纸张单位",
        },
        PdfCase {
            name: "w4-a4-margin0-nobg",
            window_label: PRIMARY_LABEL,
            document: "print-sample-v1",
            spec: a4(0.0, false, 1.0),
            legacy_print_to_pdf: false,
            note: "同上但 ShouldPrintBackgrounds=false（透明/半透明元素对照 Electron e4）",
        },
        PdfCase {
            name: "w3-custom-paper-6.25x4.166667in",
            window_label: PRIMARY_LABEL,
            document: "print-sample-v1",
            spec: PrintSpec {
                page_width_inches: Some(CUSTOM_PAPER_WIDTH_INCHES),
                page_height_inches: Some(CUSTOM_PAPER_HEIGHT_INCHES),
                margin_inches: Some(0.0),
                print_backgrounds: Some(true),
                scale: Some(1.0),
                landscape: false,
            },
            legacy_print_to_pdf: false,
            note: "自定义纸张（英寸）：宽度 6.25 大于高度，观察是否被引擎旋转/交换",
        },
        PdfCase {
            name: "w3b-custom-paper-landscape",
            window_label: PRIMARY_LABEL,
            document: "print-sample-v1",
            spec: PrintSpec {
                page_width_inches: Some(CUSTOM_PAPER_WIDTH_INCHES),
                page_height_inches: Some(CUSTOM_PAPER_HEIGHT_INCHES),
                margin_inches: Some(0.0),
                print_backgrounds: Some(true),
                scale: Some(1.0),
                landscape: true,
            },
            legacy_print_to_pdf: false,
            note: "自定义纸张 + Orientation=Landscape（对照 Electron e3a）",
        },
        PdfCase {
            name: "w5-a4-settings-margins-15mm",
            window_label: PRIMARY_LABEL,
            document: "print-sample-v1",
            spec: a4(MARGIN_15MM_INCHES, true, 1.0),
            legacy_print_to_pdf: false,
            note: "A4 + PrintSettings 四边 15mm 边距（对照 Electron e5）",
        },
        PdfCase {
            name: "w9-plain-a4-settings-margins-15mm",
            window_label: PLAIN_LABEL,
            document: "print-plain-v1",
            spec: a4(MARGIN_15MM_INCHES, true, 1.0),
            legacy_print_to_pdf: false,
            note: "无 @page 规则 + A4 + PrintSettings 15mm 边距（验证引擎边距参数本身是否生效）",
        },
        PdfCase {
            name: "w6-a4-old-api-printtopdf",
            window_label: PRIMARY_LABEL,
            document: "print-sample-v1",
            spec: a4(0.0, true, 1.0),
            legacy_print_to_pdf: true,
            note: "旧 API ICoreWebView2_7::PrintToPdf 写文件（bindings 里方法名是 PrintToPdf，没有 PrintToPdfAsync）",
        },
        PdfCase {
            name: "w2-csspage-a4-margin0",
            window_label: CSPAGE_LABEL,
            document: "print-sample-csspage-v1",
            spec: a4(0.0, true, 1.0),
            legacy_print_to_pdf: false,
            note: "HTML 自带 @page A4/15mm；引擎设置 A4/零边距（观察 CSS 边距是否生效）",
        },
        PdfCase {
            name: "w7-plain-a4-margin0",
            window_label: PLAIN_LABEL,
            document: "print-plain-v1",
            spec: a4(0.0, true, 1.0),
            legacy_print_to_pdf: false,
            note: "无 @page 规则的对照 HTML + A4/零边距（隔离 CSS 纸张规则）",
        },
        PdfCase {
            name: "w8-plain-custom-paper",
            window_label: PLAIN_LABEL,
            document: "print-plain-v1",
            spec: PrintSpec {
                page_width_inches: Some(CUSTOM_PAPER_WIDTH_INCHES),
                page_height_inches: Some(CUSTOM_PAPER_HEIGHT_INCHES),
                margin_inches: Some(0.0),
                print_backgrounds: Some(true),
                scale: Some(1.0),
                landscape: false,
            },
            legacy_print_to_pdf: false,
            note: "无 @page 规则的对照 HTML + 自定义纸张（验证分页是否随纸张变化）",
        },
    ]
}

/// 页面 ready 状态（pdf_page_ready 命令 + 后台线程等待）。
#[derive(Default)]
pub struct PdfState {
    ready: Mutex<Vec<serde_json::Value>>,
    condvar: Condvar,
}

impl PdfState {
    /// 命令侧登记一次 ready（重复 ready 追加记录，不重发任何东西）。
    pub fn mark_ready(&self, record: serde_json::Value) {
        if let Ok(mut guard) = self.ready.lock() {
            guard.push(record);
        }
        self.condvar.notify_all();
    }

    /// 等待指定 document 的 ready 记录。
    pub fn wait_for_document(
        &self,
        document: &str,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let deadline = Instant::now() + timeout;
        let mut guard = self
            .ready
            .lock()
            .map_err(|_| "PdfState 互斥锁已中毒".to_string())?;
        loop {
            if let Some(record) = guard.iter().find(|record| {
                record.get("document").and_then(|value| value.as_str()) == Some(document)
            }) {
                return Ok(record.clone());
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!(
                    "等待页面 ready 超时（document={document}，{}s）",
                    timeout.as_secs()
                ));
            }
            let wait_for = deadline.saturating_duration_since(now);
            let (next_guard, _) = self
                .condvar
                .wait_timeout(guard, wait_for)
                .map_err(|_| "PdfState 条件变量已中毒".to_string())?;
            guard = next_guard;
        }
    }

    /// 全部 ready 记录（写进报告）。
    #[allow(dead_code)]
    pub fn snapshot(&self) -> Vec<serde_json::Value> {
        self.ready
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

/// 打印完成后交回后台线程的数据。
struct PrintPayload {
    bytes: Vec<u8>,
    settings_readback: serde_json::Value,
    interface_probe: serde_json::Value,
}

/// 从完成回调交付的 IStream 读取全部字节。
///
/// `IStream::Read` 返回 HRESULT（不是 Result）；读到 0 字节或 S_FALSE 视为结束。
fn read_stream_result(
    status: windows::core::Result<()>,
    stream: Option<IStream>,
) -> Result<Vec<u8>, String> {
    status.map_err(|error| {
        format!(
            "PrintToPdfStream 完成回调失败 HRESULT=0x{:08X} message={}",
            error.code().0,
            error.message()
        )
    })?;
    let stream = stream.ok_or_else(|| "PrintToPdfStream 完成回调未返回 IStream".to_string())?;
    let mut bytes: Vec<u8> = Vec::with_capacity(256 * 1024);
    let mut chunk = vec![0u8; 128 * 1024];
    loop {
        let mut read: u32 = 0;
        // SAFETY: chunk 是本地有效缓冲区，read 指向本地栈变量；stream 是完成回调交付的有效 COM 接口。
        let status = unsafe {
            stream.Read(
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                Some(&mut read as *mut u32),
            )
        };
        if status.is_err() {
            return Err(format!("IStream::Read 失败 HRESULT=0x{:08X}", status.0));
        }
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read as usize]);
        if bytes.len() > 512 * 1024 * 1024 {
            return Err("PDF 流超过 512 MiB，已中止".into());
        }
    }
    if bytes.is_empty() {
        return Err("PrintToPdfStream 返回空流".into());
    }
    Ok(bytes)
}

/// 应用打印设置并读回实际值（读回值作为证据，防止“设置了但没生效”）。
///
/// # Safety
/// 调用者必须保证这些 COM 调用发生在 WebView2 UI 线程（`with_webview` 闭包内）。
unsafe fn apply_print_settings(
    settings: &ICoreWebView2PrintSettings,
    spec: &PrintSpec,
) -> Result<serde_json::Value, String> {
    if let Some(width) = spec.page_width_inches {
        settings
            .SetPageWidth(width)
            .map_err(|error| format!("SetPageWidth({width}) 失败: {error}"))?;
    }
    if let Some(height) = spec.page_height_inches {
        settings
            .SetPageHeight(height)
            .map_err(|error| format!("SetPageHeight({height}) 失败: {error}"))?;
    }
    if let Some(margin) = spec.margin_inches {
        settings
            .SetMarginTop(margin)
            .map_err(|error| format!("SetMarginTop({margin}) 失败: {error}"))?;
        settings
            .SetMarginBottom(margin)
            .map_err(|error| format!("SetMarginBottom({margin}) 失败: {error}"))?;
        settings
            .SetMarginLeft(margin)
            .map_err(|error| format!("SetMarginLeft({margin}) 失败: {error}"))?;
        settings
            .SetMarginRight(margin)
            .map_err(|error| format!("SetMarginRight({margin}) 失败: {error}"))?;
    }
    if let Some(backgrounds) = spec.print_backgrounds {
        settings
            .SetShouldPrintBackgrounds(backgrounds)
            .map_err(|error| format!("SetShouldPrintBackgrounds({backgrounds}) 失败: {error}"))?;
    }
    if let Some(scale) = spec.scale {
        settings
            .SetScaleFactor(scale)
            .map_err(|error| format!("SetScaleFactor({scale}) 失败: {error}"))?;
    }
    settings
        .SetOrientation(if spec.landscape {
            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
        } else {
            COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
        })
        .map_err(|error| format!("SetOrientation 失败: {error}"))?;

    // 读回实际值（不信任 setter 静默裁剪）。
    let mut width = 0.0f64;
    let mut height = 0.0f64;
    let mut margin_top = 0.0f64;
    let mut margin_bottom = 0.0f64;
    let mut margin_left = 0.0f64;
    let mut margin_right = 0.0f64;
    let mut scale = 0.0f64;
    let mut backgrounds = BOOL::default();
    let mut orientation = COREWEBVIEW2_PRINT_ORIENTATION::default();
    settings
        .PageWidth(&mut width)
        .map_err(|error| format!("读取 PageWidth 失败: {error}"))?;
    settings
        .PageHeight(&mut height)
        .map_err(|error| format!("读取 PageHeight 失败: {error}"))?;
    settings
        .MarginTop(&mut margin_top)
        .map_err(|error| format!("读取 MarginTop 失败: {error}"))?;
    settings
        .MarginBottom(&mut margin_bottom)
        .map_err(|error| format!("读取 MarginBottom 失败: {error}"))?;
    settings
        .MarginLeft(&mut margin_left)
        .map_err(|error| format!("读取 MarginLeft 失败: {error}"))?;
    settings
        .MarginRight(&mut margin_right)
        .map_err(|error| format!("读取 MarginRight 失败: {error}"))?;
    settings
        .ScaleFactor(&mut scale)
        .map_err(|error| format!("读取 ScaleFactor 失败: {error}"))?;
    settings
        .ShouldPrintBackgrounds(&mut backgrounds)
        .map_err(|error| format!("读取 ShouldPrintBackgrounds 失败: {error}"))?;
    settings
        .Orientation(&mut orientation)
        .map_err(|error| format!("读取 Orientation 失败: {error}"))?;
    Ok(serde_json::json!({
        "pageWidthInches": width,
        "pageHeightInches": height,
        "marginTopInches": margin_top,
        "marginBottomInches": margin_bottom,
        "marginLeftInches": margin_left,
        "marginRightInches": margin_right,
        "scaleFactor": scale,
        "shouldPrintBackgrounds": backgrounds.as_bool(),
        "orientationLandscape": orientation == COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
    }))
}

/// 在 main 线程准备打印设置，并返回 (settings, readback, interface probe)。
///
/// # Safety
/// 必须在 WebView2 UI 线程调用（`with_webview` 闭包内）。
unsafe fn prepare_print_settings(
    webview: &tauri::webview::PlatformWebview,
    spec: &PrintSpec,
) -> Result<
    (
        ICoreWebView2PrintSettings,
        serde_json::Value,
        serde_json::Value,
    ),
    String,
> {
    let controller = webview.controller();
    let core = controller
        .CoreWebView2()
        .map_err(|error| format!("获取 CoreWebView2 失败: {error}"))?;
    let core7 = core.cast::<ICoreWebView2_7>();
    let core16 = core.cast::<ICoreWebView2_16>();
    let environment = webview.environment();
    let environment6 = environment
        .cast::<ICoreWebView2Environment6>()
        .map_err(|error| format!("ICoreWebView2Environment6 cast 失败: {error}"))?;
    let settings = environment6
        .CreatePrintSettings()
        .map_err(|error| format!("CreatePrintSettings 失败: {error}"))?;
    let readback = apply_print_settings(&settings, spec)?;
    let probe = serde_json::json!({
        "coreWebView2_7_printToPdf": core7.is_ok(),
        "coreWebView2_16_printToPdfStream": core16.is_ok(),
        "coreWebView2_16_print": core16.as_ref().map(|_| true).unwrap_or(false),
        "environment6_createPrintSettings": true,
        "controllerCast": true,
    });
    Ok((settings, readback, probe))
}

/// 主线程执行 `PrintToPdfStream`；结果经 `tx` 交回后台线程。
///
/// # Safety
/// 该函数只应作为 `with_webview` 闭包体在 WebView2 UI 线程执行。
unsafe fn start_stream_print(
    webview: &tauri::webview::PlatformWebview,
    spec: PrintSpec,
    tx: mpsc::Sender<Result<PrintPayload, String>>,
) {
    let (settings, readback, probe) = match prepare_print_settings(webview, &spec) {
        Ok(prepared) => prepared,
        Err(message) => {
            let _ = tx.send(Err(message));
            return;
        }
    };
    let core = match webview
        .controller()
        .CoreWebView2()
        .map(|core| core.cast::<ICoreWebView2_16>())
    {
        Ok(Ok(core16)) => core16,
        Ok(Err(error)) => {
            let _ = tx.send(Err(format!("ICoreWebView2_16 cast 失败: {error}")));
            return;
        }
        Err(error) => {
            let _ = tx.send(Err(format!("获取 CoreWebView2 失败: {error}")));
            return;
        }
    };

    let tx_handler = tx.clone();
    let handler: ICoreWebView2PrintToPdfStreamCompletedHandler =
        PrintToPdfStreamCompletedHandler::create(Box::new(
            move |status: windows::core::Result<()>, stream: Option<IStream>| {
                let payload = read_stream_result(status, stream).map(|bytes| PrintPayload {
                    bytes,
                    settings_readback: readback.clone(),
                    interface_probe: probe.clone(),
                });
                let _ = tx_handler.send(payload);
                Ok(())
            },
        ));
    // SAFETY: settings/handler 均为本线程创建的合法 COM 对象，调用窗口已加载完成。
    if let Err(error) = core.PrintToPdfStream(&settings, &handler) {
        let _ = tx.send(Err(format!("PrintToPdfStream 调用失败: {error}")));
    }
}

/// 主线程执行旧 API `PrintToPdf(path, ...)`；完成回调只报告成功/失败，文件由后台线程读取。
///
/// # Safety
/// 该函数只应作为 `with_webview` 闭包体在 WebView2 UI 线程执行。
unsafe fn start_legacy_print_to_pdf(
    webview: &tauri::webview::PlatformWebview,
    spec: PrintSpec,
    output_path: std::path::PathBuf,
    tx: mpsc::Sender<Result<PrintPayload, String>>,
) {
    let (settings, _readback, _probe) = match prepare_print_settings(webview, &spec) {
        Ok(prepared) => prepared,
        Err(message) => {
            let _ = tx.send(Err(message));
            return;
        }
    };
    let core7 = match webview
        .controller()
        .CoreWebView2()
        .map(|core| core.cast::<ICoreWebView2_7>())
    {
        Ok(Ok(core7)) => core7,
        Ok(Err(error)) => {
            let _ = tx.send(Err(format!("ICoreWebView2_7 cast 失败: {error}")));
            return;
        }
        Err(error) => {
            let _ = tx.send(Err(format!("获取 CoreWebView2 失败: {error}")));
            return;
        }
    };
    let wide_path: Vec<u16> = {
        use std::os::windows::ffi::OsStrExt;
        output_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let tx_handler = tx.clone();
    let handler: ICoreWebView2PrintToPdfCompletedHandler = PrintToPdfCompletedHandler::create(
        Box::new(move |status: windows::core::Result<()>, succeeded: bool| {
            let result = if let Err(error) = status {
                Err(format!(
                    "PrintToPdf 完成回调失败 HRESULT=0x{:08X} message={}",
                    error.code().0,
                    error.message()
                ))
            } else if succeeded {
                Ok(PrintPayload {
                    bytes: Vec::new(),
                    settings_readback: serde_json::json!({"api": "ICoreWebView2_7::PrintToPdf"}),
                    interface_probe: serde_json::json!({"legacyPrintToPdfCompleted": true}),
                })
            } else {
                Err("PrintToPdf 完成回调返回 succeeded=false".to_string())
            };
            let _ = tx_handler.send(result);
            Ok(())
        }),
    );
    // SAFETY: wide_path 在调用期间保持存活；settings/handler 为本线程合法 COM 对象。
    if let Err(error) = core7.PrintToPdf(PCWSTR(wide_path.as_ptr()), &settings, &handler) {
        let _ = tx.send(Err(format!("PrintToPdf 调用失败: {error}")));
    }
}

/// 打印一个用例：后台线程等待主线程的 COM 完成回调。
fn print_case(
    window: &WebviewWindow,
    case: &PdfCase,
    output_path: &Path,
) -> Result<PrintOutcome, String> {
    let started = Instant::now();
    let (tx, rx) = mpsc::channel::<Result<PrintPayload, String>>();
    let spec = case.spec.clone();
    let legacy = case.legacy_print_to_pdf;
    let output_for_legacy = output_path.to_path_buf();
    window
        .with_webview(move |webview| {
            // SAFETY: with_webview 保证闭包在 WebView2 UI 线程执行。
            unsafe {
                if legacy {
                    start_legacy_print_to_pdf(&webview, spec, output_for_legacy, tx);
                } else {
                    start_stream_print(&webview, spec, tx);
                }
            }
        })
        .map_err(|error| format!("with_webview 调度失败: {error}"))?;

    let payload = rx
        .recv_timeout(PRINT_TIMEOUT)
        .map_err(|error| format!("等待打印完成超时/通道断开: {error}"))??;
    let elapsed = elapsed_ms(&started);

    let bytes = if case.legacy_print_to_pdf {
        let data = std::fs::read(output_path).map_err(|error| {
            format!(
                "读取 PrintToPdf 输出文件失败 {}: {error}",
                output_path.display()
            )
        })?;
        if data.is_empty() {
            return Err("PrintToPdf 输出文件为空".into());
        }
        data
    } else {
        let data = payload.bytes;
        std::fs::write(output_path, &data)
            .map_err(|error| format!("写入 PDF 失败 {}: {error}", output_path.display()))?;
        data
    };

    Ok(PrintOutcome {
        name: case.name.to_string(),
        window: case.window_label.to_string(),
        document: case.document.to_string(),
        api: if case.legacy_print_to_pdf {
            "ICoreWebView2_7::PrintToPdf".to_string()
        } else {
            "ICoreWebView2_16::PrintToPdfStream".to_string()
        },
        note: case.note.to_string(),
        spec: case.spec.clone(),
        file: Some(output_path.display().to_string()),
        bytes: bytes.len(),
        elapsed_ms: elapsed,
        settings_readback: Some(payload.settings_readback),
        interface_probe: Some(payload.interface_probe),
        error: None,
    })
}

/// 写报告并驱动整个 PDF 矩阵（在后台线程运行）。
fn pdf_worker(
    app: &AppHandle,
    state: &Arc<PdfState>,
    out_dir: &Path,
    monitors: &[MonitorSnapshot],
) -> i32 {
    let started_at = now_millis();
    let mut report = serde_json::json!({
        "mode": "pdf",
        "outputDir": out_dir.display().to_string(),
        "startedAtUnixMs": started_at,
        "webview2Version": tauri::webview_version().unwrap_or_else(|error| format!("unavailable: {error}")),
        "monitors": monitors,
        "windows": {},
        "pageReady": [],
        "cases": [],
        "failures": [],
    });

    if let Err(error) = ensure_dir(out_dir) {
        println!("[FAIL] {error}");
        return 3;
    }

    // ---- 1) 等待三个样例页 ready（页面 load + 字体/图片解码完成） ----
    for (document, label) in [
        ("print-sample-v1", PRIMARY_LABEL),
        ("print-sample-csspage-v1", CSPAGE_LABEL),
        ("print-plain-v1", PLAIN_LABEL),
    ] {
        match state.wait_for_document(document, PAGE_READY_TIMEOUT) {
            Ok(record) => {
                println!(
                    "[ready] document={document} window={label} record={}",
                    record
                );
                if let Some(array) = report["pageReady"].as_array_mut() {
                    array.push(record);
                }
            }
            Err(message) => {
                println!("[FAIL] {message}");
                if let Some(array) = report["failures"].as_array_mut() {
                    array.push(serde_json::json!({"stage": "page-ready", "document": document, "error": message}));
                }
            }
        }
    }
    // 窗口几何/数据目录证据
    for label in [PRIMARY_LABEL, CSPAGE_LABEL, PLAIN_LABEL] {
        if let Some(window) = app.get_webview_window(label) {
            report["windows"][label] = crate::monitors::geometry(&window);
        }
    }

    // ---- 2) 逐个用例打印 ----
    let mut outcomes: Vec<PrintOutcome> = Vec::new();
    for case in cases() {
        let window = match app.get_webview_window(case.window_label) {
            Some(window) => window,
            None => {
                let message = format!("窗口不存在: {}", case.window_label);
                println!("[FAIL] {}: {message}", case.name);
                if let Some(array) = report["failures"].as_array_mut() {
                    array.push(
                        serde_json::json!({"stage": "print", "case": case.name, "error": message}),
                    );
                }
                continue;
            }
        };
        let output_path = out_dir.join(format!("webview2-{}.pdf", case.name));
        match print_case(&window, &case, &output_path) {
            Ok(outcome) => {
                println!(
                    "[ok] {}: {} bytes, {} ms -> {}",
                    outcome.name,
                    outcome.bytes,
                    outcome.elapsed_ms,
                    output_path.display()
                );
                outcomes.push(outcome);
            }
            Err(message) => {
                println!("[FAIL] {}: {message}", case.name);
                if let Some(array) = report["failures"].as_array_mut() {
                    array.push(
                        serde_json::json!({"stage": "print", "case": case.name, "error": message}),
                    );
                }
            }
        }
    }

    // ---- 3) 失败分支：非法纸张设置应被 WebView2 拒绝（单位/值域证据） ----
    let mut failure_branches = Vec::new();
    if let Some(window) = app.get_webview_window(PRIMARY_LABEL) {
        for (name, spec) in [
            (
                "invalid-page-width-zero",
                PrintSpec {
                    page_width_inches: Some(0.0),
                    page_height_inches: Some(A4_HEIGHT_INCHES),
                    ..PrintSpec::default()
                },
            ),
            (
                "invalid-page-width-negative",
                PrintSpec {
                    page_width_inches: Some(-1.0),
                    page_height_inches: Some(A4_HEIGHT_INCHES),
                    ..PrintSpec::default()
                },
            ),
            (
                "microns-value-as-inches",
                PrintSpec {
                    // 基线旧口径：158750 x 105833 是“微米”数值；误当英寸传入会怎样。
                    page_width_inches: Some(158_750.0),
                    page_height_inches: Some(105_833.0),
                    margin_inches: Some(0.0),
                    print_backgrounds: Some(true),
                    scale: Some(1.0),
                    landscape: false,
                },
            ),
            (
                "page-width-below-minimum",
                PrintSpec {
                    // 对应 Electron 侧实测下限：0.25in 会报 "content area is empty"。
                    page_width_inches: Some(0.25),
                    page_height_inches: Some(A4_HEIGHT_INCHES),
                    margin_inches: Some(0.0),
                    print_backgrounds: Some(true),
                    scale: Some(1.0),
                    landscape: false,
                },
            ),
            (
                "invalid-scale-out-of-range",
                PrintSpec {
                    scale: Some(5.0),
                    ..PrintSpec::default()
                },
            ),
        ] {
            let outcome = print_case(
                &window,
                &PdfCase {
                    name: "failure-branch",
                    window_label: PRIMARY_LABEL,
                    document: "print-sample-v1",
                    spec,
                    legacy_print_to_pdf: false,
                    note: "负样本：非法打印设置",
                },
                &out_dir.join("webview2-failure-branch.pdf"),
            );
            let entry = serde_json::json!({
                "probe": name,
                "accepted": outcome.is_ok(),
                "error": outcome.err(),
            });
            println!("[failure-branch] {name}: {entry}");
            failure_branches.push(entry);
        }
    }
    report["failureBranches"] = serde_json::Value::Array(failure_branches);
    report["cases"] = serde_json::to_value(&outcomes).unwrap_or(serde_json::json!([]));
    report["finishedAtUnixMs"] = serde_json::json!(now_millis());
    let failures = report["failures"]
        .as_array()
        .map(|array| array.len())
        .unwrap_or(0);
    report["summary"] = serde_json::json!({
        "caseCount": outcomes.len(),
        "expectedCases": cases().len(),
        "failureCount": failures,
    });

    let report_path = out_dir.join("webview2-print-report.json");
    match write_json(&report_path, &report) {
        Ok(()) => println!("[report] {}", report_path.display()),
        Err(message) => println!("[FAIL] 写报告失败: {message}"),
    }

    let expected = cases().len();
    if outcomes.len() == expected && failures == 0 {
        println!("[PASS] webview2 pdf matrix: {expected} cases");
        0
    } else {
        println!(
            "[FAIL] webview2 pdf matrix: {} / {expected} cases, failures={failures}",
            outcomes.len()
        );
        3
    }
}

/// 启动后台线程执行 PDF 矩阵，结束后退出应用。
pub fn spawn_pdf_worker(
    app: AppHandle,
    state: Arc<PdfState>,
    out_dir: std::path::PathBuf,
    monitors: Vec<MonitorSnapshot>,
    hold_ms: u64,
) {
    std::thread::spawn(move || {
        let code = pdf_worker(&app, &state, &out_dir, &monitors);
        if hold_ms > 0 {
            std::thread::sleep(Duration::from_millis(hold_ms));
        }
        app.exit(code);
    });
}
