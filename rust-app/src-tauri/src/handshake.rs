//! ready/init 握手与页面指标回报（纯状态机，无 GUI，可单测）。
//!
//! 计划 §4.3 的握手顺序是“先注册监听，再 ready，再接收 init”；宿主侧必须保证
//! `init` **只发一次**（重复 ready 不重发），否则页面会把初始化状态机跑两遍。
//! 事件名统一带 `prototype:` 前缀，避免与 R1 以后的正式合同事件名混淆。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;

/// 原型协议标识：随 init 载荷下发，页面回显到指标回报里，方便日志对照。
pub const PROTOCOL: &str = "r0-prototype-1";

/// 页面回传的 WebView 指标（`devicePixelRatio`、Canvas 的 CSS/像素尺寸等）。
///
/// 字段与 `prototype-ui/canvas.js` 的 `camelCase` JSON 一一对应；`screen_x/screen_y`
/// 是页面看到的窗口屏幕坐标（WebView2 里的 `window.screenX/screenY`），用于和宿主
/// 侧 `outer_position()` 对照，不作为定位依据。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsReport {
    /// `window.devicePixelRatio`。
    pub device_pixel_ratio: f64,
    /// Canvas 的 CSS 宽度（`getBoundingClientRect().width`）。
    pub canvas_css_width: f64,
    /// Canvas 的 CSS 高度。
    pub canvas_css_height: f64,
    /// Canvas 背景缓冲宽度（`canvas.width`，物理像素）。
    pub canvas_pixel_width: u32,
    /// Canvas 背景缓冲高度（`canvas.height`，物理像素）。
    pub canvas_pixel_height: u32,
    /// 视口宽度（CSS 像素）。
    pub inner_width: u32,
    /// 视口高度（CSS 像素）。
    pub inner_height: u32,
    /// 页面报告的窗口左上角屏幕 x。
    pub screen_x: f64,
    /// 页面报告的窗口左上角屏幕 y。
    pub screen_y: f64,
    /// 页面完成绘制的次数（至少 1 才算首帧已画）。
    pub paint_count: u32,
    /// WebView2 User-Agent（记录 Runtime 版本线索，不用于分支）。
    pub user_agent: String,
}

impl MetricsReport {
    /// 校验 Canvas 缓冲尺寸是否确实按 `devicePixelRatio` 放大（留 1px 舍入误差）。
    ///
    /// 这是 R0 的关键证据：如果页面没有按 DPR 放大 Canvas，后续截图/放大镜链路会整体
    /// 错位。返回 `false` 时调用方应打印 `[FAIL]` 而不是静默通过。
    pub fn canvas_matches_dpr(&self) -> bool {
        if !self.device_pixel_ratio.is_finite() || self.device_pixel_ratio <= 0.0 {
            return false;
        }
        let expected_width = (self.canvas_css_width * self.device_pixel_ratio).round();
        let expected_height = (self.canvas_css_height * self.device_pixel_ratio).round();
        (f64::from(self.canvas_pixel_width) - expected_width).abs() <= 1.0
            && (f64::from(self.canvas_pixel_height) - expected_height).abs() <= 1.0
    }
}

/// 握手状态与最近一次指标回报。
#[derive(Debug, Default)]
pub struct Handshake {
    ready_count: AtomicU64,
    metrics_count: AtomicU64,
    init_sent: AtomicBool,
    metrics: Mutex<Option<MetricsReport>>,
}

impl Handshake {
    /// 新建共享状态（宿主与自检线程共用）。
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 记录一次页面 ready；返回这是第几次 ready。
    pub fn mark_ready(&self) -> u64 {
        self.ready_count.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// 已有几次 ready。
    pub fn ready_count(&self) -> u64 {
        self.ready_count.load(Ordering::SeqCst)
    }

    /// 尝试占用“发送 init”的资格：只有第一次调用返回 `true`。
    pub fn claim_init(&self) -> bool {
        !self.init_sent.swap(true, Ordering::SeqCst)
    }

    /// init 是否已经发过。
    pub fn init_sent(&self) -> bool {
        self.init_sent.load(Ordering::SeqCst)
    }

    /// 保存页面指标回报；返回这是第几次回报。
    pub fn record_metrics(&self, report: MetricsReport) -> u64 {
        if let Ok(mut guard) = self.metrics.lock() {
            *guard = Some(report);
        }
        self.metrics_count.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// 最近一次指标回报的副本。
    pub fn metrics(&self) -> Option<MetricsReport> {
        self.metrics.lock().ok().and_then(|guard| guard.clone())
    }

    /// 指标回报次数。
    pub fn metrics_count(&self) -> u64 {
        self.metrics_count.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_report(dpr: f64) -> MetricsReport {
        MetricsReport {
            device_pixel_ratio: dpr,
            canvas_css_width: 1_280.0,
            canvas_css_height: 720.0,
            canvas_pixel_width: (1_280.0 * dpr).round() as u32,
            canvas_pixel_height: (720.0 * dpr).round() as u32,
            inner_width: 1_280,
            inner_height: 720,
            screen_x: -2_560.0,
            screen_y: -1_440.0,
            paint_count: 1,
            user_agent: "test".to_string(),
        }
    }

    #[test]
    fn init_is_sent_exactly_once_even_if_ready_repeats() {
        let handshake = Handshake::new();
        assert!(!handshake.init_sent());
        assert_eq!(handshake.ready_count(), 0);

        assert_eq!(handshake.mark_ready(), 1);
        assert!(handshake.claim_init(), "first ready claims init");
        assert!(
            !handshake.claim_init(),
            "second ready must not send init again"
        );
        assert_eq!(handshake.mark_ready(), 2);
        assert!(handshake.init_sent());
    }

    #[test]
    fn metrics_reports_are_stored_and_counted() {
        let handshake = Handshake::new();
        assert_eq!(handshake.metrics(), None);

        assert_eq!(handshake.record_metrics(sample_report(1.5)), 1);
        assert_eq!(handshake.metrics_count(), 1);
        let report = handshake.metrics().expect("stored report");
        assert!((report.device_pixel_ratio - 1.5).abs() < f64::EPSILON);
        assert!(report.canvas_matches_dpr());
    }

    #[test]
    fn canvas_dpr_validation_rejects_missing_scale() {
        let mut report = sample_report(1.5);
        report.canvas_pixel_width = report.canvas_css_width as u32; // 忘了乘 DPR
        assert!(!report.canvas_matches_dpr());

        let mut report = sample_report(1.0);
        report.device_pixel_ratio = 0.0;
        assert!(!report.canvas_matches_dpr());
    }
}
