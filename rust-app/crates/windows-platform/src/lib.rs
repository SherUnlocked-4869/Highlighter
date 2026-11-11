//! Windows 平台能力层（计划 §3.1 `windows-platform`）。
//!
//! R0 只有纯算术：DPI 缩放因子、DIP↔物理像素转换、点/矩形与显示器几何。Win32 捕获、
//! 焦点、快捷键、凭据与真机 DPI 矩阵属于 R3；本 crate 在 R0 不链接 `windows-sys`。
//!
//! 舍入规则是**候选实现**（R3 真机对照后冻结），见各函数文档。
#![forbid(unsafe_code)]

pub mod dpi;
pub mod geometry;

pub use dpi::{dip_to_physical, physical_to_dip, ScaleFactor, DEFAULT_DPI};
pub use geometry::{
    DipPoint, DipRect, GeometryError, MonitorGeometry, PhysicalPoint, PhysicalRect,
};
