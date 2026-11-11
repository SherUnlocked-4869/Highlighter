//! 显示器枚举与窗口定位（可见窗口只允许出现在非主显示器上）。

use serde::Serialize;
use tauri::{AppHandle, PhysicalPosition, PhysicalSize, WebviewWindow};

/// 显示器快照（物理像素坐标，per-monitor DPI aware 进程读数）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub index: usize,
    pub name: Option<String>,
    pub position: [i32; 2],
    pub size: [u32; 2],
    pub scale_factor: f64,
    pub is_primary: bool,
}

/// 枚举全部显示器并标记主显示器。
pub fn collect(app: &AppHandle) -> Result<Vec<MonitorSnapshot>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("枚举显示器失败: {error}"))?;
    let primary = app
        .primary_monitor()
        .map_err(|error| format!("读取主显示器失败: {error}"))?;
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let is_primary = primary
                .as_ref()
                .map(|candidate| {
                    candidate.position() == monitor.position() && candidate.size() == monitor.size()
                })
                .unwrap_or(false);
            MonitorSnapshot {
                index,
                name: monitor.name().cloned(),
                position: [monitor.position().x, monitor.position().y],
                size: [monitor.size().width, monitor.size().height],
                scale_factor: monitor.scale_factor(),
                is_primary,
            }
        })
        .collect())
}

/// 第一个非主显示器（R0-06 可见窗口只放这里）。
pub fn secondary(monitors: &[MonitorSnapshot]) -> Option<&MonitorSnapshot> {
    monitors.iter().find(|monitor| !monitor.is_primary)
}

/// 把窗口放到“显示器原点 + 偏移”的物理像素位置，并设置物理尺寸。
pub fn place(
    window: &WebviewWindow,
    monitor: &MonitorSnapshot,
    offset: [i32; 2],
    size: [u32; 2],
) -> Result<(), String> {
    window
        .set_position(PhysicalPosition::new(
            monitor.position[0] + offset[0],
            monitor.position[1] + offset[1],
        ))
        .map_err(|error| format!("设置窗口位置失败: {error}"))?;
    window
        .set_size(PhysicalSize::new(size[0], size[1]))
        .map_err(|error| format!("设置窗口尺寸失败: {error}"))?;
    Ok(())
}

/// 读回窗口几何/可见性（“请求 vs 实际”证据）。
pub fn geometry(window: &WebviewWindow) -> serde_json::Value {
    let outer = window.outer_position().ok();
    let inner = window.inner_size().ok();
    serde_json::json!({
        "windowLabel": window.label(),
        "outerPosition": outer.map(|position| [position.x, position.y]),
        "innerSize": inner.map(|size| [size.width, size.height]),
        "scaleFactor": window.scale_factor().ok(),
        "visible": window.is_visible().ok(),
    })
}
