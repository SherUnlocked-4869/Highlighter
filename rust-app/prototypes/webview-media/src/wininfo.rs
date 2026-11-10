//! 顶层窗口枚举（证据：选源 UI / 透明浮层窗口是否出现、归属哪个进程）。
//!
//! 只读取窗口元数据，不注入、不改变目标窗口。

use serde::Serialize;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible,
};

/// 顶层窗口快照。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub hwnd: isize,
    pub pid: u32,
    pub process: Option<String>,
    pub class: String,
    pub title: String,
    pub visible: bool,
    /// `[left, top, right, bottom]`（物理像素，可为负）。
    pub rect: [i32; 4],
}

/// 枚举某个顶层窗口的全部子窗口（WebView2 的 UI/合成子窗口是 child HWND，
/// 只枚举顶层窗口会漏掉它们；"选源 UI 是否出现"需要这一层证据）。
pub fn enumerate_children(parent: HWND) -> Vec<WindowInfo> {
    let mut raw: Vec<HWND> = Vec::new();
    // SAFETY: 标准 EnumChildWindows；回调只收集 HWND。
    unsafe {
        let _ = EnumChildWindows(
            Some(parent),
            Some(collect_child),
            LPARAM(&mut raw as *mut Vec<HWND> as isize),
        );
    }
    raw.into_iter().map(window_info).collect()
}

unsafe extern "system" fn collect_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam 由 enumerate_children() 传入，指向有效的 Vec<HWND>。
    unsafe {
        let vector = &mut *(lparam.0 as *mut Vec<HWND>);
        vector.push(hwnd);
    }
    BOOL(1)
}

/// 枚举当前所有顶层窗口（过滤条件由调用方判断）。
pub fn enumerate() -> Vec<WindowInfo> {
    let mut raw: Vec<HWND> = Vec::new();
    // SAFETY: 标准 EnumWindows；回调只把 HWND 收集进 Vec，不跨线程共享。
    unsafe {
        let _ = EnumWindows(
            Some(collect_window),
            LPARAM(&mut raw as *mut Vec<HWND> as isize),
        );
    }
    raw.into_iter().map(window_info).collect()
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam 由 enumerate() 传入，指向有效的 Vec<HWND>。
    unsafe {
        let vector = &mut *(lparam.0 as *mut Vec<HWND>);
        vector.push(hwnd);
    }
    BOOL(1)
}

fn window_info(hwnd: HWND) -> WindowInfo {
    let mut pid = 0u32;
    // SAFETY: 只读查询。
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
    }
    let class = read_window_text(hwnd, true);
    let title = read_window_text(hwnd, false);
    let mut rect = RECT::default();
    // SAFETY: 只读查询。
    let visible = unsafe { IsWindowVisible(hwnd).as_bool() };
    let rect_ok = unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok();
    WindowInfo {
        hwnd: hwnd.0 as isize,
        pid,
        process: process_name(pid),
        class,
        title,
        visible,
        rect: if rect_ok {
            [rect.left, rect.top, rect.right, rect.bottom]
        } else {
            [0, 0, 0, 0]
        },
    }
}

fn read_window_text(hwnd: HWND, class: bool) -> String {
    let mut buffer = [0u16; 512];
    // SAFETY: 缓冲区长度匹配。
    let length = unsafe {
        if class {
            GetClassNameW(hwnd, &mut buffer)
        } else {
            GetWindowTextW(hwnd, &mut buffer)
        }
    };
    if length <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..length as usize])
}

fn process_name(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    // SAFETY: OpenProcess 失败返回 None；句柄用 CloseHandle 释放。
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        let path = OsString::from_wide(&buffer[..size as usize])
            .to_string_lossy()
            .to_string();
        Some(
            path.rsplit(['\\', '/'])
                .next()
                .unwrap_or(path.as_str())
                .to_string(),
        )
    }
}
