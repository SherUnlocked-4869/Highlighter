//! 显示器枚举与窗口物理像素放置。
//!
//! 工作区规则（AGENTS.md）：可见测试窗口只放副屏；没有副屏时直接失败退出，
//! 不能退回主屏。本机基线：主屏 `\\.\DISPLAY1` 3840x2160@150%，副屏
//! `\\.\DISPLAY2` 原点 (3840,-170) 1440x2560@125%（见 r0-baseline §1.3 的更正）。

use serde::Serialize;
use tauri::{AppHandle, Monitor};

/// 显示器快照（物理像素）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: Option<String>,
    pub is_primary: bool,
    pub scale_factor: f64,
    pub position: [i32; 2],
    pub size: [u32; 2],
}

impl MonitorInfo {
    pub fn from_tauri(monitor: &Monitor, index: usize, is_primary: bool) -> Self {
        let position = monitor.position();
        let size = monitor.size();
        Self {
            index,
            name: monitor.name().cloned(),
            is_primary,
            scale_factor: monitor.scale_factor(),
            position: [position.x, position.y],
            size: [size.width, size.height],
        }
    }
}

/// 枚举全部显示器。
pub fn list(app: &AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let primary = app
        .primary_monitor()
        .map_err(|error| format!("primary_monitor: {error}"))?;
    let primary_name = primary.as_ref().and_then(|monitor| monitor.name().cloned());
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("available_monitors: {error}"))?;
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let is_primary = match (&primary_name, monitor.name()) {
                (Some(expected), Some(name)) => expected == name,
                _ => index == 0,
            };
            MonitorInfo::from_tauri(monitor, index, is_primary)
        })
        .collect())
}

/// 选择可见窗口的目标显示器：优先名称含 `DISPLAY2` 的非主屏，其次第一块非主屏。
///
/// 找不到非主屏时返回错误——原型拒绝在主屏创建可见窗口。
pub fn select_secondary(app: &AppHandle) -> Result<(MonitorInfo, Monitor), String> {
    let infos = list(app)?;
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("available_monitors: {error}"))?;
    let named = infos.iter().find(|info| {
        !info.is_primary
            && info
                .name
                .as_deref()
                .map(|name| name.contains("DISPLAY2"))
                .unwrap_or(false)
    });
    let chosen = named.or_else(|| infos.iter().find(|info| !info.is_primary));
    let info = chosen
        .ok_or_else(|| {
            "no-secondary-monitor: 未检测到副屏；原型拒绝在主屏创建可见窗口（不创建、不显示）"
                .to_string()
        })?
        .clone();
    let monitor = monitors
        .into_iter()
        .nth(info.index)
        .ok_or_else(|| format!("monitor-not-found: index {}", info.index))?;
    Ok((info, monitor))
}

/// 物理像素放置校验：窗口必须完整落在目标显示器内，坐标可为负。
pub fn physical_placement(
    monitor: &MonitorInfo,
    offset: [i32; 2],
    size: [u32; 2],
) -> Result<([i32; 2], [u32; 2]), String> {
    let x = monitor.position[0]
        .checked_add(offset[0])
        .ok_or_else(|| "placement-overflow: x 溢出 i32".to_string())?;
    let y = monitor.position[1]
        .checked_add(offset[1])
        .ok_or_else(|| "placement-overflow: y 溢出 i32".to_string())?;
    if size[0] == 0 || size[1] == 0 {
        return Err(format!("placement-invalid: 尺寸不能为 0 ({:?})", size));
    }
    let inside = i64::from(x) >= i64::from(monitor.position[0])
        && i64::from(y) >= i64::from(monitor.position[1])
        && i64::from(x) + i64::from(size[0])
            <= i64::from(monitor.position[0]) + i64::from(monitor.size[0])
        && i64::from(y) + i64::from(size[1])
            <= i64::from(monitor.position[1]) + i64::from(monitor.size[1]);
    if !inside {
        return Err(format!(
            "placement-outside-monitor: ({x},{y}) {}x{} 超出显示器 {} 物理 bounds {:?} {:?}",
            size[0], size[1], monitor.index, monitor.position, monitor.size
        ));
    }
    Ok(([x, y], size))
}
