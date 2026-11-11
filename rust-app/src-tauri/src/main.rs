//! R0-03：Tauri 2 透明窗口/截图浮层最小原型入口。
//!
//! **这不是生产宿主**。本原型只验证计划 §7 R0-03 的窗口链路：
//! - 无窗口启动（`tauri.conf.json` 的 `app.windows` 为空），由 setup 钩子创建浮层；
//! - 透明、无边框、无任务栏图标、始终置顶的副屏浮层；
//! - 显示器枚举（名称/缩放/物理与 DIP 位置尺寸）、物理像素与“按主显示器缩放”的 DIP 定位；
//! - 创建/显示/隐藏/销毁命令面；
//! - 页面 ready → 宿主 init（只发一次）→ 页面回报 `devicePixelRatio` 与 Canvas 尺寸的握手；
//! - `--self-test` 无人值守自检：只允许出现在副屏（负坐标场景），打印验证行后 2~5 秒退出。
//!
//! 明确的原型缺口（计划 §4.3）：Tauri 的 `invoke_handler` 应用命令**默认不经过
//! capability ACL**，任何能加载本地页面的窗口都可以调用这些命令；`capabilities/` 只约束
//! 插件/核心权限（本例只有 `core:event:allow-listen`）。命令入口因此额外校验调用窗口
//! 必须是 `prototype-overlay`（`window-owner-mismatch`），但这只是纵深防御，不等于
//! 完成了 R1-04 的角色权限映射。详见 `docs/plans/rust-migration/r0-window-prototype.md`。

#![forbid(unsafe_code)]

mod cli;
mod handshake;
mod monitors;
mod overlay;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow};

use crate::handshake::{Handshake, MetricsReport, PROTOCOL};
use crate::monitors::MonitorSnapshot;

/// 浮层窗口标签（capability 与窗口归属校验都用它）。
pub const OVERLAY_LABEL: &str = "prototype-overlay";
/// 页面角色：R0 用固定字符串，R1 换 `contracts` 的 `WindowRole`。
pub const OVERLAY_ROLE: &str = "capture-overlay";
/// prototype 阶段的 generation 固定 1；正式的窗口实例 generation 属于 R1-02。
pub const PROTOTYPE_GENERATION: u64 = 1;
/// 宿主 → 页面的 init 事件名（加 `prototype:` 前缀，避免与未来正式合同冲突）。
pub const EVENT_PROTOTYPE_INIT: &str = "prototype:init";
/// 自检等待页面握手的超时。
const SELF_TEST_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// 窗口“请求 vs 实际”位置容差（Windows/DWM 可能微调几像素）。
const POSITION_TOLERANCE_PX: i64 = 8;
/// 测试专用开关是否允许主屏（由 `HIGHLIGHTER_R0_ALLOW_PRIMARY=1` 在 main 里设置）。
/// 未设置时保持 `false`，与原有安全约定完全一致。
static ALLOW_PRIMARY: AtomicBool = AtomicBool::new(false);

/// 命令错误（R0 原型版；正式 `OperationError` 由 `contracts` crate 定义）。
#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    /// 机器可读错误码，例如 `window-owner-mismatch` / `monitor-not-found`。
    pub code: String,
    /// 面向人/日志的说明（R0 不含本地化 messageKey）。
    pub message: String,
}

impl CommandError {
    /// 构造错误。
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

/// 放置结果：请求值 + 读回的实际几何/可见性。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementSummary {
    /// 请求的物理像素位置。
    pub requested_position: [i32; 2],
    /// 请求的物理像素尺寸。
    pub requested_size: [u32; 2],
    /// 读回的外框左上角（物理像素）。
    pub actual_position: [i32; 2],
    /// 读回的内容区尺寸（物理像素）。
    pub actual_inner_size: [u32; 2],
    /// 读回的外框尺寸（物理像素）。
    pub actual_outer_size: [u32; 2],
    /// 窗口缩放因子。
    pub scale_factor: f64,
    /// 当前是否可见。
    pub visible: bool,
}

/// `host_list_monitors` 的返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorListResponse {
    /// 显示器快照（按枚举顺序，`index` 稳定）。
    pub monitors: Vec<MonitorSnapshot>,
    /// 主显示器缩放因子（DIP 定位命令使用）。
    pub primary_scale: f64,
    /// 默认目标副屏序号（未检测到副屏时为 `None`）。
    pub secondary_index: Option<usize>,
}

/// `prototype_ready` 的应答。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitAck {
    /// 是否接受（窗口归属校验通过）。
    pub accepted: bool,
    /// 本次调用是否真的发送了 init。
    pub init_sent_now: bool,
    /// init 之前是否已经发送过（重复 ready 只应答、不重发）。
    pub init_already_sent: bool,
    /// 原型 generation（固定 1）。
    pub generation: u64,
}

/// `prototype_report_metrics` 的应答。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsAck {
    /// 是否接受（窗口归属校验通过）。
    pub accepted: bool,
    /// 这是第几次指标回报。
    pub report_count: u64,
}

/// init 事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitPayload {
    /// 原型协议标识。
    pub protocol: &'static str,
    /// 窗口角色（R0 固定字符串）。
    pub role: &'static str,
    /// generation（R0 固定 1）。
    pub generation: u64,
    /// 浮层窗口标签。
    pub overlay_label: &'static str,
    /// 页面绘制自检图案的参数（避免页面与宿主各自写一套魔数）。
    pub pattern: PatternSpec,
}

/// Canvas 自检图案参数。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternSpec {
    /// 棋盘格单元大小（CSS 像素）。
    pub cell_css_px: f64,
    /// 边缘标记内缩（CSS 像素）。
    pub margin_css_px: f64,
    /// 强调色（CSS 颜色）。
    pub accent: &'static str,
}

/// 启动阶段产出的证据，供自检线程校验/打印。
#[derive(Debug, Clone)]
struct StartupReport {
    monitors: Vec<MonitorSnapshot>,
    target_index: usize,
    target: MonitorSnapshot,
    primary_scale: f64,
    placement: PlacementSummary,
}

// ---------------------------------------------------------------------------
// Tauri 命令面（原型）
// ---------------------------------------------------------------------------

/// 列出显示器（名称/缩放/物理与 DIP 位置尺寸）。
#[tauri::command]
fn host_list_monitors(app: AppHandle) -> Result<MonitorListResponse, CommandError> {
    let (monitors, primary_scale) = collect_monitors(&app)?;
    let secondary_index = monitors.iter().position(|monitor| !monitor.is_primary);
    Ok(MonitorListResponse {
        monitors,
        primary_scale,
        secondary_index,
    })
}

/// 创建浮层窗口（隐藏状态）。async 是刻意的：Tauri 文档说明 Windows 上在同步命令里
/// 同步创建 WebView 窗口会死锁。
#[tauri::command]
async fn host_create_overlay(app: AppHandle) -> Result<PlacementSummary, CommandError> {
    let window = overlay::ensure_window(&app)?;
    println!("[overlay] create command label={}", window.label());
    overlay::summarize_current(&window)
}

/// 物理像素定位（显示器原点 + 偏移；`width/height` 省略则铺满显示器）。
#[tauri::command]
fn host_place_overlay(
    app: AppHandle,
    monitor_index: usize,
    offset_x: Option<i32>,
    offset_y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<PlacementSummary, CommandError> {
    let (monitor, _) = monitor_by_index(&app, monitor_index)?;
    require_secondary(&monitor)?;
    let window = existing_window(&app)?;
    let size = match (width, height) {
        (Some(width), Some(height)) => Some([width, height]),
        (None, None) => None,
        _ => {
            return Err(CommandError::new(
                "invalid-arguments",
                "width/height 必须同时给出或同时省略",
            ))
        }
    };
    let offset = [offset_x.unwrap_or(0), offset_y.unwrap_or(0)];
    println!(
        "[overlay] place command monitor={monitor_index} offset=({}, {}) size={size:?}",
        offset[0], offset[1]
    );
    overlay::place_physical(&window, &monitor, offset, size)
}

/// 按主显示器缩放的 DIP 定位（相对目标显示器左上角）。
#[tauri::command]
fn host_place_overlay_dip(
    app: AppHandle,
    monitor_index: usize,
    x_dip: i32,
    y_dip: i32,
    width_dip: i32,
    height_dip: i32,
) -> Result<PlacementSummary, CommandError> {
    let (monitor, primary_scale) = monitor_by_index(&app, monitor_index)?;
    require_secondary(&monitor)?;
    let window = existing_window(&app)?;
    println!(
        "[overlay] place_dip command monitor={monitor_index} rect_dip=({x_dip}, {y_dip}) {width_dip}x{height_dip} primary_scale={primary_scale}"
    );
    overlay::place_dip(
        &window,
        &monitor,
        primary_scale,
        [x_dip, y_dip, width_dip, height_dip],
    )
}

/// 显示浮层。
#[tauri::command]
fn host_show_overlay(app: AppHandle) -> Result<PlacementSummary, CommandError> {
    let window = existing_window(&app)?;
    overlay::show(&window)?;
    println!("[overlay] show command label={}", window.label());
    overlay::summarize_current(&window)
}

/// 隐藏浮层。
#[tauri::command]
fn host_hide_overlay(app: AppHandle) -> Result<PlacementSummary, CommandError> {
    let window = existing_window(&app)?;
    overlay::hide(&window)?;
    println!("[overlay] hide command label={}", window.label());
    overlay::summarize_current(&window)
}

/// 销毁浮层。
#[tauri::command]
fn host_destroy_overlay(app: AppHandle) -> Result<bool, CommandError> {
    match app.get_webview_window(OVERLAY_LABEL) {
        Some(window) => {
            let label = window.label().to_string();
            overlay::close(&window)?;
            println!("[overlay] destroy command label={label}");
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 页面 load 后上报 ready：宿主回 init，且 init 只发一次。
#[tauri::command]
fn prototype_ready(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<Handshake>>,
) -> Result<InitAck, CommandError> {
    require_overlay_window(&window)?;
    let ready_count = state.mark_ready();
    println!(
        "[handshake] ready window={} count={ready_count}",
        window.label()
    );
    if state.claim_init() {
        let payload = InitPayload {
            protocol: PROTOCOL,
            role: OVERLAY_ROLE,
            generation: PROTOTYPE_GENERATION,
            overlay_label: OVERLAY_LABEL,
            pattern: PatternSpec {
                cell_css_px: 64.0,
                margin_css_px: 24.0,
                accent: "#ff3b30",
            },
        };
        app.emit_to(
            EventTarget::webview_window(OVERLAY_LABEL),
            EVENT_PROTOTYPE_INIT,
            payload,
        )
        .map_err(|error| {
            CommandError::new(
                "init-emit-failed",
                format!("发送 {EVENT_PROTOTYPE_INIT} 失败: {error}"),
            )
        })?;
        println!(
            "[handshake] init sent once window={} event={EVENT_PROTOTYPE_INIT} protocol={PROTOCOL} generation={PROTOTYPE_GENERATION}",
            window.label()
        );
        Ok(InitAck {
            accepted: true,
            init_sent_now: true,
            init_already_sent: false,
            generation: PROTOTYPE_GENERATION,
        })
    } else {
        println!(
            "[handshake] duplicate ready window={} count={ready_count}; init already sent, not repeating",
            window.label()
        );
        Ok(InitAck {
            accepted: true,
            init_sent_now: false,
            init_already_sent: true,
            generation: PROTOTYPE_GENERATION,
        })
    }
}

/// 页面回报 `devicePixelRatio` / Canvas CSS 与像素尺寸（宿主打印并留存）。
#[tauri::command]
fn prototype_report_metrics(
    window: WebviewWindow,
    state: State<'_, Arc<Handshake>>,
    report: MetricsReport,
) -> Result<MetricsAck, CommandError> {
    require_overlay_window(&window)?;
    println!(
        "[metrics] window={} dpr={} canvas_css={}x{} canvas_px={}x{} inner={}x{} screen=({}, {}) paint_count={} user_agent=\"{}\"",
        window.label(),
        report.device_pixel_ratio,
        report.canvas_css_width,
        report.canvas_css_height,
        report.canvas_pixel_width,
        report.canvas_pixel_height,
        report.inner_width,
        report.inner_height,
        report.screen_x,
        report.screen_y,
        report.paint_count,
        report.user_agent,
    );
    if !report.canvas_matches_dpr() {
        println!("[metrics] WARNING canvas 像素尺寸与 devicePixelRatio x CSS 尺寸不一致");
    }
    let report_count = state.record_metrics(report);
    Ok(MetricsAck {
        accepted: true,
        report_count,
    })
}

// ---------------------------------------------------------------------------
// 宿主侧辅助
// ---------------------------------------------------------------------------

fn require_overlay_window(window: &WebviewWindow) -> Result<(), CommandError> {
    if window.label() == OVERLAY_LABEL {
        Ok(())
    } else {
        Err(CommandError::new(
            "window-owner-mismatch",
            format!(
                "命令调用窗口 {} 不是原型浮层 {OVERLAY_LABEL}",
                window.label()
            ),
        ))
    }
}

fn existing_window(app: &AppHandle) -> Result<WebviewWindow, CommandError> {
    app.get_webview_window(OVERLAY_LABEL).ok_or_else(|| {
        CommandError::new(
            "window-not-created",
            format!("浮层窗口 {OVERLAY_LABEL} 尚未创建"),
        )
    })
}

fn require_secondary(monitor: &MonitorSnapshot) -> Result<(), CommandError> {
    // 测试专用开关（默认关闭）：单屏自动化/性能对照允许主屏，其余行为不变。
    if monitor.is_primary && !ALLOW_PRIMARY.load(Ordering::Relaxed) {
        Err(CommandError::new(
            "secondary-monitor-required",
            format!(
                "monitor {} 是主显示器；R0 原型拒绝在主屏创建/显示窗口",
                monitor.index
            ),
        ))
    } else {
        Ok(())
    }
}

fn monitor_by_index(app: &AppHandle, index: usize) -> Result<(MonitorSnapshot, f64), CommandError> {
    let (monitors, primary_scale) = collect_monitors(app)?;
    let monitor = monitors
        .into_iter()
        .find(|monitor| monitor.index == index)
        .ok_or_else(|| {
            CommandError::new("monitor-not-found", format!("monitor index {index} 不存在"))
        })?;
    Ok((monitor, primary_scale))
}

/// 枚举显示器并识别主屏；无法识别主显示器时直接失败（避免误把主屏当副屏）。
fn collect_monitors(app: &AppHandle) -> Result<(Vec<MonitorSnapshot>, f64), CommandError> {
    let monitors = app.available_monitors().map_err(|error| {
        CommandError::new(
            "monitor-enumeration-failed",
            format!("枚举显示器失败: {error}"),
        )
    })?;
    let primary = app.primary_monitor().map_err(|error| {
        CommandError::new(
            "monitor-enumeration-failed",
            format!("读取主显示器失败: {error}"),
        )
    })?;
    let primary = primary.ok_or_else(|| {
        CommandError::new(
            "primary-monitor-unknown",
            "无法识别主显示器；原型拒绝创建可见窗口".to_string(),
        )
    })?;
    let primary_signature = (
        primary.name().cloned(),
        primary.position().x,
        primary.position().y,
        primary.size().width,
        primary.size().height,
    );
    let snapshots: Vec<MonitorSnapshot> = monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let is_primary = monitor.name().cloned() == primary_signature.0
                && monitor.position().x == primary_signature.1
                && monitor.position().y == primary_signature.2
                && monitor.size().width == primary_signature.3
                && monitor.size().height == primary_signature.4;
            monitors::from_tauri(monitor, index, is_primary)
        })
        .collect();
    let primary_scale = snapshots
        .iter()
        .find(|monitor| monitor.is_primary)
        .map_or(1.0, |monitor| monitor.scale_factor);
    Ok((snapshots, primary_scale))
}

// ---------------------------------------------------------------------------
// 启动流程（setup 钩子）与自检驱动
// ---------------------------------------------------------------------------

/// setup 阶段：列显示器 → 选副屏 → 建浮层 → 定位（含 DIP 命令演练）→ 显示。
///
/// 任何失败都发生在“可见窗口”之前或立即清理，不会把窗口留在主屏。
fn start_prototype(
    app: &AppHandle,
    options: &cli::Options,
    allow_primary: bool,
) -> Result<StartupReport, CommandError> {
    let mode = if options.self_test {
        "self-test"
    } else {
        "manual"
    };
    println!(
        "[r0-window] mode={mode} hold_ms={} protocol={PROTOCOL} allow_primary={allow_primary}",
        options.hold_ms
    );

    let (monitors, primary_scale) = collect_monitors(app)?;
    println!("[r0-window] monitors={}", monitors.len());
    for monitor in &monitors {
        println!("[monitors] {}", monitor.describe());
    }
    let target_index = monitors::select_target(&monitors, options.monitor_index, allow_primary)
        .map_err(|message| CommandError::new("secondary-monitor-required", message))?;
    let target = monitors
        .get(target_index)
        .cloned()
        .ok_or_else(|| CommandError::new("monitor-not-found", "目标显示器在枚举中消失"))?;
    println!(
        "[monitors] target_index={target_index} name={} primary={} scale={:.2} origin_physical=({}, {}) size_physical={}x{} negative_x={} negative_y={}",
        target.name.as_deref().unwrap_or("<unnamed>"),
        target.is_primary,
        target.scale_factor,
        target.position[0],
        target.position[1],
        target.size[0],
        target.size[1],
        target.position[0] < 0,
        target.position[1] < 0,
    );

    let window = overlay::ensure_window(app)?;
    println!(
        "[overlay] created label={OVERLAY_LABEL} role={OVERLAY_ROLE} title=\"Highlighter R0-03 capture overlay prototype\" transparent=true decorations=false skip_taskbar=true always_on_top=true visible=false"
    );

    // 命令面演练：DIP 定位（按主显示器缩放），证明该命令可用且宿主侧日志可核对。
    let dip_probe = overlay::place_dip(&window, &target, primary_scale, [80, 80, 640, 480])?;
    println!(
        "[overlay] dip_probe scale_source=primary primary_scale={primary_scale:.2} rect_dip=(80, 80) 640x480 -> requested_position=({}, {}) requested_size={}x{}",
        dip_probe.requested_position[0],
        dip_probe.requested_position[1],
        dip_probe.requested_size[0],
        dip_probe.requested_size[1],
    );

    // 最终位置：铺满目标副屏（物理像素，副屏可能在负坐标）。
    let placement = overlay::place_physical(&window, &target, [0, 0], None)?;
    println!(
        "[overlay] place_physical monitor_index={target_index} requested_position=({}, {}) requested_size={}x{}",
        placement.requested_position[0],
        placement.requested_position[1],
        placement.requested_size[0],
        placement.requested_size[1],
    );

    overlay::show(&window)?;
    let placement = overlay::summarize(
        &window,
        placement.requested_position,
        placement.requested_size,
    )?;
    println!(
        "[overlay] shown actual_position=({}, {}) actual_inner_size={}x{} actual_outer_size={}x{} scale_factor={} visible={}",
        placement.actual_position[0],
        placement.actual_position[1],
        placement.actual_inner_size[0],
        placement.actual_inner_size[1],
        placement.actual_outer_size[0],
        placement.actual_outer_size[1],
        placement.scale_factor,
        placement.visible,
    );

    Ok(StartupReport {
        monitors,
        target_index,
        target,
        primary_scale,
        placement,
    })
}

/// 自检线程：等待页面 ready/init/metrics，校验后打印验证行并在 hold 后自动退出。
fn spawn_self_test(
    app: AppHandle,
    report: StartupReport,
    handshake: Arc<Handshake>,
    hold_ms: u64,
    allow_primary: bool,
) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + SELF_TEST_HANDSHAKE_TIMEOUT;
        while !(handshake.ready_count() > 0
            && handshake.init_sent()
            && handshake.metrics().is_some())
        {
            if Instant::now() >= deadline {
                println!(
                    "[FAIL] self-test timeout after {}s: ready_count={} init_sent={} metrics_reports={}",
                    SELF_TEST_HANDSHAKE_TIMEOUT.as_secs(),
                    handshake.ready_count(),
                    handshake.init_sent(),
                    handshake.metrics_count(),
                );
                app.exit(cli::EXIT_SELF_TEST_FAILED);
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        let mut failures: Vec<String> = Vec::new();
        println!(
            "[self-test] ready_received count={} init_sent_once={} metrics_reports={}",
            handshake.ready_count(),
            handshake.init_sent(),
            handshake.metrics_count(),
        );
        if allow_primary && report.target.is_primary {
            println!(
                "[self-test] allow_primary=true target_primary=true source={} (test-only switch; NOT a secondary-monitor verification)",
                cli::ENV_ALLOW_PRIMARY
            );
        }

        let metrics = match handshake.metrics() {
            Some(metrics) => metrics,
            None => {
                println!("[FAIL] self-test metrics vanished after wait");
                app.exit(cli::EXIT_SELF_TEST_FAILED);
                return;
            }
        };
        println!(
            "[self-test] metrics dpr={} canvas_css={}x{} canvas_px={}x{} inner={}x{} screen=({}, {}) paint_count={}",
            metrics.device_pixel_ratio,
            metrics.canvas_css_width,
            metrics.canvas_css_height,
            metrics.canvas_pixel_width,
            metrics.canvas_pixel_height,
            metrics.inner_width,
            metrics.inner_height,
            metrics.screen_x,
            metrics.screen_y,
            metrics.paint_count,
        );
        if !metrics.canvas_matches_dpr() {
            failures.push(format!(
                "canvas 像素尺寸 {}x{} 与 devicePixelRatio {} x CSS {}x{} 不一致",
                metrics.canvas_pixel_width,
                metrics.canvas_pixel_height,
                metrics.device_pixel_ratio,
                metrics.canvas_css_width,
                metrics.canvas_css_height,
            ));
        }
        if metrics.device_pixel_ratio <= 0.0 {
            failures.push("devicePixelRatio 非正".to_string());
        }
        if metrics.paint_count == 0 {
            failures.push("页面尚未绘制首帧（paint_count=0）".to_string());
        }

        // 读回窗口几何，检查“请求 vs 实际”和副屏归属。
        let live = app.get_webview_window(OVERLAY_LABEL).ok_or_else(|| {
            CommandError::new("window-not-created", "自检期间浮层窗口消失".to_string())
        });
        let live = live.and_then(|window| {
            overlay::summarize(
                &window,
                report.placement.requested_position,
                report.placement.requested_size,
            )
        });
        match live {
            Ok(live) => {
                println!(
                    "[self-test] overlay actual_position=({}, {}) requested_position=({}, {}) actual_inner_size={}x{} visible={}",
                    live.actual_position[0],
                    live.actual_position[1],
                    live.requested_position[0],
                    live.requested_position[1],
                    live.actual_inner_size[0],
                    live.actual_inner_size[1],
                    live.visible,
                );
                if !live.visible {
                    failures.push("浮层窗口未显示".to_string());
                }
                for (axis, actual, requested) in [
                    (
                        "x",
                        i64::from(live.actual_position[0]),
                        i64::from(live.requested_position[0]),
                    ),
                    (
                        "y",
                        i64::from(live.actual_position[1]),
                        i64::from(live.requested_position[1]),
                    ),
                ] {
                    if (actual - requested).abs() > POSITION_TOLERANCE_PX {
                        failures.push(format!(
                            "窗口 {axis} 实际 {actual} 与请求 {requested} 相差超过 {POSITION_TOLERANCE_PX}px"
                        ));
                    }
                }
                let inside = live.actual_position[0] >= report.target.position[0]
                    && live.actual_position[1] >= report.target.position[1]
                    && i64::from(live.actual_position[0])
                        <= i64::from(report.target.position[0]) + i64::from(report.target.size[0])
                    && i64::from(live.actual_position[1])
                        <= i64::from(report.target.position[1]) + i64::from(report.target.size[1]);
                println!(
                    "[self-test] overlay inside_target_monitor={inside} target_index={} target_origin=({}, {}) target_size={}x{}",
                    report.target_index,
                    report.target.position[0],
                    report.target.position[1],
                    report.target.size[0],
                    report.target.size[1],
                );
                if !inside {
                    failures.push("浮层窗口实际位置不在目标副屏内".to_string());
                }
                if report.target.is_primary && !allow_primary {
                    failures.push("目标显示器被识别为主屏（原型禁止）".to_string());
                }
            }
            Err(error) => failures.push(format!("读取窗口几何失败: {error}")),
        }

        let exit_code = if failures.is_empty() {
            println!(
                "[PASS] r0-03 self-test: secondary_monitor_index={} target_primary={} allow_primary={} negative_y={} ready/init_once ok dpr={} canvas_dpr_ok={}",
                report.target_index,
                report.target.is_primary,
                allow_primary,
                report.target.position[1] < 0,
                metrics.device_pixel_ratio,
                metrics.canvas_matches_dpr(),
            );
            0
        } else {
            for failure in &failures {
                println!("[FAIL] {failure}");
            }
            cli::EXIT_SELF_TEST_FAILED
        };
        println!(
            "[self-test] result exit_code={exit_code} primary_scale={} monitors={} target_primary={} allow_primary={}",
            report.primary_scale,
            report.monitors.len(),
            report.target.is_primary,
            allow_primary,
        );

        if exit_code == 0 {
            println!("[self-test] hold_ms={hold_ms}; overlay stays on the secondary display for inspection, then exits");
            std::thread::sleep(Duration::from_millis(hold_ms));
            println!("[self-test] closing overlay");
            if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
                if let Err(error) = overlay::close(&window) {
                    println!("[self-test] close failed: {error}");
                }
            }
            std::thread::sleep(Duration::from_millis(200));
            app.exit(0);
        } else {
            // 失败路径交给运行时清理（先 close 可能触发默认 0 退出码，掩盖失败）。
            app.exit(exit_code);
        }
    });
}

fn setup(
    app: &mut tauri::App,
    options: cli::Options,
    allow_primary: bool,
    handshake: Arc<Handshake>,
) {
    let app_handle = app.handle().clone();
    match start_prototype(&app_handle, &options, allow_primary) {
        Ok(report) => {
            if options.self_test {
                println!(
                    "[self-test] waiting for page ready/init/metrics (timeout {}s)",
                    SELF_TEST_HANDSHAKE_TIMEOUT.as_secs()
                );
                spawn_self_test(
                    app_handle,
                    report,
                    handshake,
                    options.hold_ms,
                    allow_primary,
                );
            } else {
                println!(
                    "[r0-window] manual mode: overlay is visible on the {} display (allow_primary={allow_primary}); close the window to exit",
                    if report.target.is_primary {
                        "primary"
                    } else {
                        "secondary"
                    }
                );
            }
        }
        Err(error) => {
            println!(
                "[FAIL] startup code={} message={}",
                error.code, error.message
            );
            eprintln!(
                "[r0-window] startup failed: {} ({})",
                error.code, error.message
            );
            std::process::exit(cli::EXIT_NO_SECONDARY);
        }
    }
}

fn main() {
    let options = match cli::parse(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("[r0-window] 参数错误: {message}");
            eprintln!("{}", cli::USAGE);
            std::process::exit(cli::EXIT_NO_SECONDARY);
        }
    };
    if options.help {
        println!("{}", cli::USAGE);
        return;
    }

    // 测试专用开关（默认关闭）：HIGHLIGHTER_R0_ALLOW_PRIMARY=1 时允许主屏作为目标。
    // 生产包不应依赖；未设置时以下所有路径与改动前完全一致。
    let allow_primary = cli::allow_primary_from_env();
    ALLOW_PRIMARY.store(allow_primary, Ordering::Relaxed);

    let handshake = Handshake::new();
    let handshake_for_setup = Arc::clone(&handshake);
    let setup_options = options.clone();
    let app = tauri::Builder::default()
        .manage(handshake)
        .invoke_handler(tauri::generate_handler![
            host_list_monitors,
            host_create_overlay,
            host_place_overlay,
            host_place_overlay_dip,
            host_show_overlay,
            host_hide_overlay,
            host_destroy_overlay,
            prototype_ready,
            prototype_report_metrics,
        ])
        .setup(move |app| {
            setup(app, setup_options, allow_primary, handshake_for_setup);
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("[r0-window] 构建 Tauri 应用失败: {error}");
            std::process::exit(cli::EXIT_NO_SECONDARY);
        }
    };
    let exit_code = app.run_return(|_app, _event| {});
    println!("[r0-window] event loop exited code={exit_code}");
    std::process::exit(exit_code);
}
