//! 显示器枚举与放置计算（纯算术部分可单测；`from_tauri` 只做类型搬运）。
//!
//! 坐标约定：
//! - `position` / `size` 是**物理像素**（与 Tauri `Monitor::position/size` 一致）；
//! - `position_dip` / `size_dip` 是按**该显示器自身缩放因子**折算的 DIP，仅用于日志与
//!   人工核对；Windows 的多显示器 DIP 坐标系在混合 DPI 下不是简单逐屏缩放，R3 真机
//!   对照前不得把这里的 DIP 值当作跨屏绝对坐标（见 `windows-platform` 的候选实现说明）。
//!
//! 放置规则（R0 原型）：
//! - 物理放置 = 显示器原点 + 偏移，尺寸默认等于显示器大小；
//! - DIP 放置 = 相对目标显示器左上角的 DIP 矩形，按**主显示器缩放**换算成物理像素，
//!   再叠加目标显示器原点（任务 R0-03 要求“按主显示器缩放设置位置的命令”）；
//! - 副屏可能在负坐标（本机副屏在主屏上方，y 为负），所有加法都做溢出/越界检查。

use highlighter_windows_platform::{physical_to_dip, DipRect, ScaleFactor};
use serde::Serialize;

/// 矩形快照（物理像素，左上角 + 尺寸）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RectSnapshot {
    /// 左上角 x（物理像素）。
    pub x: i32,
    /// 左上角 y（物理像素）。
    pub y: i32,
    /// 宽（物理像素）。
    pub width: u32,
    /// 高（物理像素）。
    pub height: u32,
}

/// 一块显示器的只读快照：物理像素 + DIP + 缩放因子。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    /// 枚举序号（0 起，与 `available_monitors()` 顺序一致）。
    pub index: usize,
    /// 显示器名称；Windows 上可能是 `\\.\DISPLAY1` 之类。
    pub name: Option<String>,
    /// 是否主显示器。
    pub is_primary: bool,
    /// 缩放因子（1.5 = 150%）。
    pub scale_factor: f64,
    /// 等价 DPI（144 = 150%）。
    pub dpi: f64,
    /// 物理像素左上角（可负）。
    pub position: [i32; 2],
    /// 物理像素尺寸。
    pub size: [u32; 2],
    /// 按本屏缩放折算的 DIP 左上角（仅日志/核对）。
    pub position_dip: [i32; 2],
    /// 按本屏缩放折算的 DIP 尺寸（仅日志/核对）。
    pub size_dip: [i32; 2],
    /// 工作区（物理像素）。
    pub work_area: RectSnapshot,
}

impl MonitorSnapshot {
    /// 打印用的一行描述（自检报告与人工日志共用）。
    pub fn describe(&self) -> String {
        format!(
            "monitor[{index}] name={name} primary={primary} scale={scale:.2} dpi={dpi:.1} \
             position_physical=({px}, {py}) size_physical={sw}x{sh} \
             position_dip=({dx}, {dy}) size_dip={dw}x{dh} work_area_physical=({wx}, {wy}) {ww}x{wh}",
            index = self.index,
            name = self.name.as_deref().unwrap_or("<unnamed>"),
            primary = self.is_primary,
            scale = self.scale_factor,
            dpi = self.dpi,
            px = self.position[0],
            py = self.position[1],
            sw = self.size[0],
            sh = self.size[1],
            dx = self.position_dip[0],
            dy = self.position_dip[1],
            dw = self.size_dip[0],
            dh = self.size_dip[1],
            wx = self.work_area.x,
            wy = self.work_area.y,
            ww = self.work_area.width,
            wh = self.work_area.height,
        )
    }
}

/// 从 Tauri 的 `Monitor` 生成快照。
pub fn from_tauri(monitor: &tauri::Monitor, index: usize, is_primary: bool) -> MonitorSnapshot {
    let scale = scale_of(monitor.scale_factor());
    let position = monitor.position();
    let size = monitor.size();
    let work_area = monitor.work_area();
    MonitorSnapshot {
        index,
        name: monitor.name().cloned(),
        is_primary,
        scale_factor: monitor.scale_factor(),
        dpi: scale.dpi(),
        position: [position.x, position.y],
        size: [size.width, size.height],
        position_dip: [
            physical_to_dip(position.x, scale),
            physical_to_dip(position.y, scale),
        ],
        size_dip: [
            physical_to_dip(width_as_i32(size.width), scale),
            physical_to_dip(width_as_i32(size.height), scale),
        ],
        work_area: RectSnapshot {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        },
    }
}

/// 选择可见浮层的目标显示器：默认第一块非主屏；`requested` 指向主屏时拒绝。
///
/// 工作区约定：自动化/真机测试窗口只允许出现在副屏；未检测到副屏时返回错误，
/// 调用方必须直接失败退出，不得退回主屏。
pub fn select_secondary(
    monitors: &[MonitorSnapshot],
    requested: Option<usize>,
) -> Result<usize, String> {
    if let Some(index) = requested {
        let monitor = monitors.get(index).ok_or_else(|| {
            format!(
                "monitor-not-found: --monitor {index} 不存在（共 {} 块显示器）",
                monitors.len()
            )
        })?;
        if monitor.is_primary {
            return Err(format!(
                "secondary-monitor-required: --monitor {index} 是主显示器；原型拒绝在主屏创建可见窗口"
            ));
        }
        return Ok(index);
    }
    monitors
        .iter()
        .position(|monitor| !monitor.is_primary)
        .ok_or_else(|| {
            "no-secondary-monitor: 未检测到副屏；原型拒绝在主屏创建可见窗口（不创建、不显示）"
                .to_string()
        })
}

/// 物理像素放置：窗口左上角 = 显示器原点 + 偏移；`size=None` 时铺满整块显示器。
///
/// 返回 `(position, size)`；坐标为负是合法的（副屏在主屏左侧/上方时）。
pub fn physical_placement(
    monitor: &MonitorSnapshot,
    offset: [i32; 2],
    size: Option<[u32; 2]>,
) -> Result<([i32; 2], [u32; 2]), String> {
    let x = monitor.position[0].checked_add(offset[0]).ok_or_else(|| {
        format!(
            "placement-overflow: x {} + {} 超出 i32",
            monitor.position[0], offset[0]
        )
    })?;
    let y = monitor.position[1].checked_add(offset[1]).ok_or_else(|| {
        format!(
            "placement-overflow: y {} + {} 超出 i32",
            monitor.position[1], offset[1]
        )
    })?;
    let (width, height) = match size {
        Some([width, height]) => (width, height),
        None => (monitor.size[0], monitor.size[1]),
    };
    if width == 0 || height == 0 {
        return Err(format!(
            "placement-invalid: 窗口尺寸不能为 0（{width}x{height}）"
        ));
    }
    let inside = i64::from(x) >= i64::from(monitor.position[0])
        && i64::from(y) >= i64::from(monitor.position[1])
        && i64::from(x) + i64::from(width)
            <= i64::from(monitor.position[0]) + i64::from(monitor.size[0])
        && i64::from(y) + i64::from(height)
            <= i64::from(monitor.position[1]) + i64::from(monitor.size[1]);
    if !inside {
        return Err(format!(
            "placement-outside-monitor: 窗口 ({x}, {y}) {width}x{height} 超出显示器 {} 的物理 bounds",
            monitor.index
        ));
    }
    Ok(([x, y], [width, height]))
}

/// DIP 放置：相对目标显示器左上角的 DIP 矩形，按 `primary_scale` 换算为物理像素。
///
/// 这是任务要求的“按主显示器缩放设置位置”原型命令；R1/R3 应按每屏真实缩放和
/// Win32 的 DIP 坐标系重做（见文档“已知限制”）。
pub fn dip_placement(
    monitor: &MonitorSnapshot,
    primary_scale: f64,
    rect: [i32; 4],
) -> Result<([i32; 2], [u32; 2]), String> {
    let scale = ScaleFactor::new(primary_scale)
        .map_err(|error| format!("invalid-scale: 主显示器缩放 {primary_scale} 非法: {error}"))?;
    let dip_rect = DipRect::new(rect[0], rect[1], rect[2], rect[3])
        .map_err(|error| format!("dip-rect-invalid: DIP 矩形 {rect:?} 非法: {error}"))?;
    let physical = dip_rect.to_physical(scale);

    let x = monitor.position[0]
        .checked_add(physical.x)
        .ok_or_else(|| "placement-overflow: DIP 换算后的 x 超出 i32".to_string())?;
    let y = monitor.position[1]
        .checked_add(physical.y)
        .ok_or_else(|| "placement-overflow: DIP 换算后的 y 超出 i32".to_string())?;
    if physical.width <= 0 || physical.height <= 0 {
        return Err(format!(
            "dip-placement-invalid: DIP 换算后的尺寸非正（{}x{}）",
            physical.width, physical.height
        ));
    }
    let width = u32::try_from(physical.width)
        .map_err(|_| format!("dip-placement-overflow: 宽度 {} 超出 u32", physical.width))?;
    let height = u32::try_from(physical.height)
        .map_err(|_| format!("dip-placement-overflow: 高度 {} 超出 u32", physical.height))?;

    let inside = physical.x >= 0
        && physical.y >= 0
        && i64::from(physical.x) + i64::from(width) <= i64::from(monitor.size[0])
        && i64::from(physical.y) + i64::from(height) <= i64::from(monitor.size[1]);
    if !inside {
        return Err(format!(
            "dip-placement-outside-monitor: DIP {rect:?} 换算后相对目标显示器越界（监控器 {} {}x{}）",
            monitor.index, monitor.size[0], monitor.size[1]
        ));
    }
    Ok(([x, y], [width, height]))
}

fn scale_of(scale_factor: f64) -> ScaleFactor {
    ScaleFactor::new(scale_factor)
        .unwrap_or_else(|_| ScaleFactor::new(1.0).expect("1.0 is always a valid scale factor"))
}

fn width_as_i32(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(index: usize, position: [i32; 2], size: [u32; 2], primary: bool) -> MonitorSnapshot {
        MonitorSnapshot {
            index,
            name: Some(format!("\\\\.\\DISPLAY{index}")),
            is_primary: primary,
            scale_factor: 1.5,
            dpi: 144.0,
            position,
            size,
            position_dip: [position[0] / 3 * 2, position[1] / 3 * 2],
            size_dip: [
                physical_to_dip(width_as_i32(size[0]), scale_of(1.5)),
                physical_to_dip(width_as_i32(size[1]), scale_of(1.5)),
            ],
            work_area: RectSnapshot {
                x: position[0],
                y: position[1],
                width: size[0],
                height: size[1],
            },
        }
    }

    #[test]
    fn secondary_selection_prefers_non_primary_and_refuses_primary() {
        let monitors = vec![
            monitor(0, [0, 0], [2_560, 1_440], true),
            monitor(1, [0, -1_440], [2_560, 1_440], false),
        ];
        assert_eq!(select_secondary(&monitors, None), Ok(1));
        assert_eq!(select_secondary(&monitors, Some(1)), Ok(1));
        let error = select_secondary(&monitors, Some(0)).expect_err("primary rejected");
        assert!(error.starts_with("secondary-monitor-required"), "{error}");
        let error = select_secondary(&monitors, Some(2)).expect_err("missing monitor");
        assert!(error.starts_with("monitor-not-found"), "{error}");
    }

    #[test]
    fn no_secondary_display_is_an_error_not_a_primary_fallback() {
        let monitors = vec![monitor(0, [0, 0], [2_560, 1_440], true)];
        let error = select_secondary(&monitors, None).expect_err("no secondary");
        assert!(error.starts_with("no-secondary-monitor"), "{error}");
        assert!(select_secondary(&[], None).is_err());
    }

    #[test]
    fn physical_placement_keeps_negative_secondary_coordinates() {
        let secondary = monitor(1, [0, -1_440], [2_560, 1_440], false);
        let (position, size) = physical_placement(&secondary, [0, 0], None).expect("full monitor");
        assert_eq!(position, [0, -1_440]);
        assert_eq!(size, [2_560, 1_440]);

        let (position, size) =
            physical_placement(&secondary, [120, 80], Some([640, 480])).expect("offset");
        assert_eq!(position, [120, -1_360]);
        assert_eq!(size, [640, 480]);

        // 左上角在负坐标、且窗口跨过主屏原点：仍然合法（仍在副屏 bounds 内）。
        let left = monitor(1, [-2_560, 0], [2_560, 1_440], false);
        let (position, _) = physical_placement(&left, [0, 0], None).expect("negative x");
        assert_eq!(position, [-2_560, 0]);
    }

    #[test]
    fn physical_placement_rejects_outside_monitor_and_zero_size() {
        let secondary = monitor(1, [0, -1_440], [2_560, 1_440], false);
        let error = physical_placement(&secondary, [2_500, 0], Some([100, 100]))
            .expect_err("outside monitor");
        assert!(error.starts_with("placement-outside-monitor"), "{error}");
        assert!(physical_placement(&secondary, [0, 0], Some([0, 100])).is_err());
    }

    #[test]
    fn dip_placement_uses_primary_scale_then_offsets_monitor_origin() {
        // 本机两块屏都是 150%：DIP (80,80) 640x480 -> 物理 (120,120) 960x720。
        let secondary = monitor(1, [-2_560, 0], [2_560, 1_440], false);
        let (position, size) =
            dip_placement(&secondary, 1.5, [80, 80, 640, 480]).expect("dip placement");
        assert_eq!(position, [-2_560 + 120, 120]);
        assert_eq!(size, [960, 720]);

        // 负 Y 副屏：原点叠加后仍是负坐标。
        let above = monitor(1, [0, -1_440], [2_560, 1_440], false);
        let (position, _) = dip_placement(&above, 1.5, [0, 0, 100, 100]).expect("negative y");
        assert_eq!(position, [0, -1_440]);
    }

    #[test]
    fn dip_placement_rejects_out_of_bounds_and_bad_scale() {
        let secondary = monitor(1, [0, -1_440], [2_560, 1_440], false);
        let error = dip_placement(&secondary, 1.5, [1_700, 0, 100, 100]).expect_err("outside");
        assert!(
            error.starts_with("dip-placement-outside-monitor"),
            "{error}"
        );
        assert!(dip_placement(&secondary, 1.5, [0, 0, -10, 100]).is_err());
        assert!(dip_placement(&secondary, 0.0, [0, 0, 10, 10]).is_err());
    }

    #[test]
    fn mixed_scale_dip_placement_uses_requested_scale() {
        let secondary = monitor(1, [0, -1_440], [2_560, 1_440], false);
        let (position, size) =
            dip_placement(&secondary, 2.0, [10, 10, 100, 100]).expect("200% scale");
        assert_eq!(position, [20, -1_420]);
        assert_eq!(size, [200, 200]);
    }
}
