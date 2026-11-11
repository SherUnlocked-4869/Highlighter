//! 浮层窗口的创建/定位/显隐/销毁封装。
//!
//! 同一组函数被两处调用：Tauri 命令面（页面/未来 bridge 可调用）与 `--self-test`
//! 启动流程。窗口创建只允许在 setup 钩子或 async 命令里做：Tauri 文档明确 Windows 上
//! 在同步命令/事件处理器里同步建窗会因 WebView2 死锁（见 `WebviewWindowBuilder::new`
//! 的 Known issues），所以 `host_create_overlay` 命令声明为 async。

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::monitors::{dip_placement, physical_placement, MonitorSnapshot};
use crate::{CommandError, PlacementSummary, OVERLAY_LABEL};

/// WebView2 用户数据目录：放进已 gitignore 的 `rust-app/target/`，避免污染
/// `%LOCALAPPDATA%`，也让自检可以重复运行而不影响真实用户数据根。
fn webview_data_directory() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("target")
        .join("r0-window-webview2-data")
}

/// 创建浮层（幂等：已存在则直接返回），初始隐藏，由调用方定位后再 show。
pub fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, CommandError> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        return Ok(window);
    }
    WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
        .title("Highlighter R0-03 capture overlay prototype")
        .inner_size(640.0, 480.0)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .always_on_top(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .focused(false)
        // Windows: WS_EX_NOREDIRECTIONBITMAP，Tauri 文档建议用于避免透明窗口创建时的白闪。
        // 该选项在 R0 只是待真机验收的实验项，见 r0-window-prototype.md。
        .no_redirection_bitmap(true)
        .data_directory(webview_data_directory())
        .build()
        .map_err(|error| {
            CommandError::new("window-create-failed", format!("创建浮层窗口失败: {error}"))
        })
}

/// 按物理像素放置：左上角 = 显示器原点 + 偏移；`size=None` 铺满显示器。
pub fn place_physical(
    window: &WebviewWindow,
    monitor: &MonitorSnapshot,
    offset: [i32; 2],
    size: Option<[u32; 2]>,
) -> Result<PlacementSummary, CommandError> {
    let (position, size) = physical_placement(monitor, offset, size)
        .map_err(|message| CommandError::new("placement-invalid", message))?;
    apply_placement(window, position, size)
}

/// 按主显示器缩放做 DIP 放置（任务 R0-03 的“按主显示器缩放设置位置的命令”）。
pub fn place_dip(
    window: &WebviewWindow,
    monitor: &MonitorSnapshot,
    primary_scale: f64,
    rect: [i32; 4],
) -> Result<PlacementSummary, CommandError> {
    let (position, size) = dip_placement(monitor, primary_scale, rect)
        .map_err(|message| CommandError::new("dip-placement-invalid", message))?;
    apply_placement(window, position, size)
}

fn apply_placement(
    window: &WebviewWindow,
    position: [i32; 2],
    size: [u32; 2],
) -> Result<PlacementSummary, CommandError> {
    window
        .set_position(PhysicalPosition::new(position[0], position[1]))
        .map_err(|error| {
            CommandError::new(
                "window-position-failed",
                format!("设置窗口位置失败: {error}"),
            )
        })?;
    window
        .set_size(PhysicalSize::new(size[0], size[1]))
        .map_err(|error| {
            CommandError::new("window-size-failed", format!("设置窗口尺寸失败: {error}"))
        })?;
    summarize(window, position, size)
}

/// 读回实际几何/可见性，作为“请求 vs 实际”的验证证据。
pub fn summarize(
    window: &WebviewWindow,
    requested_position: [i32; 2],
    requested_size: [u32; 2],
) -> Result<PlacementSummary, CommandError> {
    let position = window.outer_position().map_err(|error| {
        CommandError::new("window-read-failed", format!("读取窗口位置失败: {error}"))
    })?;
    let inner = window.inner_size().map_err(|error| {
        CommandError::new("window-read-failed", format!("读取窗口尺寸失败: {error}"))
    })?;
    let outer = window.outer_size().map_err(|error| {
        CommandError::new("window-read-failed", format!("读取窗口外框失败: {error}"))
    })?;
    let scale_factor = window.scale_factor().map_err(|error| {
        CommandError::new("window-read-failed", format!("读取窗口缩放失败: {error}"))
    })?;
    let visible = window.is_visible().map_err(|error| {
        CommandError::new("window-read-failed", format!("读取窗口可见性失败: {error}"))
    })?;
    Ok(PlacementSummary {
        requested_position,
        requested_size,
        actual_position: [position.x, position.y],
        actual_inner_size: [inner.width, inner.height],
        actual_outer_size: [outer.width, outer.height],
        scale_factor,
        visible,
    })
}

/// 读回当前实际位置/尺寸后生成放置摘要（创建/显示/隐藏后的状态回报）。
pub fn summarize_current(window: &WebviewWindow) -> Result<PlacementSummary, CommandError> {
    let position = window.outer_position().map_err(|error| {
        CommandError::new("window-read-failed", format!("读取窗口位置失败: {error}"))
    })?;
    let size = window.inner_size().map_err(|error| {
        CommandError::new("window-read-failed", format!("读取窗口尺寸失败: {error}"))
    })?;
    summarize(window, [position.x, position.y], [size.width, size.height])
}

/// 显示浮层（调用方必须先定位）。
pub fn show(window: &WebviewWindow) -> Result<(), CommandError> {
    window
        .show()
        .map_err(|error| CommandError::new("window-show-failed", format!("显示窗口失败: {error}")))
}

/// 隐藏浮层。
pub fn hide(window: &WebviewWindow) -> Result<(), CommandError> {
    window
        .hide()
        .map_err(|error| CommandError::new("window-hide-failed", format!("隐藏窗口失败: {error}")))
}

/// 销毁浮层（关闭子窗口；最后一个窗口关闭后事件循环自然退出）。
pub fn close(window: &WebviewWindow) -> Result<(), CommandError> {
    window
        .close()
        .map_err(|error| CommandError::new("window-close-failed", format!("关闭窗口失败: {error}")))
}
