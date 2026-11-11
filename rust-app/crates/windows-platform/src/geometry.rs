//! DIP/物理像素点、矩形与显示器几何（R0 候选实现）。
//!
//! 矩形转换按**边**独立舍入（left/top/right/bottom），而不是直接缩放 width/height：
//! 这样负坐标或副屏偏移不会把误差累积进尺寸。`right()`/`bottom()` 用 `i64` 计算，避免
//! `x + width` 在 `i32` 上回绕。
//!
//! R3 真机对照前，本模块只是候选实现；详细规则见 `crate::dpi` 与 crate README。

use std::fmt;

use crate::dpi::{scale_round, ScaleFactor};

/// DIP（设备无关像素）坐标点。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DipPoint {
    /// x（DIP）。
    pub x: i32,
    /// y（DIP）。
    pub y: i32,
}

/// 物理像素坐标点。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PhysicalPoint {
    /// x（物理像素）。
    pub x: i32,
    /// y（物理像素）。
    pub y: i32,
}

impl DipPoint {
    /// 转到物理像素（逐点舍入）。
    #[must_use]
    pub fn to_physical(self, scale: ScaleFactor) -> PhysicalPoint {
        PhysicalPoint {
            x: crate::dpi::dip_to_physical(self.x, scale),
            y: crate::dpi::dip_to_physical(self.y, scale),
        }
    }
}

impl PhysicalPoint {
    /// 转到 DIP（逐点舍入）。
    #[must_use]
    pub fn to_dip(self, scale: ScaleFactor) -> DipPoint {
        DipPoint {
            x: crate::dpi::physical_to_dip(self.x, scale),
            y: crate::dpi::physical_to_dip(self.y, scale),
        }
    }
}

/// 几何校验错误。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryError {
    /// 宽或高为负。
    NegativeSize {
        /// 传入的宽。
        width: i32,
        /// 传入的高。
        height: i32,
    },
    /// 工作区越出显示器 bounds。
    WorkAreaOutsideBounds,
}

impl fmt::Display for GeometryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GeometryError::NegativeSize { width, height } => {
                write!(
                    formatter,
                    "rectangle size must not be negative: {width}x{height}"
                )
            }
            GeometryError::WorkAreaOutsideBounds => {
                formatter.write_str("monitor work area must be inside its bounds")
            }
        }
    }
}

impl std::error::Error for GeometryError {}

/// DIP 矩形（`x,y` 可负；`width,height` ≥ 0）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DipRect {
    /// 左上角 x（DIP）。
    pub x: i32,
    /// 左上角 y（DIP）。
    pub y: i32,
    /// 宽（DIP）。
    pub width: i32,
    /// 高（DIP）。
    pub height: i32,
}

/// 物理像素矩形（Windows RECT 语义，`right`/`bottom` 为开区间）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalRect {
    /// 左上角 x（物理像素）。
    pub x: i32,
    /// 左上角 y（物理像素）。
    pub y: i32,
    /// 宽（物理像素）。
    pub width: i32,
    /// 高（物理像素）。
    pub height: i32,
}

impl DipRect {
    /// 构造并校验宽高非负。
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Result<Self, GeometryError> {
        if width < 0 || height < 0 {
            return Err(GeometryError::NegativeSize { width, height });
        }
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }

    /// 右边界（开区间；`i64` 防溢出）。
    #[must_use]
    pub fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    /// 下边界（开区间；`i64` 防溢出）。
    #[must_use]
    pub fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    /// 是否空矩形（宽或高为 0）。
    #[must_use]
    pub fn is_empty(self) -> bool {
        self.width == 0 || self.height == 0
    }

    /// 转到物理像素：四条边分别舍入后重新计算宽高。
    #[must_use]
    pub fn to_physical(self, scale: ScaleFactor) -> PhysicalRect {
        let factor = scale.scale();
        let left = scale_round(i64::from(self.x), factor);
        let top = scale_round(i64::from(self.y), factor);
        let right = scale_round(self.right(), factor);
        let bottom = scale_round(self.bottom(), factor);
        PhysicalRect {
            x: left,
            y: top,
            width: right.saturating_sub(left),
            height: bottom.saturating_sub(top),
        }
    }
}

impl PhysicalRect {
    /// 构造并校验宽高非负。
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Result<Self, GeometryError> {
        if width < 0 || height < 0 {
            return Err(GeometryError::NegativeSize { width, height });
        }
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }

    /// 右边界（开区间；`i64` 防溢出）。
    #[must_use]
    pub fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    /// 下边界（开区间；`i64` 防溢出）。
    #[must_use]
    pub fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    /// 是否空矩形。
    #[must_use]
    pub fn is_empty(self) -> bool {
        self.width == 0 || self.height == 0
    }

    /// 转到 DIP：四条边分别舍入后重新计算宽高。
    #[must_use]
    pub fn to_dip(self, scale: ScaleFactor) -> DipRect {
        let factor = 1.0 / scale.scale();
        let left = scale_round(i64::from(self.x), factor);
        let top = scale_round(i64::from(self.y), factor);
        let right = scale_round(self.right(), factor);
        let bottom = scale_round(self.bottom(), factor);
        DipRect {
            x: left,
            y: top,
            width: right.saturating_sub(left),
            height: bottom.saturating_sub(top),
        }
    }
}

/// 显示器几何：物理 bounds/work area + 缩放因子。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorGeometry {
    /// 显示器物理 bounds。
    pub bounds: PhysicalRect,
    /// 工作区（扣除任务栏等）。
    pub work_area: PhysicalRect,
    /// 缩放因子。
    pub scale: ScaleFactor,
}

impl MonitorGeometry {
    /// 构造并校验 work area 完全位于 bounds 内。
    pub fn new(
        bounds: PhysicalRect,
        work_area: PhysicalRect,
        scale: ScaleFactor,
    ) -> Result<Self, GeometryError> {
        let inside = i64::from(work_area.x) >= i64::from(bounds.x)
            && i64::from(work_area.y) >= i64::from(bounds.y)
            && work_area.right() <= bounds.right()
            && work_area.bottom() <= bounds.bottom();
        if !inside {
            return Err(GeometryError::WorkAreaOutsideBounds);
        }
        Ok(Self {
            bounds,
            work_area,
            scale,
        })
    }

    /// 显示器 bounds 的 DIP 表示。
    #[must_use]
    pub fn bounds_dip(self) -> DipRect {
        self.bounds.to_dip(self.scale)
    }

    /// 工作区的 DIP 表示。
    #[must_use]
    pub fn work_area_dip(self) -> DipRect {
        self.work_area.to_dip(self.scale)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scale(value: f64) -> ScaleFactor {
        ScaleFactor::new(value).expect("valid scale")
    }

    #[test]
    fn points_round_trip_at_100_percent() {
        let identity = scale(1.0);
        let dip = DipPoint { x: 123, y: -45 };
        let physical = dip.to_physical(identity);
        assert_eq!(physical, PhysicalPoint { x: 123, y: -45 });
        assert_eq!(physical.to_dip(identity), dip);
    }

    #[test]
    fn rect_converts_each_edge_independently() {
        let rect = DipRect::new(-100, -50, 200, 100).expect("rect");
        let physical = rect.to_physical(scale(1.5));
        // left = round(-150) = -150; right = round(100*1.5=150) = 150 → width 300.
        assert_eq!(
            physical,
            PhysicalRect {
                x: -150,
                y: -75,
                width: 300,
                height: 150
            }
        );
    }

    #[test]
    fn physical_to_dip_uses_the_same_edges() {
        let physical = PhysicalRect::new(3, 3, 3, 3).expect("rect");
        let dip = physical.to_dip(scale(1.5));
        // left = round(3/1.5) = 2; right = round(6/1.5) = 4 → width 2.
        assert_eq!(
            dip,
            DipRect {
                x: 2,
                y: 2,
                width: 2,
                height: 2
            }
        );
    }

    #[test]
    fn rect_validation_and_accessors_do_not_overflow() {
        assert_eq!(
            DipRect::new(0, 0, -1, 10),
            Err(GeometryError::NegativeSize {
                width: -1,
                height: 10
            })
        );
        assert_eq!(
            PhysicalRect::new(0, 0, 10, -2),
            Err(GeometryError::NegativeSize {
                width: 10,
                height: -2
            })
        );
        let extreme = PhysicalRect::new(i32::MAX, i32::MAX, i32::MAX, i32::MAX).expect("rect");
        assert_eq!(extreme.right(), i64::from(i32::MAX) * 2);
        assert_eq!(extreme.bottom(), i64::from(i32::MAX) * 2);
        assert!(!extreme.is_empty());
        assert!(PhysicalRect::new(10, 10, 0, 5)
            .expect("zero width")
            .is_empty());
    }

    #[test]
    fn monitor_geometry_reports_work_area_in_dip() {
        let monitor = MonitorGeometry::new(
            PhysicalRect::new(0, 0, 1920, 1080).expect("bounds"),
            PhysicalRect::new(0, 0, 1920, 1040).expect("work area"),
            scale(2.0),
        )
        .expect("monitor");
        assert_eq!(
            monitor.bounds_dip(),
            DipRect {
                x: 0,
                y: 0,
                width: 960,
                height: 540
            }
        );
        assert_eq!(
            monitor.work_area_dip(),
            DipRect {
                x: 0,
                y: 0,
                width: 960,
                height: 520
            }
        );
    }

    #[test]
    fn monitor_geometry_handles_negative_origin_at_fractional_scale() {
        let monitor = MonitorGeometry::new(
            PhysicalRect::new(-1920, 0, 1920, 1080).expect("bounds"),
            PhysicalRect::new(-1920, 0, 1920, 1040).expect("work area"),
            scale(1.5),
        )
        .expect("monitor");
        let work_area = monitor.work_area_dip();
        assert_eq!(work_area.x, -1280);
        assert_eq!(work_area.right(), 0);
        assert_eq!(work_area.width, 1280);
        assert_eq!(work_area.y, 0);
        assert_eq!(work_area.height, 693, "round(1040/1.5) = 693");
    }

    #[test]
    fn work_area_must_stay_inside_bounds() {
        let bounds = PhysicalRect::new(0, 0, 1920, 1080).expect("bounds");
        assert_eq!(
            MonitorGeometry::new(
                bounds,
                PhysicalRect::new(-1, 0, 1920, 1040).expect("work area"),
                scale(1.0)
            ),
            Err(GeometryError::WorkAreaOutsideBounds)
        );
        assert_eq!(
            MonitorGeometry::new(
                bounds,
                PhysicalRect::new(0, 0, 1921, 1040).expect("work area"),
                scale(1.0)
            ),
            Err(GeometryError::WorkAreaOutsideBounds)
        );
        MonitorGeometry::new(
            bounds,
            PhysicalRect::new(0, 0, 1920, 1080).expect("work area"),
            scale(1.0),
        )
        .expect("full work area is legal");
    }
}
