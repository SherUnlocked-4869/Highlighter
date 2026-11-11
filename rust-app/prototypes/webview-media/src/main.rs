//! R0-05a：WebView2 屏幕采集 / MediaRecorder 能力原型入口（不是生产宿主）。
//!
//! 只服务计划 §2 D05 / §7 R0-05 / §8 G0 的证据采集；正式宿主、权限映射、录制状态机
//! 与数据根属于 R1/R5。产出文档：`docs/plans/rust-migration/r0-media-webview.md`。
//!
//! 一次进程运行 = 一种 `R0_SCS_MODE`（none / observe / handled-allow / handled-cancel）。
//! 页面加载后先 `init`（宿主注册 ICoreWebView2ScreenCaptureStarting 处理器），再按
//! 场景矩阵逐项探测 getDisplayMedia / 音频轨 / MediaRecorder，最后把完整报告交回宿主写盘并退出。
//!
//! 安全边界（与 R0-03 一致）：Tauri 的 `invoke_handler` 应用命令默认不受 capability ACL
//! 约束，因此命令入口对窗口标签做归属校验（`window-owner-mismatch`）。这只是原型纵深防御，
//! 不等于 R1-04 的角色权限映射。

mod input;
mod screencapture;
mod screens;
mod util;
mod wininfo;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::screencapture::ScsRegistry;

/// 主测试窗口标签。
const MAIN_LABEL: &str = "media-main";
/// 透明浮层测试窗口标签。
const OVERLAY_LABEL: &str = "media-overlay";

/// 一次运行的配置（环境变量，见 README）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfig {
    /// ScreenCaptureStarting 模式。
    pub scs_mode: screencapture::ScsMode,
    /// 运行标签（决定报告文件名）。
    pub tag: String,
    /// 场景（`R0_SCENARIO`）：probe / nogesture / gesture / overlay / full。
    pub scenario: String,
    /// 追加浏览器参数（仅 --auto-select 实验用）。
    pub extra_browser_args: Option<String>,
    /// WebView2 用户数据目录。
    pub data_dir: PathBuf,
    /// 产物目录（`.tmp-r0-media-webview`）。
    pub out_dir: PathBuf,
    /// 看门狗秒数。
    pub watchdog_secs: u64,
}

impl RunConfig {
    fn from_env() -> Result<Self, String> {
        let scs_mode =
            screencapture::ScsMode::parse(&std::env::var("R0_SCS_MODE").unwrap_or_default())?;
        let tag = std::env::var("R0_RUN_TAG")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| scs_mode.as_str().to_string());
        let scenario = std::env::var("R0_SCENARIO")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "full".to_string());
        let extra_browser_args = std::env::var("R0_EXTRA_BROWSER_ARGS")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let out_dir = util::out_dir();
        let data_dir_suffix = std::env::var("R0_DATA_DIR_SUFFIX")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_default();
        let data_dir = out_dir.join(format!("webview2-data{data_dir_suffix}"));
        let watchdog_secs = std::env::var("R0_WATCHDOG_SECS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value >= 20)
            .unwrap_or(240);
        Ok(Self {
            scs_mode,
            tag,
            scenario,
            extra_browser_args,
            data_dir,
            out_dir,
            watchdog_secs,
        })
    }
}

/// 透明浮层测试的跨窗口状态。
#[derive(Default)]
pub struct OverlayShared {
    /// `waiting` → `go` → `done`。
    phase: Mutex<String>,
    /// 浮层回报的结果。
    result: Mutex<Option<Value>>,
    /// 浮层页面 ready 的 Unix 毫秒。
    ready_ms: Mutex<Option<u128>>,
}

/// 应用共享状态。
pub struct HostState {
    /// 运行配置。
    pub config: RunConfig,
    /// 启动 Unix 毫秒。
    pub started_ms: u128,
    /// 页面事件流水文件。
    pub events_path: PathBuf,
    /// 本次运行报告路径。
    pub report_path: PathBuf,
    /// ScreenCaptureStarting 事件注册表。
    pub scs: Arc<ScsRegistry>,
    /// 浮层测试共享状态。
    pub overlay: Arc<OverlayShared>,
    /// 是否已写报告并准备退出。
    pub finished: AtomicBool,
    /// 单次运行的进程号（证据用）。
    pub pid: u32,
    /// OS 点击计数（报告用）。
    pub os_clicks: AtomicU64,
    /// 运行开始时的鼠标位置（结束/失败时恢复，尽量不影响用户）。
    pub cursor_start: Mutex<Option<[i32; 2]>>,
}

impl HostState {
    fn new(config: RunConfig) -> Self {
        let events_path = config.out_dir.join(format!("events-{}.ndjson", config.tag));
        let report_path = config.out_dir.join(format!("report-{}.json", config.tag));
        let scs = ScsRegistry::new(config.scs_mode);
        Self {
            started_ms: util::epoch_ms(),
            events_path,
            report_path,
            scs,
            overlay: Arc::new(OverlayShared::default()),
            config,
            finished: AtomicBool::new(false),
            pid: std::process::id(),
            os_clicks: AtomicU64::new(0),
            cursor_start: Mutex::new(input::cursor_position()),
        }
    }
}

fn main() {
    let config = match RunConfig::from_env() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("[r0-media][fatal] {message}");
            std::process::exit(2);
        }
    };
    if let Err(message) = util::ensure_dir(&config.out_dir) {
        eprintln!("[r0-media][fatal] {message}");
        std::process::exit(2);
    }
    println!(
        "[r0-media][start] tag={} scenario={} scsMode={} pid={} outDir={} dataDir={} extraBrowserArgs={:?}",
        config.tag,
        config.scenario,
        config.scs_mode.as_str(),
        std::process::id(),
        config.out_dir.display(),
        config.data_dir.display(),
        config.extra_browser_args
    );

    let result = tauri::Builder::default()
        .manage(HostState::new(config))
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(message) = setup_windows(&handle) {
                eprintln!("[r0-media][fatal] {message}");
                let state = handle.state::<HostState>();
                write_report(
                    &state,
                    &json!({
                        "schema": "r0-media-webview/1",
                        "status": "setup-failed",
                        "error": message,
                        "epochMs": util::epoch_ms(),
                    }),
                );
                std::process::exit(3);
            }
            start_watchdog(&handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            init_scs,
            cursor_probe,
            host_info,
            host_log,
            scs_events,
            activate,
            screenshot,
            list_windows,
            windows_report,
            recording_chunk,
            recording_finish,
            save_frame,
            overlay_ready,
            overlay_poll,
            overlay_start,
            overlay_report,
            finish_report,
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("[r0-media][fatal] tauri run: {error}");
        std::process::exit(2);
    }
}

// ---------------------------------------------------------------------------
// 窗口创建
// ---------------------------------------------------------------------------

fn setup_windows(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<HostState>();
    let (secondary, _monitor) = screens::select_secondary(app)?;
    println!(
        "[r0-media][monitor] index={} name={:?} primary={} scale={} position={:?} size={:?}",
        secondary.index,
        secondary.name,
        secondary.is_primary,
        secondary.scale_factor,
        secondary.position,
        secondary.size
    );

    // DIP 尺寸 × 本屏缩放 = 物理像素尺寸（本机副屏 125%）。
    let scale = secondary.scale_factor.max(0.5);
    let main_physical = [
        (1000.0 * scale).round() as u32,
        (720.0 * scale).round() as u32,
    ];
    let overlay_physical = [
        (800.0 * scale).round() as u32,
        (420.0 * scale).round() as u32,
    ];
    let (main_position, _) = screens::physical_placement(&secondary, [20, 20], main_physical)?;
    let overlay_offset = [20, 20 + main_physical[1] as i32 + 20];
    let (overlay_position, _) =
        screens::physical_placement(&secondary, overlay_offset, overlay_physical)?;

    util::ensure_dir(&state.config.data_dir)?;

    let mut main_builder =
        WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
            .title("Highlighter R0-05a media webview prototype - MAIN (test only)")
            .inner_size(1000.0, 720.0)
            .resizable(true)
            .always_on_top(true)
            .visible(false)
            .data_directory(state.config.data_dir.clone());
    if let Some(extra) = &state.config.extra_browser_args {
        println!("[r0-media][args] additional_browser_args={extra:?}");
        main_builder = main_builder.additional_browser_args(extra);
    }
    let main_window = main_builder
        .build()
        .map_err(|error| format!("创建主测试窗口失败: {error}"))?;
    main_window
        .set_position(PhysicalPosition::new(main_position[0], main_position[1]))
        .map_err(|error| format!("主窗口 set_position: {error}"))?;
    main_window
        .show()
        .map_err(|error| format!("主窗口 show: {error}"))?;
    println!(
        "[r0-media][window] {} requested=({}, {}) size={:?}",
        MAIN_LABEL, main_position[0], main_position[1], main_physical
    );

    // 透明浮层：先创建但不显示；overlay_start 命令再显示。透明 + 无边框 + 跳过任务栏，
    // 用于回答"透明浮层窗口下 getDisplayMedia 是否受窗口/焦点影响"。
    let mut overlay_builder =
        WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
            .title("Highlighter R0-05a media webview prototype - OVERLAY (test only)")
            .inner_size(800.0, 420.0)
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .always_on_top(true)
            .visible(false)
            .focused(false)
            .no_redirection_bitmap(true)
            .data_directory(state.config.data_dir.clone());
    // 同一个 data_directory 下的 webview 必须使用相同的浏览器参数（Tauri/wry 约束）。
    if let Some(extra) = &state.config.extra_browser_args {
        overlay_builder = overlay_builder.additional_browser_args(extra);
    }
    let overlay_window = overlay_builder
        .build()
        .map_err(|error| format!("创建透明浮层测试窗口失败: {error}"))?;
    overlay_window
        .set_position(PhysicalPosition::new(
            overlay_position[0],
            overlay_position[1],
        ))
        .map_err(|error| format!("浮层窗口 set_position: {error}"))?;
    println!(
        "[r0-media][window] {} requested=({}, {}) size={:?}",
        OVERLAY_LABEL, overlay_position[0], overlay_position[1], overlay_physical
    );
    Ok(())
}

fn start_watchdog(app: &AppHandle) {
    let handle = app.clone();
    let secs = {
        let state = app.state::<HostState>();
        state.config.watchdog_secs
    };
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(secs));
        let state = handle.state::<HostState>();
        if state.finished.load(Ordering::SeqCst) {
            return;
        }
        eprintln!("[r0-media][watchdog] {secs}s 未完成，强制退出（status=watchdog-timeout）");
        write_report(
            &state,
            &json!({
                "schema": "r0-media-webview/1",
                "status": "watchdog-timeout",
                "tag": state.config.tag,
                "scsMode": state.config.scs_mode,
                "epochMs": util::epoch_ms(),
            }),
        );
        handle.exit(3);
        std::thread::sleep(Duration::from_secs(2));
        std::process::exit(3);
    });
}

// ---------------------------------------------------------------------------
// 报告辅助
// ---------------------------------------------------------------------------

fn write_report(state: &HostState, report: &Value) -> Option<PathBuf> {
    let _ = util::ensure_dir(&state.config.out_dir);
    match serde_json::to_string_pretty(report) {
        Ok(text) => match std::fs::write(&state.report_path, text) {
            Ok(()) => {
                println!("[r0-media][report] {}", state.report_path.display());
                Some(state.report_path.clone())
            }
            Err(error) => {
                eprintln!(
                    "[r0-media][report-error] {}: {error}",
                    state.report_path.display()
                );
                None
            }
        },
        Err(error) => {
            eprintln!("[r0-media][report-error] serialize: {error}");
            None
        }
    }
}

fn append_event(state: &HostState, window: &str, event: &str, payload: &Value) {
    let line = json!({
        "week": "r0-05a",
        "epochMs": util::epoch_ms(),
        "window": window,
        "event": event,
        "payload": payload,
    });
    if let Err(error) = util::append_ndjson(&state.events_path, &line) {
        eprintln!("[r0-media][event-error] {error}");
    }
}

/// 命令归属校验：只允许原型自己的两个窗口调用。
fn ensure_known_window(window: &WebviewWindow) -> Result<String, String> {
    let label = window.label().to_string();
    if label == MAIN_LABEL || label == OVERLAY_LABEL {
        Ok(label)
    } else {
        Err(format!("window-owner-mismatch: 未知窗口标签 {label:?}"))
    }
}

// ---------------------------------------------------------------------------
// 命令面
// ---------------------------------------------------------------------------

/// 注册 ICoreWebView2ScreenCaptureStarting 处理器（页面握手第一步，必须先于任何 getDisplayMedia）。
#[tauri::command]
async fn init_scs(window: WebviewWindow, state: State<'_, HostState>) -> Result<Value, String> {
    let label = ensure_known_window(&window)?;
    screencapture::install(&window, state.scs.clone(), &label)?;
    append_event(
        &state,
        &label,
        "init-scs",
        &json!({ "mode": state.config.scs_mode }),
    );
    println!(
        "[r0-media][init-scs] label={label} mode={} registered={}",
        state.config.scs_mode.as_str(),
        state.scs.is_registered()
    );
    Ok(json!({
        "ok": true,
        "label": label,
        "mode": state.config.scs_mode,
        "registered": state.scs.is_registered(),
        "epochMs": util::epoch_ms(),
    }))
}

/// 光标/输入注入诊断（记录 SetCursorPos 与 SendInput 两条路径的真实返回值）。
#[tauri::command]
async fn cursor_probe(window: WebviewWindow) -> Result<Value, String> {
    let _label = ensure_known_window(&window)?;
    let report = input::cursor_probe();
    println!("[r0-media][cursor-probe] {report}");
    Ok(report)
}

/// 页面握手：返回运行配置、环境版本、显示器与窗口几何。
#[tauri::command]
async fn host_info(window: WebviewWindow) -> Result<Value, String> {
    let label = ensure_known_window(&window)?;
    let app = window.app_handle();
    let state = app.state::<HostState>();
    let monitors = screens::list(app).unwrap_or_default();
    let webview_version = tauri::webview_version()
        .map(Value::String)
        .unwrap_or(Value::Null);
    let windows = collect_window_geometry(app);
    Ok(json!({
        "schema": "r0-media-webview/1",
        "label": label,
        "pid": state.pid,
        "startedMs": state.started_ms,
        "scsMode": state.config.scs_mode,
        "scsRegistered": state.scs.is_registered(),
        "tag": state.config.tag,
        "scenario": state.config.scenario,
        "extraBrowserArgs": state.config.extra_browser_args,
        "outDir": state.config.out_dir.display().to_string(),
        "dataDir": state.config.data_dir.display().to_string(),
        "webviewVersion": webview_version,
        "userAgent": null,
        "monitors": monitors,
        "windows": windows,
        "os": {
            "cpus": std::thread::available_parallelism().map(|value| value.get()).unwrap_or(0),
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
        },
    }))
}

/// 页面写一条宿主侧事件流水（NDJSON）。
#[tauri::command]
async fn host_log(
    window: WebviewWindow,
    state: State<'_, HostState>,
    event: String,
    payload: Value,
) -> Result<Value, String> {
    let label = ensure_known_window(&window)?;
    append_event(&state, &label, &event, &payload);
    println!("[r0-media][page-event] {label} {event} {payload}");
    Ok(json!({ "ok": true, "epochMs": util::epoch_ms() }))
}

/// ScreenCaptureStarting 事件流水与注册状态。
#[tauri::command]
async fn scs_events(state: State<'_, HostState>) -> Result<Value, String> {
    Ok(json!({
        "mode": state.config.scs_mode,
        "registered": state.scs.is_registered(),
        "events": state.scs.snapshot(),
    }))
}

/// 真实 OS 输入激活 / ESC / CDP 备用点击。
#[tauri::command]
async fn activate(
    window: WebviewWindow,
    state: State<'_, HostState>,
    via: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<Value, String> {
    let label = ensure_known_window(&window)?;
    match via.as_str() {
        "os" => {
            let hwnd = window.hwnd().map_err(|error| format!("hwnd: {error}"))?;
            let report = input::click_client_center(hwnd)?;
            state.os_clicks.fetch_add(1, Ordering::SeqCst);
            append_event(&state, &label, "os-click", &json!(report));
            println!(
                "[r0-media][input] os-click label={label} hwnd={} client={:?} point={:?}",
                report.hwnd, report.client_size, report.screen_point
            );
            Ok(
                json!({ "method": "os-click", "ok": true, "report": report, "epochMs": util::epoch_ms() }),
            )
        }
        "cdp" => {
            let (cx, cy) = (x.unwrap_or(f64::NAN), y.unwrap_or(f64::NAN));
            if cx.is_nan() || cy.is_nan() {
                return Err("cdp-click: 需要 x/y（CSS 像素）".to_string());
            }
            input::cdp_click(&window, cx, cy)?;
            append_event(&state, &label, "cdp-click", &json!({ "x": cx, "y": cy }));
            println!("[r0-media][input] cdp-click label={label} x={cx} y={cy}");
            Ok(
                json!({ "method": "cdp-click", "ok": true, "x": cx, "y": cy, "epochMs": util::epoch_ms() }),
            )
        }
        "escape" => {
            input::press_escape()?;
            append_event(&state, &label, "escape", &json!({}));
            println!("[r0-media][input] escape label={label}");
            Ok(json!({ "method": "escape", "ok": true, "epochMs": util::epoch_ms() }))
        }
        other => Err(format!(
            "activate: 未知 via={other:?}（可选 os/cdp/escape）"
        )),
    }
}

/// 抓取整块虚拟桌面截图（attempt 到"等待选源"时留证）。
#[tauri::command]
async fn screenshot(
    window: WebviewWindow,
    state: State<'_, HostState>,
    tag: String,
) -> Result<Value, String> {
    let label = ensure_known_window(&window)?;
    let screenshots = state.config.out_dir.join("screenshots");
    util::ensure_dir(&screenshots)?;
    let safe_tag = sanitize_tag(&tag);
    let out_path = screenshots.join(format!("{}-{}-{}.png", safe_tag, label, util::epoch_ms()));
    let script = util::manifest_dir()
        .join("tools")
        .join("capture-screen.ps1");
    if !script.exists() {
        return Err(format!("missing script {}", script.display()));
    }
    let script_text = script.display().to_string();
    let out_text = out_path.display().to_string();
    // 受沙箱限制的宿主里，子进程可能无法写 %LOCALAPPDATA%\\Temp（Add-Type 需要临时文件）；
    // 把 TMP/TEMP 指到本原型产物目录，保证截图脚本可用。
    let tmp_dir = state.config.out_dir.join("tmp");
    util::ensure_dir(&tmp_dir)?;
    let output = std::process::Command::new("powershell")
        .env("TMP", &tmp_dir)
        .env("TEMP", &tmp_dir)
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script_text.as_str(),
            "-Out",
            out_text.as_str(),
        ])
        .output()
        .map_err(|error| format!("spawn powershell: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let success = output.status.success() && out_path.exists();
    append_event(
        &state,
        &label,
        "screenshot",
        &json!({ "tag": safe_tag, "path": out_path.display().to_string(), "success": success }),
    );
    println!(
        "[r0-media][screenshot] tag={safe_tag} path={} success={}",
        out_path.display(),
        success
    );
    Ok(json!({
        "tag": safe_tag,
        "path": out_path.display().to_string(),
        "success": success,
        "exitCode": output.status.code(),
        "stdout": stdout.trim(),
        "stderr": stderr.trim(),
        "epochMs": util::epoch_ms(),
    }))
}

/// 顶层窗口快照（含进程名/类名/矩形），用于识别选源 UI。
#[tauri::command]
async fn list_windows(
    window: WebviewWindow,
    state: State<'_, HostState>,
    tag: String,
) -> Result<Value, String> {
    let label = ensure_known_window(&window)?;
    let safe_tag = sanitize_tag(&tag);
    let windows = collect_window_geometry(window.app_handle());
    let top_level = wininfo::enumerate();
    let interesting: Vec<&wininfo::WindowInfo> = top_level
        .iter()
        .filter(|info| {
            info.pid == state.pid
                || info.visible
                    && (info.class.contains("Chrome_WidgetWin")
                        || info.title.to_ascii_lowercase().contains("share")
                        || info.title.to_ascii_lowercase().contains("capture")
                        || info.title.to_ascii_lowercase().contains("highlighter"))
                || info
                    .process
                    .as_deref()
                    .map(|name| name.eq_ignore_ascii_case("msedgewebview2.exe"))
                    .unwrap_or(false)
        })
        .collect();
    // WebView2 的选源/权限 UI 可能是宿主窗口的 child HWND（顶层枚举会漏掉），
    // 因此把两个原型窗口的全部子窗口也列出来。
    let mut children = Vec::new();
    for label in [MAIN_LABEL, OVERLAY_LABEL] {
        if let Some(prototype_window) = window.app_handle().get_webview_window(label) {
            if let Ok(hwnd) = prototype_window.hwnd() {
                for child in wininfo::enumerate_children(hwnd) {
                    children.push(json!({ "parentLabel": label, "child": child }));
                }
            }
        }
    }
    let payload = json!({
        "tag": safe_tag,
        "window": label,
        "ourWindows": windows,
        "topLevelCount": top_level.len(),
        "interesting": interesting,
        "childrenOfPrototypeWindows": children,
    });
    append_event(&state, &label, "list-windows", &payload);
    println!(
        "[r0-media][windows] tag={safe_tag} total={} interesting={} children={}",
        top_level.len(),
        interesting.len(),
        children.len()
    );
    Ok(payload)
}

/// 原型两个窗口的几何/可见性/所在显示器。
#[tauri::command]
async fn windows_report(app: AppHandle) -> Result<Value, String> {
    let state = app.state::<HostState>();
    let windows = collect_window_geometry(&app);
    append_event(&state, "host", "windows-report", &windows);
    Ok(windows)
}

fn collect_window_geometry(app: &AppHandle) -> Value {
    let mut list = Vec::new();
    for label in [MAIN_LABEL, OVERLAY_LABEL] {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        let position = window.outer_position().ok().map(|value| [value.x, value.y]);
        let outer = window
            .outer_size()
            .ok()
            .map(|value| [value.width, value.height]);
        let inner = window
            .inner_size()
            .ok()
            .map(|value| [value.width, value.height]);
        let monitor = window.current_monitor().ok().flatten();
        list.push(json!({
            "label": label,
            "visible": window.is_visible().unwrap_or(false),
            "focused": window.is_focused().unwrap_or(false),
            "position": position,
            "outerSize": outer,
            "innerSize": inner,
            "scaleFactor": window.scale_factor().ok(),
            "monitorName": monitor.as_ref().and_then(|monitor| monitor.name().cloned()),
            "monitorPosition": monitor.as_ref().map(|monitor| {
                let position = monitor.position();
                [position.x, position.y]
            }),
            "monitorSize": monitor.as_ref().map(|monitor| {
                let size = monitor.size();
                [size.width, size.height]
            }),
        }));
    }
    Value::Array(list)
}

/// 追加一段录制数据（页面把 MediaRecorder 的 chunk base64 分块交回宿主）。
#[tauri::command]
async fn recording_chunk(
    window: WebviewWindow,
    state: State<'_, HostState>,
    name: String,
    seq: u32,
    data: String,
) -> Result<Value, String> {
    let _label = ensure_known_window(&window)?;
    let recordings = state.config.out_dir.join("recordings");
    util::ensure_dir(&recordings)?;
    let safe_name = sanitize_tag(&name);
    if !safe_name.ends_with(".webm") && !safe_name.ends_with(".part") {
        return Err("recording_chunk: name 必须是 *.webm".to_string());
    }
    let partial = recordings.join(format!("{safe_name}.part"));
    let bytes = util::decode_base64(&data)?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&partial)
        .map_err(|error| format!("open {}: {error}", partial.display()))?;
    file.write_all(&bytes)
        .map_err(|error| format!("write {}: {error}", partial.display()))?;
    let total = std::fs::metadata(&partial)
        .map(|meta| meta.len())
        .unwrap_or(0);
    Ok(
        json!({ "ok": true, "name": safe_name, "seq": seq, "chunkBytes": bytes.len(), "bytes": total }),
    )
}

/// 结束一段录制：把 `.part` 落成最终文件并返回大小。
#[tauri::command]
async fn recording_finish(
    window: WebviewWindow,
    state: State<'_, HostState>,
    name: String,
) -> Result<Value, String> {
    let _label = ensure_known_window(&window)?;
    let recordings = state.config.out_dir.join("recordings");
    util::ensure_dir(&recordings)?;
    let safe_name = sanitize_tag(&name);
    let partial = recordings.join(format!("{safe_name}.part"));
    let final_path = recordings.join(&safe_name);
    std::fs::rename(&partial, &final_path)
        .map_err(|error| format!("rename {}: {error}", partial.display()))?;
    let bytes = std::fs::metadata(&final_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    println!(
        "[r0-media][recording] saved {} bytes={bytes}",
        final_path.display()
    );
    Ok(json!({
        "ok": true,
        "name": safe_name,
        "path": final_path.display().to_string(),
        "bytes": bytes,
        "epochMs": util::epoch_ms(),
    }))
}

/// 保存一张从采集流里抓的帧（PNG dataURL），作为"实际采到了什么"的证据。
#[tauri::command]
async fn save_frame(
    window: WebviewWindow,
    state: State<'_, HostState>,
    tag: String,
    data_url: String,
) -> Result<Value, String> {
    let _label = ensure_known_window(&window)?;
    let prefix = "data:image/png;base64,";
    let payload = data_url
        .strip_prefix(prefix)
        .ok_or_else(|| format!("save_frame: 只接受 {prefix} 前缀"))?;
    let bytes = util::decode_base64(payload)?;
    let frames = state.config.out_dir.join("frames");
    util::ensure_dir(&frames)?;
    let safe_tag = sanitize_tag(&tag);
    let path = frames.join(format!("{safe_tag}-{}.png", util::epoch_ms()));
    std::fs::write(&path, &bytes).map_err(|error| format!("write {}: {error}", path.display()))?;
    println!(
        "[r0-media][frame] saved {} bytes={}",
        path.display(),
        bytes.len()
    );
    Ok(json!({ "ok": true, "path": path.display().to_string(), "bytes": bytes.len() }))
}

/// 浮层页面就绪。
#[tauri::command]
async fn overlay_ready(
    window: WebviewWindow,
    state: State<'_, HostState>,
) -> Result<Value, String> {
    let label = ensure_known_window(&window)?;
    if label != OVERLAY_LABEL {
        return Err(format!(
            "overlay-ready: 调用窗口必须是 {OVERLAY_LABEL}，实际 {label}"
        ));
    }
    let mut ready = state
        .overlay
        .ready_ms
        .lock()
        .map_err(|_| "overlay_ready: ready_ms lock poisoned".to_string())?;
    *ready = Some(util::epoch_ms());
    let phase = state
        .overlay
        .phase
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "unknown".to_string());
    println!("[r0-media][overlay] ready label={label} phase={phase}");
    Ok(json!({ "ok": true, "phase": phase, "epochMs": util::epoch_ms() }))
}

/// 浮层页面轮询阶段（waiting/go/done）。
#[tauri::command]
async fn overlay_poll(state: State<'_, HostState>) -> Result<Value, String> {
    let phase = state
        .overlay
        .phase
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "unknown".to_string());
    let result = state
        .overlay
        .result
        .lock()
        .map(|value| value.clone())
        .unwrap_or(None);
    Ok(json!({ "phase": phase, "result": result, "epochMs": util::epoch_ms() }))
}

/// 主窗口请求进入浮层测试：显示浮层并置 phase=go；主窗口重新拿焦点（测量"未聚焦"路径）。
#[tauri::command]
async fn overlay_start(
    window: WebviewWindow,
    state: State<'_, HostState>,
) -> Result<Value, String> {
    let label = ensure_known_window(&window)?;
    if label != MAIN_LABEL {
        return Err(format!(
            "overlay-start: 调用窗口必须是 {MAIN_LABEL}，实际 {label}"
        ));
    }
    let app = window.app_handle();
    {
        let mut phase = state
            .overlay
            .phase
            .lock()
            .map_err(|_| "overlay_start: phase lock poisoned".to_string())?;
        *phase = "go".to_string();
    }
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        overlay
            .show()
            .map_err(|error| format!("overlay show: {error}"))?;
    }
    // 让主窗口保持前台，浮层处于"可见但未聚焦"，用于测 CDP 激活是否依赖 OS 焦点。
    let _ = window.set_focus();
    append_event(&state, &label, "overlay-start", &json!({}));
    println!("[r0-media][overlay] start");
    Ok(json!({ "ok": true, "phase": "go", "epochMs": util::epoch_ms() }))
}

/// 浮层回报结果。
#[tauri::command]
async fn overlay_report(
    window: WebviewWindow,
    state: State<'_, HostState>,
    report: Value,
) -> Result<Value, String> {
    let label = ensure_known_window(&window)?;
    if label != OVERLAY_LABEL {
        return Err(format!(
            "overlay-report: 调用窗口必须是 {OVERLAY_LABEL}，实际 {label}"
        ));
    }
    {
        let mut result = state
            .overlay
            .result
            .lock()
            .map_err(|_| "overlay_report: result lock poisoned".to_string())?;
        *result = Some(report);
    }
    if let Ok(mut phase) = state.overlay.phase.lock() {
        *phase = "done".to_string();
    }
    append_event(
        &state,
        &label,
        "overlay-report",
        &json!({ "received": true }),
    );
    println!("[r0-media][overlay] report received");
    Ok(json!({ "ok": true, "epochMs": util::epoch_ms() }))
}

/// 主窗口提交完整报告：写盘、打印摘要、退出进程。
#[tauri::command]
async fn finish_report(
    window: WebviewWindow,
    state: State<'_, HostState>,
    report: Value,
) -> Result<Value, String> {
    let label = ensure_known_window(&window)?;
    if label != MAIN_LABEL {
        return Err(format!(
            "finish-report: 调用窗口必须是 {MAIN_LABEL}，实际 {label}"
        ));
    }
    if state.finished.swap(true, Ordering::SeqCst) {
        return Ok(json!({ "ok": true, "alreadyFinished": true }));
    }
    let mut final_report = report;
    if let Some(object) = final_report.as_object_mut() {
        object.insert("schema".into(), json!("r0-media-webview/1"));
        object.insert("tag".into(), json!(state.config.tag));
        object.insert("scsMode".into(), json!(state.config.scs_mode));
        object.insert("pid".into(), json!(state.pid));
        object.insert("startedMs".into(), json!(state.started_ms));
        object.insert("finishedMs".into(), json!(util::epoch_ms()));
        object.insert(
            "scs".into(),
            json!({ "registered": state.scs.is_registered(), "events": state.scs.snapshot() }),
        );
        object.insert(
            "outDir".into(),
            json!(state.config.out_dir.display().to_string()),
        );
        object.insert(
            "dataDir".into(),
            json!(state.config.data_dir.display().to_string()),
        );
        object.insert(
            "extraBrowserArgs".into(),
            json!(state.config.extra_browser_args),
        );
        object.insert(
            "webviewVersion".into(),
            tauri::webview_version()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        object.insert(
            "monitorsAtFinish".into(),
            json!(screens::list(window.app_handle()).unwrap_or_default()),
        );
        object.insert(
            "windowsAtFinish".into(),
            collect_window_geometry(window.app_handle()),
        );
        object.insert(
            "osClicks".into(),
            json!(state.os_clicks.load(Ordering::SeqCst)),
        );
    }
    let path = write_report(&state, &final_report);
    println!(
        "[r0-media][finish] tag={} report={:?}",
        state.config.tag, path
    );
    // 恢复运行前的鼠标位置（OS 双击激活会移动真实光标）。
    if let Ok(cursor) = state.cursor_start.lock() {
        if let Some([x, y]) = *cursor {
            input::set_cursor([x, y]);
        }
    }
    let app = window.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        app.exit(0);
        std::thread::sleep(Duration::from_secs(3));
        std::process::exit(0);
    });
    Ok(json!({
        "ok": true,
        "reportPath": path.map(|path| path.display().to_string()),
        "epochMs": util::epoch_ms(),
    }))
}

fn sanitize_tag(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unnamed".to_string()
    } else {
        cleaned
    }
}

/// 供 clippy/文档引用的窗口尺寸类型别名（Tauri 的 PhysicalSize 在报告里以数组表达）。
#[allow(dead_code)]
fn physical_size_of(window: &WebviewWindow) -> Option<PhysicalSize<u32>> {
    window.inner_size().ok()
}
