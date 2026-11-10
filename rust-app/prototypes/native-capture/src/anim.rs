//! 测试动画窗口：放在**被采集的显示器**上，用 30Hz 重绘制造 DWM 合成更新。
//!
//! 背景：WGC 只在桌面内容变化时产出新帧（静止桌面会远低于目标 fps）。
//! 因此默认启动一个 480x270 的无边框、不抢焦点、置顶小窗，里面有一根横向移动的
//! 亮条；它随采集目标出现在副屏（遵循仓库 AGENTS.md "可见测试窗口只放副屏"）。
//!
//! 该窗口只用于让 WGC/GDI 有稳定的内容变化来源，不是产品功能。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;

use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, InvalidateRect, HGDIOBJ,
    PAINTSTRUCT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect, GetMessageW, PostMessageW,
    PostQuitMessage, RegisterClassW, SetTimer, TranslateMessage, CS_HREDRAW, CS_VREDRAW, MSG,
    WM_CLOSE, WM_DESTROY, WM_ERASEBKGND, WM_PAINT, WM_TIMER, WNDCLASSW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};

static TICK: AtomicU64 = AtomicU64::new(0);

const WINDOW_W: i32 = 480;
const WINDOW_H: i32 = 270;

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = unsafe { BeginPaint(hwnd, &mut ps) };
            let mut rc = RECT::default();
            let _ = unsafe { GetClientRect(hwnd, &mut rc) };
            let width = (rc.right - rc.left).max(1);
            let height = (rc.bottom - rc.top).max(1);
            let bg = unsafe { CreateSolidBrush(COLORREF(0x0020_2020)) };
            unsafe {
                FillRect(hdc, &rc, bg);
            }
            unsafe {
                let _ = DeleteObject(HGDIOBJ(bg.0));
            }
            // 移动亮条：tick 每 33ms +1，位置每 tick +8px，循环。
            let tick = TICK.load(Ordering::Relaxed);
            let bar_w = 28i32;
            let period = (width + bar_w) as u64;
            let x0 = ((tick * 8) % period) as i32 - bar_w;
            let bar = RECT {
                left: x0.clamp(0, width - 1),
                top: 0,
                right: (x0 + bar_w).clamp(1, width),
                bottom: height,
            };
            let accent = unsafe { CreateSolidBrush(COLORREF(0x0000_9CFF)) };
            unsafe {
                FillRect(hdc, &bar, accent);
            }
            unsafe {
                let _ = DeleteObject(HGDIOBJ(accent.0));
            }
            // 第二块：随时间变色的方块，避免只有单条路径被优化成静止。
            let hue = (tick % 64) as u32;
            let color = COLORREF(0x20 | ((hue * 4) & 0xFF) << 8 | (((63 - hue) * 4) & 0xFF) << 16);
            let patch = RECT {
                left: 8,
                top: height - 40,
                right: 72,
                bottom: height - 8,
            };
            let brush = unsafe { CreateSolidBrush(color) };
            unsafe {
                FillRect(hdc, &patch, brush);
                let _ = DeleteObject(HGDIOBJ(brush.0));
            }
            let _ = unsafe { EndPaint(hwnd, &ps) };
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

// HWND 是 *mut c_void，跨线程只用于 PostMessage；包装后手动声明 Send。
pub struct AnimWindow {
    hwnd: HWND,
    join: Option<JoinHandle<()>>,
}

unsafe impl Send for AnimWindow {}

impl AnimWindow {
    /// 在 `target` 显示器内创建动画窗口（位置在目标显示器左上角内缩）。
    pub fn spawn(target: &RECT) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel::<isize>();
        let rect = *target;
        let join = std::thread::Builder::new()
            .name("anim-window".into())
            .spawn(move || {
                unsafe {
                    let hinstance: HINSTANCE = match GetModuleHandleW(None) {
                        Ok(m) => HINSTANCE(m.0),
                        Err(e) => {
                            logln!("[anim] GetModuleHandleW failed: {e}");
                            let _ = tx.send(0);
                            return;
                        }
                    };
                    let class_name = w!("HighlighterNativeCaptureAnim");
                    let wc = WNDCLASSW {
                        style: CS_HREDRAW | CS_VREDRAW,
                        lpfnWndProc: Some(wndproc),
                        hInstance: hinstance,
                        lpszClassName: class_name,
                        ..Default::default()
                    };
                    // 已注册时返回 0；同进程只注册一次，忽略。
                    let _ = RegisterClassW(&wc);

                    let width = (rect.right - rect.left).max(WINDOW_W + 40);
                    let height = (rect.bottom - rect.top).max(WINDOW_H + 40);
                    let x = rect.left + 60;
                    let y = rect.top + 60;
                    let win_w = WINDOW_W.min(width - 120).max(160);
                    let win_h = WINDOW_H.min(height - 120).max(90);
                    let hwnd = match CreateWindowExW(
                        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                        class_name,
                        w!("Highlighter R0 native-capture animation"),
                        WS_POPUP | WS_VISIBLE,
                        x,
                        y,
                        win_w,
                        win_h,
                        None,
                        None,
                        Some(hinstance),
                        None,
                    ) {
                        Ok(h) => h,
                        Err(e) => {
                            logln!("[anim] CreateWindowExW failed: {e}");
                            let _ = tx.send(0);
                            return;
                        }
                    };
                    let _ = SetTimer(Some(hwnd), 1, 33, None);
                    let _ = tx.send(hwnd.0 as isize);
                    logln!(
                        "[anim] window created at ({x},{y}) {}x{} on monitor rect ({},{}..{}, {})",
                        win_w,
                        win_h,
                        rect.left,
                        rect.top,
                        rect.right,
                        rect.bottom
                    );
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                    logln!("[anim] window thread exited");
                }
            })
            .map_err(|e| format!("spawn anim thread failed: {e}"))?;
        match rx.recv_timeout(std::time::Duration::from_secs(3)) {
            Ok(0) => {
                let _ = join.join();
                Err("animation window creation failed (see log)".to_string())
            }
            Ok(hwnd) => Ok(Self {
                hwnd: HWND(hwnd as *mut core::ffi::c_void),
                join: Some(join),
            }),
            Err(e) => Err(format!("animation window did not become ready: {e}")),
        }
    }

    pub fn close(mut self) {
        unsafe {
            let _ = PostMessageW(Some(self.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}
