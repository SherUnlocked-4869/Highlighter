//! R0-06：WebView2 PDF 打印 + 二进制资源通道最小原型入口。
//!
//! **这不是生产宿主。** 本原型只验证计划 §7 R0-06 的两条链路，为 ADR-0003（PDF 后端）
//! 与 ADR-0005（二进制资源传输）提供实测证据：
//!
//! A. `--pdf`：隐藏窗口加载合成打印样例（中文/表格/内嵌 PNG/@page/跨页/透明元素），
//!    用 WebView2 `ICoreWebView2_16::PrintToPdfStream`（以及旧 API `PrintToPdf`）打印矩阵，
//!    产物与报告写 `.tmp-r0-pdf/`；Electron 侧对照由 `scripts/rust/probe-electron-pdf.js` 生成。
//!
//! B. `--resource`：注册自定义 URI scheme `media://`（Windows 映射为
//!    `http://media.localhost/...`）与 command 二进制响应两条路径，验证图片显示、video
//!    Range/seek、不可猜测 ID、TTL/撤销、路径遍历拒绝、CSP、窗口归属鉴权与 20 MiB
//!    传输对照；产物与报告写 `.tmp-r0-resource/`。
//!
//! 明确的原型缺口（计划 §4.3）：Tauri 的 `invoke_handler` 应用命令默认不经过
//! capability ACL，任何能加载本地页面的窗口都可以调用这些命令；`capabilities/` 只约束
//! 插件/核心权限。命令入口另外用 webview label 做资源归属校验（纵深防御），但这不是
//! R1-04 的角色权限映射。原生 `get_webview_window` 等宿主位置的窗口 label 由宿主控制，
//! 页面无法伪造（页面只能看到自己的 window）。
//!
//! 可见窗口只出现在非主显示器；PDF 打印窗口全部隐藏。

mod cli;
mod monitors;
mod pdf;
mod pdf_product;
mod resource;
mod shared;

use std::sync::Arc;

use tauri::{WebviewUrl, WebviewWindowBuilder};

use crate::cli::Mode;
use crate::shared::CommandError;

/// `pdf_page_ready`：页面（load + 字体/图片解码完成）通知宿主“可以打印了”。
///
/// 命令入口按 window label 校验调用窗口必须是三个打印窗口之一（纵深防御；见文件头）。
#[tauri::command]
fn pdf_page_ready(
    window: tauri::WebviewWindow,
    document: String,
    error: Option<String>,
    state: tauri::State<'_, Arc<pdf::PdfState>>,
) -> Result<serde_json::Value, CommandError> {
    let label = window.label().to_string();
    let known = [pdf::PRIMARY_LABEL, pdf::CSPAGE_LABEL, pdf::PLAIN_LABEL];
    if !known.contains(&label.as_str()) {
        return Err(CommandError::new(
            "window-owner-mismatch",
            format!("pdf_page_ready 只接受打印窗口调用，收到 {label}"),
        ));
    }
    let record = serde_json::json!({
        "windowLabel": label,
        "document": document,
        "error": error,
        "receivedAtUnixMs": crate::shared::now_millis(),
    });
    state.mark_ready(record.clone());
    println!(
        "[pdf_page_ready] window={} document={}",
        record["windowLabel"], record["document"]
    );
    Ok(serde_json::json!({ "accepted": true, "record": record }))
}

fn main() {
    let options = match cli::parse(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("[r0-pdf-resource] 参数错误: {message}");
            eprintln!("{}", cli::USAGE);
            std::process::exit(2);
        }
    };
    if options.help {
        println!("{}", cli::USAGE);
        return;
    }
    match options.mode {
        Mode::Pdf => run_pdf(options),
        Mode::PdfProduct => {
            let code = pdf_product::run(options);
            std::process::exit(code);
        }
        Mode::Resource => run_resource(options),
    }
}

// ---------------------------------------------------------------------------
// A. PDF 模式
// ---------------------------------------------------------------------------

fn run_pdf(options: cli::Options) {
    // 旧 API `ICoreWebView2_7::PrintToPdf` 只接受绝对路径（实测相对路径 → E_INVALIDARG），
    // 因此产物目录统一规范成绝对路径再进入矩阵。
    let raw_output_dir = options
        .out_dir
        .clone()
        .unwrap_or_else(crate::shared::pdf_dir);
    let output_dir = std::path::absolute(&raw_output_dir).unwrap_or(raw_output_dir);
    let state = Arc::new(pdf::PdfState::default());
    let state_for_setup = Arc::clone(&state);
    let options_for_setup = options.clone();
    let output_for_setup = output_dir.clone();

    let app = tauri::Builder::default()
        .manage(Arc::clone(&state))
        .invoke_handler(tauri::generate_handler![pdf_page_ready])
        .setup(move |app| {
            let monitor_snapshots = match monitors::collect(app.handle()) {
                Ok(monitors) => monitors,
                Err(message) => {
                    println!("[r0-pdf] 显示器枚举失败（不影响隐藏打印窗口）: {message}");
                    Vec::new()
                }
            };
            println!("[r0-pdf] monitors={monitor_snapshots:?}");

            // 三个隐藏打印窗口：主样例、CSS @page 样例、无 @page 对照样例。
            let windows = [
                (pdf::PRIMARY_LABEL, "print-sample.html"),
                (pdf::CSPAGE_LABEL, "print-sample-csspage.html"),
                (pdf::PLAIN_LABEL, "print-plain.html"),
            ];
            for (label, page) in windows {
                let mut builder =
                    WebviewWindowBuilder::new(app.handle(), label, WebviewUrl::App(page.into()))
                        .title("Highlighter R0-06 PDF print window")
                        .inner_size(900.0, 700.0)
                        .visible(false)
                        .decorations(false)
                        .skip_taskbar(true)
                        .focused(false)
                        .shadow(false);
                #[cfg(windows)]
                {
                    let data_directory = output_for_setup.join("webview2-data").join(label);
                    if let Err(error) = crate::shared::ensure_dir(&data_directory) {
                        println!("[r0-pdf] 创建 WebView2 数据目录失败: {error}");
                    }
                    builder = builder.data_directory(data_directory);
                }
                match builder.build() {
                    Ok(_) => println!("[r0-pdf] hidden window created: {label} -> {page}"),
                    Err(error) => {
                        println!("[FAIL] 创建打印窗口 {label} 失败: {error}");
                        app.handle().exit(3);
                        return Ok(());
                    }
                }
            }

            let app_handle = app.handle().clone();
            pdf::spawn_pdf_worker(
                app_handle,
                Arc::clone(&state_for_setup),
                output_for_setup.clone(),
                monitor_snapshots,
                options_for_setup.hold_ms,
            );
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("[r0-pdf] 构建 Tauri 应用失败: {error}");
            std::process::exit(3);
        }
    };
    let exit_code = app.run_return(|_app, _event| {});
    println!("[r0-pdf] event loop exited code={exit_code}");
    std::process::exit(exit_code);
}

// ---------------------------------------------------------------------------
// B. 资源通道模式
// ---------------------------------------------------------------------------

fn run_resource(options: cli::Options) {
    resource::run(options);
}
