//! 窗口采集源：PrintWindow / BitBlt(window DC) / BitBlt(screen DC) 三种方法与
//! “源目标变化”（移动 / 关闭 / 重新解析到另一窗口）的记录。
//!
//! 语义边界（写进证据文档）：
//! - `screen` 方法每帧按窗口当前矩形从屏幕 DC 拷贝：能跟随移动，但窗口被遮挡/最小化时
//!   采到的是遮挡物或桌面背景，且窗口关闭后**不会报错**（继续采到原位置的桌面）；
//! - `window-dc` 方法用 GetWindowDC：对普通 GDI 窗口可在被遮挡时取到窗口内容，但
//!   DWM 合成内容/透明/分层窗口不保证；
//! - `printwindow` 方法请求 DWM/窗口自绘（PW_RENDERFULLCONTENT），对遮挡与隐藏窗口
//!   更稳，但每帧 CPU 成本更高；失败时回退显式 WM_PRINT 并计数；
//! - 输出尺寸在采集开始前固定；目标尺寸变化时只记录事件并按左上角裁剪/补黑，
//!   不重建编码器（R5 的尺寸变化语义另定）。

use std::ffi::c_void;

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{BitBlt, GetWindowDC, ReleaseDC, HDC, ROP_CODE, SRCCOPY};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextW, IsIconic, IsWindow, IsWindowVisible,
    SendMessageW, PRF_CHILDREN, PRF_CLIENT, PRF_ERASEBKGND, WM_PRINT, WM_PRINTCLIENT,
};

const CAPTUREBLT: u32 = 0x4000_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowMethod {
    Screen,
    WindowDc,
    PrintWindow,
}

impl WindowMethod {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "screen" => Ok(Self::Screen),
            "window-dc" => Ok(Self::WindowDc),
            "printwindow" => Ok(Self::PrintWindow),
            other => Err(format!(
                "unknown --window-method '{other}' (expected screen|window-dc|printwindow)"
            )),
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Screen => "screen",
            Self::WindowDc => "window-dc",
            Self::PrintWindow => "printwindow",
        }
    }
}

#[derive(Clone, Debug)]
pub struct WindowMatch {
    pub hwnd: isize,
    pub title: String,
    pub class: String,
    pub rect: RECT,
    pub visible: bool,
}

impl WindowMatch {
    pub fn describe(&self) -> String {
        format!(
            "hwnd=0x{:X} title={:?} class={:?} rect=({},{}..{}, {}) visible={}",
            self.hwnd,
            self.title,
            self.class,
            self.rect.left,
            self.rect.top,
            self.rect.right,
            self.rect.bottom,
            self.visible
        )
    }
}

fn window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) } as usize;
    String::from_utf16_lossy(&buf[..len.min(buf.len())])
}

fn window_class(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
    String::from_utf16_lossy(&buf[..len.min(buf.len())])
}

/// 优先 DWM 扩展边框（物理像素、与 DPI 感知一致），失败回退 GetWindowRect。
pub fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    let dwm_ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .is_ok();
    if dwm_ok && rect.right > rect.left && rect.bottom > rect.top {
        return Some(rect);
    }
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
        Some(rect)
    } else {
        None
    }
}

pub fn window_minimized(hwnd: HWND) -> bool {
    unsafe { IsIconic(hwnd).as_bool() }
}

pub fn window_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        )
    }
    .is_ok();
    ok && cloaked != 0
}

struct EnumState {
    pattern_lower: String,
    exclude_lower: Vec<String>,
    matches: Vec<WindowMatch>,
}

unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = unsafe { &mut *(lparam.0 as *mut EnumState) };
    let title = window_text(hwnd);
    if title.is_empty() {
        return BOOL(1);
    }
    let lower = title.to_lowercase();
    if !lower.contains(&state.pattern_lower) {
        return BOOL(1);
    }
    if state
        .exclude_lower
        .iter()
        .any(|ex| !ex.is_empty() && lower.contains(ex))
    {
        return BOOL(1);
    }
    let rect = window_rect(hwnd).unwrap_or_default();
    state.matches.push(WindowMatch {
        hwnd: hwnd.0 as isize,
        title,
        class: window_class(hwnd),
        rect,
        visible: unsafe { IsWindowVisible(hwnd).as_bool() },
    });
    BOOL(1)
}

/// 按标题子串（不区分大小写）枚举顶层窗口；`exclude` 为额外排除的子串。
/// 排序：可见窗口优先、面积大者优先，保证多匹配时选择稳定。
pub fn find_windows(pattern: &str, exclude: &[String]) -> Vec<WindowMatch> {
    let mut state = EnumState {
        pattern_lower: pattern.to_lowercase(),
        exclude_lower: exclude.iter().map(|s| s.to_lowercase()).collect(),
        matches: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut state as *mut EnumState as isize));
    }
    state.matches.sort_by(|a, b| {
        let area = |m: &WindowMatch| {
            ((m.rect.right - m.rect.left).max(0) as i64)
                * ((m.rect.bottom - m.rect.top).max(0) as i64)
        };
        (!a.visible, -area(a)).cmp(&(!b.visible, -area(b)))
    });
    state.matches
}

pub fn resolve_by_title(pattern: &str, exclude: &[String]) -> Option<WindowMatch> {
    find_windows(pattern, exclude).into_iter().next()
}

pub fn resolve_by_hwnd(hwnd_value: isize) -> Option<WindowMatch> {
    let hwnd = HWND(hwnd_value as *mut c_void);
    if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return None;
    }
    Some(WindowMatch {
        hwnd: hwnd_value,
        title: window_text(hwnd),
        class: window_class(hwnd),
        rect: window_rect(hwnd).unwrap_or_default(),
        visible: unsafe { IsWindowVisible(hwnd).as_bool() },
    })
}

/// 单次抓取结果：事件为“状态转移”文本（由调用方加媒体时间戳）。
#[derive(Debug, Default)]
pub struct GrabOutcome {
    pub ok: bool,
    pub events: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct WindowStats {
    pub grabs: u64,
    pub failures: u64,
    pub invalid_events: u64,
    pub retargets: u64,
    pub moves: u64,
    pub size_changes: u64,
    pub visibility_changes: u64,
    pub printwindow_calls: u64,
    pub printwindow_failures: u64,
    pub wm_print_fallbacks: u64,
    pub screen_grabs: u64,
    pub windowdc_grabs: u64,
    /// 采到的帧里“窗口矩形内全黑”的帧数（PrintWindow 失败/空白的信号）。
    pub black_frames: u64,
}

pub struct WindowSource {
    pub hwnd: HWND,
    pub method: WindowMethod,
    pub title_pattern: Option<String>,
    pub exclude: Vec<String>,
    pub follow: bool,
    pub out_width: i32,
    pub out_height: i32,
    pub initial: WindowMatch,
    last_rect: Option<RECT>,
    last_visible: Option<bool>,
    last_minimized: Option<bool>,
    first_grab: bool,
    pub stats: WindowStats,
}

// HWND 只在采集线程内使用；跨线程传递的是目标所有权（在场景模式里 move 进采集线程），
// Win32 的 HWND 句柄本身是进程级句柄，线程间使用由系统保证。
unsafe impl Send for WindowSource {}

impl WindowSource {
    pub fn new(
        initial: WindowMatch,
        method: WindowMethod,
        title_pattern: Option<String>,
        exclude: Vec<String>,
        follow: bool,
        out_width: i32,
        out_height: i32,
    ) -> Self {
        Self {
            hwnd: HWND(initial.hwnd as *mut c_void),
            method,
            title_pattern,
            exclude,
            follow,
            out_width,
            out_height,
            initial,
            last_rect: None,
            last_visible: None,
            last_minimized: None,
            first_grab: true,
            stats: WindowStats::default(),
        }
    }

    /// 目标失效时尝试按标题重解析到另一窗口（“切换到另一窗口”）。
    fn try_retarget(&mut self) -> bool {
        let Some(pattern) = self.title_pattern.clone() else {
            return false;
        };
        if let Some(found) = resolve_by_title(&pattern, &self.exclude) {
            if found.hwnd != self.hwnd.0 as isize {
                logln!(
                    "[window] retarget: {} -> {}",
                    self.describe_hwnd(),
                    found.describe()
                );
                self.hwnd = HWND(found.hwnd as *mut c_void);
                self.last_rect = None;
                self.stats.retargets += 1;
                return true;
            }
        }
        false
    }

    fn describe_hwnd(&self) -> String {
        format!("hwnd=0x{:X}", self.hwnd.0 as usize)
    }

    /// 抓一帧到调用方提供的 DIB 缓冲区（top-down BGRA，大小 out_width*out_height*4）。
    pub fn grab(
        &mut self,
        mem_dc: HDC,
        screen_dc: HDC,
        bits: *mut c_void,
        byte_len: usize,
    ) -> GrabOutcome {
        let mut outcome = GrabOutcome::default();
        if !unsafe { IsWindow(Some(self.hwnd)).as_bool() } {
            self.stats.invalid_events += 1;
            outcome.events.push("target-invalid".to_string());
            if self.follow && self.try_retarget() {
                outcome.events.push("target-retargeted".to_string());
            } else {
                self.stats.failures += 1;
                outcome.error = Some("window target is no longer valid".to_string());
                return outcome;
            }
        }
        // DIB 先补黑：PrintWindow 只覆盖窗口实际尺寸，尺寸变化时其余区域保持确定值。
        unsafe {
            std::ptr::write_bytes(bits as *mut u8, 0, byte_len);
        }
        let rect = match window_rect(self.hwnd) {
            Some(r) => r,
            None => {
                self.stats.failures += 1;
                outcome.error = Some("GetWindowRect/DwmGetWindowAttribute failed".to_string());
                return outcome;
            }
        };
        if let Some(last) = self.last_rect {
            if last != rect {
                self.stats.moves += 1;
                outcome.events.push(format!(
                    "rect-changed ({},{}..{}, {}) -> ({},{}..{}, {})",
                    last.left,
                    last.top,
                    last.right,
                    last.bottom,
                    rect.left,
                    rect.top,
                    rect.right,
                    rect.bottom
                ));
            }
        }
        self.last_rect = Some(rect);
        let visible = unsafe { IsWindowVisible(self.hwnd).as_bool() };
        if self.last_visible != Some(visible) {
            self.stats.visibility_changes += 1;
            outcome.events.push(format!("visible={visible}"));
            self.last_visible = Some(visible);
        }
        let minimized = window_minimized(self.hwnd);
        if self.last_minimized != Some(minimized) {
            outcome.events.push(format!("minimized={minimized}"));
            self.last_minimized = Some(minimized);
        }
        let rect_w = rect.right - rect.left;
        let rect_h = rect.bottom - rect.top;
        if rect_w <= 0 || rect_h <= 0 {
            self.stats.invalid_events += 1;
            self.stats.failures += 1;
            outcome.error = Some(format!("window rect is empty: {rect:?}"));
            return outcome;
        }
        if rect_w != self.out_width || rect_h != self.out_height {
            self.stats.size_changes += 1;
            outcome.events.push(format!(
                "size-changed {}x{} -> {}x{} (output fixed {}x{})",
                self.out_width, self.out_height, rect_w, rect_h, self.out_width, self.out_height
            ));
        }
        // 内容尺寸取输出尺寸与窗口矩形较小者（固定编码器尺寸，裁剪/补黑）。
        let copy_w = rect_w.min(self.out_width).max(1);
        let copy_h = rect_h.min(self.out_height).max(1);
        let ok = match self.method {
            WindowMethod::Screen => {
                self.stats.screen_grabs += 1;
                let rop = ROP_CODE(SRCCOPY.0 | CAPTUREBLT);
                unsafe {
                    BitBlt(
                        mem_dc,
                        0,
                        0,
                        copy_w,
                        copy_h,
                        Some(screen_dc),
                        rect.left,
                        rect.top,
                        rop,
                    )
                }
                .is_ok()
            }
            WindowMethod::WindowDc => {
                self.stats.windowdc_grabs += 1;
                let window_dc = unsafe { GetWindowDC(Some(self.hwnd)) };
                if window_dc.is_invalid() {
                    false
                } else {
                    let rop = ROP_CODE(SRCCOPY.0 | CAPTUREBLT);
                    let result =
                        unsafe { BitBlt(mem_dc, 0, 0, copy_w, copy_h, Some(window_dc), 0, 0, rop) };
                    let _ = unsafe { ReleaseDC(Some(self.hwnd), window_dc) };
                    result.is_ok()
                }
            }
            WindowMethod::PrintWindow => {
                self.stats.printwindow_calls += 1;
                let flags = PRINT_WINDOW_FLAGS(2); // PW_RENDERFULLCONTENT
                let ok = unsafe { PrintWindow(self.hwnd, mem_dc, flags) }.as_bool();
                if ok {
                    true
                } else {
                    self.stats.printwindow_failures += 1;
                    // 回退：显式 WM_PRINT（自绘窗口/隐藏窗口更可能成功）。
                    let flags = PRF_CLIENT | PRF_CHILDREN | PRF_ERASEBKGND;
                    unsafe {
                        let _ = SendMessageW(
                            self.hwnd,
                            WM_PRINT,
                            Some(WPARAM(mem_dc.0 as usize)),
                            Some(LPARAM(flags as isize)),
                        );
                        let _ = SendMessageW(
                            self.hwnd,
                            WM_PRINTCLIENT,
                            Some(WPARAM(mem_dc.0 as usize)),
                            Some(LPARAM(flags as isize)),
                        );
                    }
                    self.stats.wm_print_fallbacks += 1;
                    self.stats.printwindow_failures -= 1;
                    true
                }
            }
        };
        self.stats.grabs += 1;
        if !ok {
            self.stats.failures += 1;
            outcome.error = Some(format!(
                "grab failed: method={} hwnd=0x{:X} rect={rect:?}",
                self.method.name(),
                self.hwnd.0 as usize
            ));
            return outcome;
        }
        // 全黑检测（抽样 1/16 像素，足够发现“整窗黑块”）。
        let pixels = unsafe { std::slice::from_raw_parts(bits as *const u8, byte_len) };
        let mut sampled = 0usize;
        let mut black = true;
        let mut idx = 0usize;
        while idx * 4 + 2 < pixels.len() {
            let p = idx * 4;
            if pixels[p] > 2 || pixels[p + 1] > 2 || pixels[p + 2] > 2 {
                black = false;
                break;
            }
            sampled += 1;
            idx += 16;
        }
        if black && sampled > 0 {
            self.stats.black_frames += 1;
        }
        if self.first_grab {
            self.first_grab = false;
            logln!(
                "[window] first grab: method={} target=0x{:X} rect={:?} out={}x{} black={}",
                self.method.name(),
                self.hwnd.0 as usize,
                rect,
                self.out_width,
                self.out_height,
                black
            );
        }
        outcome.ok = true;
        outcome
    }
}
