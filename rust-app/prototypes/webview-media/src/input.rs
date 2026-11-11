//! 真实 OS 输入注入（trusted user activation）与 Chromium CDP 备用路径。
//!
//! getDisplayMedia 需要 **transient user activation**。无人值守原型不能靠人点按钮，因此：
//! - 首选 **OS 输入**：`SetCursorPos` + `SendInput`（user32 注入，Chromium 视为 trusted 输入，
//!   页面事件 `isTrusted=true`，满足 user activation 要求）；`SetCursorPos` 在受限宿主里
//!   可能失败，此时改用 `SendInput(MOUSEEVENTF_MOVE|ABSOLUTE|VIRTUALDESK)` 直接移动光标；
//! - 备用 **CDP**：`ICoreWebView2::CallDevToolsProtocolMethod("Input.dispatchMouseEvent")`，
//!   DevTools 注入的输入同样计入 user activation，且不需要移动真实鼠标。
//!
//! 两者都只点击"窗口客户区中心"，页面在中心区域没有可交互控件，因此不会误触发产品行为。
//! `cursor_probe` 命令把两条路径的真实返回值/错误原文记录下来，作为 R0 证据。

use serde::Serialize;
use tauri::WebviewWindow;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use windows::core::HSTRING;
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, SendInput, INPUT, INPUT_0, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT, VK_ESCAPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetCursorPos, GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// 一次 OS 点击的完整诊断（写进报告；失败分支必须可复核）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsClickReport {
    pub hwnd: isize,
    pub client_size: [i32; 2],
    pub screen_point: [i32; 2],
    pub cursor_before: Option<[i32; 2]>,
    pub set_cursor_ok: bool,
    pub set_cursor_error: Option<String>,
    pub send_input_move_count: Option<u32>,
    pub send_input_move_error: Option<String>,
    pub cursor_after_move: Option<[i32; 2]>,
    pub click_down_count: u32,
    pub click_up_count: u32,
    pub click_error: Option<String>,
    pub cursor_after: Option<[i32; 2]>,
}

/// 只读光标诊断：不点击，只报告当前光标位置。
pub fn cursor_probe() -> serde_json::Value {
    let before = cursor_position();
    let mut set_cursor_ok = false;
    let mut set_cursor_error = None;
    if let Some(position) = before {
        match unsafe { SetCursorPos(position[0], position[1]) } {
            Ok(()) => set_cursor_ok = true,
            Err(error) => set_cursor_error = Some(format!("{error}")),
        }
    }
    let moved = unsafe { send_input_move(before.unwrap_or([0, 0])) };
    serde_json::json!({
        "cursorBefore": before,
        "setCursorPosOk": set_cursor_ok,
        "setCursorPosError": set_cursor_error,
        "sendInputMoveCount": moved.0,
        "sendInputMoveError": moved.1,
        "cursorAfter": cursor_position(),
    })
}

/// 点击窗口客户区中心（尽量使用真实 user32 输入）。
pub fn click_client_center(hwnd: HWND) -> Result<OsClickReport, String> {
    // SAFETY: 标准 user32 调用；hwnd 来自 Tauri（命令入口已校验窗口归属）。
    unsafe {
        let mut rect = RECT::default();
        GetClientRect(hwnd, &mut rect).map_err(|error| format!("GetClientRect: {error}"))?;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return Err(format!("GetClientRect: 客户区尺寸非正 {width}x{height}"));
        }
        let mut origin = POINT { x: 0, y: 0 };
        ClientToScreen(hwnd, &mut origin)
            .ok()
            .map_err(|error| format!("ClientToScreen: {error}"))?;
        let point = [origin.x + width / 2, origin.y + height / 2];
        let cursor_before = cursor_position();

        // 路径 1：SetCursorPos（在某些受限宿主里会失败，如实记录）。
        let set_cursor_result = SetCursorPos(point[0], point[1]);
        let (set_cursor_ok, set_cursor_error) = match set_cursor_result {
            Ok(()) => (true, None),
            Err(error) => (false, Some(format!("{error}"))),
        };

        // 路径 2：SetCursorPos 失败时用 SendInput 绝对定位（虚拟桌面坐标）。
        let mut send_input_move_count = None;
        let mut send_input_move_error = None;
        if !set_cursor_ok {
            let (count, error) = send_input_move(point);
            send_input_move_count = Some(count);
            send_input_move_error = error;
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
        let cursor_after_move = cursor_position();

        let (click_down_count, click_up_count, click_error) = send_input_click();
        std::thread::sleep(std::time::Duration::from_millis(150));
        Ok(OsClickReport {
            hwnd: hwnd.0 as isize,
            client_size: [width, height],
            screen_point: point,
            cursor_before,
            set_cursor_ok,
            set_cursor_error,
            send_input_move_count,
            send_input_move_error,
            cursor_after_move,
            click_down_count,
            click_up_count,
            click_error,
            cursor_after: cursor_position(),
        })
    }
}

fn mouse_input(
    dx: i32,
    dy: i32,
    flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// 用 SendInput 的绝对坐标移动光标（虚拟桌面归一化坐标）。
unsafe fn send_input_move(point: [i32; 2]) -> (u32, Option<String>) {
    // SAFETY: 标准 user32 SendInput；数组长度与 cbSize 匹配。
    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1);
        let nx = (((point[0] - vx) as f64) * 65535.0 / ((vw - 1) as f64)).round() as i32;
        let ny = (((point[1] - vy) as f64) * 65535.0 / ((vh - 1) as f64)).round() as i32;
        let flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        let input = mouse_input(nx, ny, flags);
        let sent = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        (sent, None)
    }
}

fn send_input_click() -> (u32, u32, Option<String>) {
    // SAFETY: 标准 user32 SendInput；两次独立送入按下/抬起。
    unsafe {
        let down = mouse_input(0, 0, MOUSEEVENTF_LEFTDOWN);
        let up = mouse_input(0, 0, MOUSEEVENTF_LEFTUP);
        let down_count = SendInput(&[down], std::mem::size_of::<INPUT>() as i32);
        std::thread::sleep(std::time::Duration::from_millis(40));
        let up_count = SendInput(&[up], std::mem::size_of::<INPUT>() as i32);
        (down_count, up_count, None)
    }
}

/// 读取当前鼠标位置（物理像素）。
pub fn cursor_position() -> Option<[i32; 2]> {
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: 标准 user32 只读查询。
    unsafe {
        GetCursorPos(&mut point).ok()?;
    }
    Some([point.x, point.y])
}

/// 把鼠标移回指定物理像素位置（收尾恢复）。
pub fn set_cursor(position: [i32; 2]) {
    // SAFETY: 标准 user32 调用；位置来自运行开始时的快照。
    unsafe {
        let _ = SetCursorPos(position[0], position[1]);
    }
}

/// 按一次 ESC（用于尝试关闭可能出现的原生选源 UI）。
pub fn press_escape() -> Result<(), String> {
    // SAFETY: 标准 user32 键盘注入。
    unsafe {
        keybd_event(VK_ESCAPE.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        std::thread::sleep(std::time::Duration::from_millis(30));
        keybd_event(VK_ESCAPE.0 as u8, 0, KEYEVENTF_KEYUP, 0);
    }
    Ok(())
}

/// 用 Chromium CDP 在 webview 的 CSS 坐标 (x, y) 派发一次真实鼠标点击。
///
/// 不移动系统鼠标、不需要窗口前台/焦点；CDP 输入同样产生 user activation。
pub fn cdp_click(window: &WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    let press = serde_json::json!({
        "type": "mousePressed",
        "x": x,
        "y": y,
        "button": "left",
        "buttons": 1,
        "clickCount": 1,
    });
    let release = serde_json::json!({
        "type": "mouseReleased",
        "x": x,
        "y": y,
        "button": "left",
        "buttons": 0,
        "clickCount": 1,
    });
    let (sender, receiver) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |platform| {
            // SAFETY: with_webview 保证在创建 WebView2 的 UI 线程执行。
            unsafe {
                let controller = platform.controller();
                let core = match controller.CoreWebView2() {
                    Ok(core) => core,
                    Err(error) => {
                        let _ = sender.send(Err(format!("CoreWebView2: {error}")));
                        return;
                    }
                };
                let outcome = dispatch_pair(&core, &press, &release);
                let _ = sender.send(outcome);
            }
        })
        .map_err(|error| format!("with_webview 调度失败: {error}"))?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "with_webview/CDP 10s 内未完成".to_string())?
}

fn dispatch_pair(
    core: &ICoreWebView2,
    press: &serde_json::Value,
    release: &serde_json::Value,
) -> Result<(), String> {
    let method = HSTRING::from("Input.dispatchMouseEvent");
    for payload in [press, release] {
        let json = HSTRING::from(payload.to_string());
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_error_code, _result| {
                Ok(())
            }));
        // SAFETY: core 来自 UI 线程；每次调用都传入独立的完成处理器。
        unsafe {
            core.CallDevToolsProtocolMethod(&method, &json, &handler)
                .map_err(|error| format!("CallDevToolsProtocolMethod: {error}"))?;
        }
    }
    Ok(())
}
