//! 受控测试窗口：窗口/区域采集与“源目标变化”场景的合成内容源。
//!
//! 与 `anim.rs` 的区别：本模块窗口可由调用方控制标题/位置/可见性/关闭时机，并显式
//! 处理 `WM_PRINT`/`WM_PRINTCLIENT`，因此可被 `PrintWindow`（含隐藏窗口）渲染成位图，
//! 用于在**不打开可见窗口**的前提下验证窗口采集路径。
//!
//! 边界：隐藏窗口只在“本进程绘制 + PrintWindow/WM_PRINT”路径有意义；`BitBlt` 屏幕路径
//! 对隐藏窗口只能采到桌面背景（这正是要记录的差异）。可见窗口测试需要用户许可。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, InvalidateRect, HDC, HGDIOBJ,
    PAINTSTRUCT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect, GetMessageW, GetWindowRect,
    IsWindow, PostMessageW, PostQuitMessage, RegisterClassW, SetTimer, SetWindowPos,
    SetWindowTextW, ShowWindow, TranslateMessage, CS_HREDRAW, CS_VREDRAW, MSG, SWP_NOACTIVATE,
    SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WINDOW_STYLE, WM_CLOSE, WM_DESTROY,
    WM_ERASEBKGND, WM_PAINT, WM_PRINT, WM_PRINTCLIENT, WM_TIMER, WNDCLASSW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
};

static TICK: AtomicU64 = AtomicU64::new(0);

const CLASS_NAME: windows::core::PCWSTR = w!("HighlighterNativeCaptureTestWin");

fn paint_content(hdc: HDC, width: i32, height: i32, tick: u64, seed: u32) {
    let width = width.max(1);
    let height = height.max(1);
    let rc = RECT {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };
    // 背景随 tick 明显变化：保证每帧内容不同，可用于检测“静止/未更新”。
    let phase = ((tick.wrapping_mul(9).wrapping_add(seed as u64 * 37)) % 160) as u32;
    let bg =
        unsafe { CreateSolidBrush(COLORREF(0x0010_1010 | (phase << 8) | ((phase / 2) << 16))) };
    unsafe {
        FillRect(hdc, &rc, bg);
        let _ = DeleteObject(HGDIOBJ(bg.0));
    }
    // 横向移动亮条。
    let bar_w = (width / 8).max(16);
    let period = (width + bar_w).max(1) as u64;
    let x0 = ((tick * 6 + seed as u64 * 11) % period) as i32 - bar_w;
    let bar = RECT {
        left: x0.clamp(0, width - 1),
        top: 0,
        right: (x0 + bar_w).clamp(1, width),
        bottom: height / 2,
    };
    let accent = unsafe { CreateSolidBrush(COLORREF(0x0000_9CFF)) };
    unsafe {
        FillRect(hdc, &bar, accent);
        let _ = DeleteObject(HGDIOBJ(accent.0));
    }
    // 右下角色块：第二个变化维度。
    let hue = (tick % 64) as u32;
    let color = COLORREF(0x20 | ((hue * 4) & 0xFF) << 8 | (((63 - hue) * 4) & 0xFF) << 16);
    let patch = RECT {
        left: width - (width / 5).max(24),
        top: height - (height / 4).max(16),
        right: width,
        bottom: height,
    };
    let brush = unsafe { CreateSolidBrush(color) };
    unsafe {
        FillRect(hdc, &patch, brush);
        let _ = DeleteObject(HGDIOBJ(brush.0));
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = unsafe { BeginPaint(hwnd, &mut ps) };
            let mut rc = RECT::default();
            let _ = unsafe { GetClientRect(hwnd, &mut rc) };
            paint_content(
                hdc,
                rc.right - rc.left,
                rc.bottom - rc.top,
                TICK.load(Ordering::Relaxed),
                hwnd.0 as usize as u32,
            );
            let _ = unsafe { EndPaint(hwnd, &ps) };
            LRESULT(0)
        }
        // PrintWindow / 显式 WM_PRINT：把同一份内容绘制到调用方给的 DC。
        WM_PRINT | WM_PRINTCLIENT => {
            let hdc = HDC(wparam.0 as *mut core::ffi::c_void);
            let mut rc = RECT::default();
            let _ = unsafe { GetClientRect(hwnd, &mut rc) };
            paint_content(
                hdc,
                rc.right - rc.left,
                rc.bottom - rc.top,
                TICK.load(Ordering::Relaxed),
                hwnd.0 as usize as u32,
            );
            LRESULT(0)
        }
        WM_TIMER => {
            TICK.fetch_add(1, Ordering::Relaxed);
            let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

#[derive(Clone, Debug)]
pub struct TestWindowSpec {
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub visible: bool,
}

pub struct TestWindow {
    hwnd: HWND,
    join: Option<JoinHandle<()>>,
}

unsafe impl Send for TestWindow {}

impl TestWindow {
    pub fn spawn(spec: &TestWindowSpec) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel::<isize>();
        let spec = spec.clone();
        let join = std::thread::Builder::new()
            .name(format!("testwin-{}", spec.title))
            .spawn(move || unsafe {
                let hinstance: HINSTANCE = match GetModuleHandleW(None) {
                    Ok(m) => HINSTANCE(m.0),
                    Err(e) => {
                        logln!("[testwin] GetModuleHandleW failed: {e}");
                        let _ = tx.send(0);
                        return;
                    }
                };
                let wc = WNDCLASSW {
                    style: CS_HREDRAW | CS_VREDRAW,
                    lpfnWndProc: Some(wndproc),
                    hInstance: hinstance,
                    lpszClassName: CLASS_NAME,
                    ..Default::default()
                };
                let _ = RegisterClassW(&wc);
                let visible = if spec.visible {
                    WS_VISIBLE
                } else {
                    WINDOW_STYLE(0)
                };
                let hwnd = match CreateWindowExW(
                    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    CLASS_NAME,
                    &windows::core::HSTRING::from(spec.title.as_str()),
                    WS_POPUP | visible,
                    spec.x,
                    spec.y,
                    spec.width.max(16),
                    spec.height.max(16),
                    None,
                    None,
                    Some(hinstance),
                    None,
                ) {
                    Ok(h) => h,
                    Err(e) => {
                        logln!("[testwin] CreateWindowExW failed: {e}");
                        let _ = tx.send(0);
                        return;
                    }
                };
                let _ = SetTimer(Some(hwnd), 1, 33, None);
                let _ = tx.send(hwnd.0 as isize);
                logln!(
                    "[testwin] '{}' created at ({},{}) {}x{} visible={} hwnd=0x{:X}",
                    spec.title,
                    spec.x,
                    spec.y,
                    spec.width,
                    spec.height,
                    spec.visible,
                    hwnd.0 as usize
                );
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                logln!("[testwin] '{}' thread exited", spec.title);
            })
            .map_err(|e| format!("spawn testwin thread failed: {e}"))?;
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(0) => {
                let _ = join.join();
                Err("test window creation failed (see log)".to_string())
            }
            Ok(hwnd) => Ok(Self {
                hwnd: HWND(hwnd as *mut core::ffi::c_void),
                join: Some(join),
            }),
            Err(e) => Err(format!("test window did not become ready: {e}")),
        }
    }

    pub fn hwnd(&self) -> isize {
        self.hwnd.0 as isize
    }

    pub fn rect(&self) -> Option<RECT> {
        let mut rc = RECT::default();
        unsafe { GetWindowRect(self.hwnd, &mut rc) }.ok()?;
        Some(rc)
    }

    pub fn move_to(&self, x: i32, y: i32) -> bool {
        unsafe {
            SetWindowPos(
                self.hwnd,
                None,
                x,
                y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
        }
        .is_ok()
    }

    pub fn set_visible(&self, visible: bool) {
        unsafe {
            let _ = ShowWindow(self.hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
        }
    }

    pub fn set_title(&self, title: &str) {
        unsafe {
            let _ = SetWindowTextW(self.hwnd, &windows::core::HSTRING::from(title));
        }
    }

    pub fn is_alive(&self) -> bool {
        unsafe { IsWindow(Some(self.hwnd)).as_bool() }
    }

    pub fn close(mut self) {
        if self.is_alive() {
            unsafe {
                let _ = PostMessageW(Some(self.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}
