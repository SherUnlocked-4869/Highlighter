//! DPI 与 DIP↔物理像素换算（R0 候选实现）。
//!
//! Windows 的缩放模型：100% = 96 DPI。R0 假设 DIP→物理是线性缩放，舍入规则为
//! **半数远离零**（`f64::round`）并饱和到 `i32`；负坐标（主屏左侧/上方的副屏）对称处理。
//!
//! R3 必须用真实窗口在 100/150/200%、负坐标、副屏上对照 Chromium/Win32 的实际取整，
//! 通过后才把这里当冻结行为；R0 不宣称与 Electron 完全一致。

use std::fmt;

/// Windows 基准 DPI（100% 缩放）。
pub const DEFAULT_DPI: u32 = 96;

/// 缩放因子（例如 `1.5` = 150%）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScaleFactor(f64);

/// 缩放因子构造错误。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ScaleFactorError {
    /// 缩放因子不是有限正数。
    InvalidScale(f64),
    /// DPI 为 0。
    InvalidDpi(u32),
}

impl fmt::Display for ScaleFactorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScaleFactorError::InvalidScale(scale) => {
                write!(formatter, "invalid scale factor: {scale}")
            }
            ScaleFactorError::InvalidDpi(dpi) => write!(formatter, "invalid DPI: {dpi}"),
        }
    }
}

impl std::error::Error for ScaleFactorError {}

impl ScaleFactor {
    /// 从缩放因子构造；必须是有限正数。
    pub fn new(scale: f64) -> Result<Self, ScaleFactorError> {
        if !scale.is_finite() || scale <= 0.0 {
            return Err(ScaleFactorError::InvalidScale(scale));
        }
        Ok(Self(scale))
    }

    /// 从 DPI 构造：`dpi / 96`。
    pub fn from_dpi(dpi: u32) -> Result<Self, ScaleFactorError> {
        if dpi == 0 {
            return Err(ScaleFactorError::InvalidDpi(dpi));
        }
        Ok(Self(f64::from(dpi) / f64::from(DEFAULT_DPI)))
    }

    /// 缩放因子（1.0 = 100%）。
    #[must_use]
    pub fn scale(self) -> f64 {
        self.0
    }

    /// 等价 DPI。
    #[must_use]
    pub fn dpi(self) -> f64 {
        self.0 * f64::from(DEFAULT_DPI)
    }

    /// 百分比形式（150.0 = 150%）。
    #[must_use]
    pub fn percent(self) -> f64 {
        self.0 * 100.0
    }
}

impl fmt::Display for ScaleFactor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}%", self.percent())
    }
}

/// DIP → 物理像素（`round(dip * scale)`，半数远离零，饱和到 `i32`）。
pub fn dip_to_physical(dip: i32, scale: ScaleFactor) -> i32 {
    saturating_round(f64::from(dip) * scale.0)
}

/// 物理像素 → DIP（`round(physical / scale)`，半数远离零，饱和到 `i32`）。
pub fn physical_to_dip(physical: i32, scale: ScaleFactor) -> i32 {
    saturating_round(f64::from(physical) / scale.0)
}

/// 把一个边坐标按因子缩放并舍入到 `i32`（矩形转换内部使用）。
pub(crate) fn scale_round(edge: i64, factor: f64) -> i32 {
    saturating_round(edge as f64 * factor)
}

fn saturating_round(value: f64) -> i32 {
    let rounded = value.round();
    if rounded >= f64::from(i32::MAX) {
        i32::MAX
    } else if rounded <= f64::from(i32::MIN) {
        i32::MIN
    } else {
        rounded as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_factor_accepts_finite_positive_values() {
        for scale in [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0] {
            let factor = ScaleFactor::new(scale).expect("valid scale");
            assert!((factor.scale() - scale).abs() < f64::EPSILON);
        }
        for bad in [0.0, -0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(
                matches!(
                    ScaleFactor::new(bad),
                    Err(ScaleFactorError::InvalidScale(_))
                ),
                "scale {bad} must be rejected"
            );
        }
    }

    #[test]
    fn dpi_round_trips_through_scale_factor() {
        let cases = [(96, 1.0), (120, 1.25), (144, 1.5), (168, 1.75), (192, 2.0)];
        for (dpi, expected) in cases {
            let factor = ScaleFactor::from_dpi(dpi).expect("valid dpi");
            assert!((factor.scale() - expected).abs() < 1e-12, "dpi {dpi}");
            assert!((factor.dpi() - f64::from(dpi)).abs() < 1e-9, "dpi {dpi}");
        }
        assert!(matches!(
            ScaleFactor::from_dpi(0),
            Err(ScaleFactorError::InvalidDpi(0))
        ));
        assert!((ScaleFactor::from_dpi(144).expect("dpi").percent() - 150.0).abs() < 1e-9);
        assert_eq!(ScaleFactor::from_dpi(144).expect("dpi").to_string(), "150%");
    }

    #[test]
    fn dip_to_physical_rounds_half_away_from_zero() {
        let half = ScaleFactor::new(1.5).expect("scale");
        assert_eq!(dip_to_physical(1, half), 2, "1.5 rounds to 2");
        assert_eq!(dip_to_physical(-1, half), -2, "-1.5 rounds to -2");
        assert_eq!(dip_to_physical(2, half), 3, "3.0 stays 3");
        assert_eq!(dip_to_physical(-2, half), -3, "-3.0 stays -3");

        let quarter = ScaleFactor::new(1.25).expect("scale");
        assert_eq!(dip_to_physical(1, quarter), 1, "1.25 rounds to 1");
        assert_eq!(dip_to_physical(2, quarter), 3, "2.5 rounds to 3");
        assert_eq!(dip_to_physical(-2, quarter), -3, "-2.5 rounds to -3");
        assert_eq!(dip_to_physical(3, quarter), 4, "3.75 rounds to 4");

        let identity = ScaleFactor::new(1.0).expect("scale");
        assert_eq!(dip_to_physical(-1920, identity), -1920);
        let double = ScaleFactor::new(2.0).expect("scale");
        assert_eq!(dip_to_physical(100, double), 200);
        assert_eq!(dip_to_physical(-1920, double), -3840);
    }

    #[test]
    fn physical_to_dip_rounds_and_never_wraps() {
        let half = ScaleFactor::new(1.5).expect("scale");
        assert_eq!(physical_to_dip(3, half), 2, "2.0");
        assert_eq!(physical_to_dip(-3, half), -2, "-2.0");
        // 饱和而不是回绕：极端缩放/坐标不产生负的"反向"结果。
        let tiny = ScaleFactor::new(1e-9).expect("scale");
        assert_eq!(physical_to_dip(i32::MAX, tiny), i32::MAX);
        assert_eq!(physical_to_dip(i32::MIN, tiny), i32::MIN);
        // 巨大缩放下结果落在 0 附近，不应饱和（只是验证普通舍入路径）。
        let huge = ScaleFactor::new(1e9).expect("scale");
        assert_eq!(physical_to_dip(i32::MAX, huge), 2);
        assert_eq!(physical_to_dip(i32::MIN, huge), -2);
    }
}
