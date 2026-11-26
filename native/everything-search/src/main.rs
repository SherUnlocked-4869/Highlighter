//! Highlighter Everything sidecar.
//!
//! Speaks newline-delimited JSON over stdin/stdout (same contract as the OCR
//! sidecar): requests are `{id, action, ...params}` objects, responses are
//! `{id, ok, result?, error?}`.
//!
//! Everything is reached through its window-message IPC (Everything 1.4 and
//! 1.5). Two constraints shape the implementation:
//!
//! 1. Multiple Everything instances may register the IPC window class at the
//!    same time (for example the user's own instance plus one spawned by
//!    another tool). The first window found via FindWindow may be a
//!    permission-less instance whose index is empty, so all candidates are
//!    enumerated and the one that actually answers queries with content wins.
//! 2. When Everything runs elevated, `WM_USER` probes (version / db-loaded)
//!    are filtered by UIPI while `WM_COPYDATA` queries still work. A query
//!    probe is therefore the authoritative readiness signal.

use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::COPYDATASTRUCT;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, EnumWindows, GetClassNameW,
    GetMessageW, GetWindowLongPtrW, IsWindow, GWLP_USERDATA, PostMessageW, RegisterClassW,
    SendMessageTimeoutW, SetWindowLongPtrW, SMTO_ABORTIFHUNG, SMTO_BLOCK, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_APP, WM_COPYDATA, WM_DESTROY, WM_QUIT,
};

const EVERYTHING_WM_IPC: u32 = 0x0400; // WM_USER
const IPC_CLASS_PREFIX: &str = "EVERYTHING_TASKBAR_NOTIFICATION";

const COPYDATA_QUERY2W: u32 = 18;
const IPC_GET_MAJOR_VERSION: u32 = 0;
const IPC_GET_MINOR_VERSION: u32 = 1;
const IPC_GET_BUILD_NUMBER: u32 = 3;
const IPC_IS_DB_LOADED: u32 = 401;

// Request flags (EVERYTHING_IPC_QUERY2). Highlighted strings surround matches
// with the unit separator control character (0x1F).
const REQ_FILE_NAME: u32 = 0x0000_0001;
const REQ_PATH: u32 = 0x0000_0002;
const REQ_EXTENSION: u32 = 0x0000_0008;
const REQ_SIZE: u32 = 0x0000_0010;
const REQ_DATE_MODIFIED: u32 = 0x0000_0040;
const REQ_HIGHLIGHTED_NAME: u32 = 0x0000_2000;
const REQ_HIGHLIGHTED_PATH: u32 = 0x0000_4000;
/// Canonical flag order (ascending bit value) — result data follows this order.
const REQUEST_FLAGS_ORDER: [(u32, &str); 7] = [
    (REQ_FILE_NAME, "name"),
    (REQ_PATH, "path"),
    (REQ_EXTENSION, "extension"),
    (REQ_SIZE, "size"),
    (REQ_DATE_MODIFIED, "modifiedAt"),
    (REQ_HIGHLIGHTED_NAME, "highlightedName"),
    (REQ_HIGHLIGHTED_PATH, "highlightedPath"),
];

const SEARCH_MATCH_PATH: u32 = 0x0000_0004;

const SORT_NAME_ASC: u32 = 1;
const SORT_NAME_DESC: u32 = 2;
const SORT_PATH_ASC: u32 = 3;
const SORT_PATH_DESC: u32 = 4;
const SORT_SIZE_ASC: u32 = 5;
const SORT_SIZE_DESC: u32 = 6;
const SORT_DATE_MODIFIED_ASC: u32 = 13;
const SORT_DATE_MODIFIED_DESC: u32 = 14;

const PROBE_SEARCH: &str = "*.exe";
const PROBE_TIMEOUT_MS: u32 = 1500;
const PROBE_FLAGS: u32 = REQ_FILE_NAME;
const QUERY_TIMEOUT_DEFAULT_MS: u64 = 5000;
const QUERY_TIMEOUT_MAX_MS: u64 = 15000;
const WAIT_READY_DEFAULT_MS: u64 = 30000;
const WAIT_READY_MAX_MS: u64 = 120000;
const WAIT_READY_POLL_INTERVAL: Duration = Duration::from_millis(300);
const MAX_PROBED_WINDOWS: usize = 6;

static NEXT_QUERY_ID: AtomicU32 = AtomicU32::new(1);

// F04: `OpenProcess` / `QueryFullProcessImageNameW` live in the windows crate's
// `Win32_System_Threading` module, a feature this crate does not enable. These
// kernel32 exports have a stable ABI, so bind them directly instead of widening
// the dependency feature set.
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> isize;
    fn QueryFullProcessImageNameW(process: isize, flags: u32, exe_name: *mut u16, size: *mut u32) -> i32;
    fn CloseHandle(object: isize) -> i32;
}

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x0000_1000;
const PROCESS_PATH_MAX_UNITS: usize = 32_768;

// ==================== Reply window ====================

struct QueryTask {
    target: isize,
    /// The value written to `EVERYTHING_IPC_QUERY2.reply_copydata_message`
    /// (offset 4 of the request; the review report calls this `dwId`).
    /// Everything echoes it back as the reply `COPYDATASTRUCT.dwData`, which is
    /// the only per-query correlation field in the protocol —
    /// `EVERYTHING_IPC_LIST2` itself has no id member (its dwords are
    /// totitems/numitems/offset/request_flags/sort_type).
    query_id: u32,
    buffer: Vec<u8>,
    timeout_ms: u32,
    tx: mpsc::Sender<Result<Vec<u8>, String>>,
}

struct ReplyState {
    /// The one in-flight forwarded query; cleared when the reply arrives,
    /// when forwarding fails, or when the caller times out.
    pending: Mutex<Option<QueryTask>>,
}

impl ReplyState {
    /// Moves out the pending task only when the reply id matches it.
    ///
    /// Everything sends a query reply as WM_COPYDATA whose `dwData` echoes the
    /// request's `reply_copydata_message`. A late reply from a query that already
    /// timed out carries a different id: returning `None` (and leaving `pending`
    /// untouched) is what keeps it from overwriting the current query's result.
    fn take_reply(&self, reply_id: u32) -> Option<QueryTask> {
        let mut guard = self.pending.lock().unwrap();
        if !matches!(guard.as_ref(), Some(pending) if pending.query_id == reply_id) {
            return None;
        }
        guard.take()
    }
}

struct ReplyWindow {
    hwnd: isize,
    state: Arc<ReplyState>,
}

unsafe extern "system" fn reply_wndproc(hwnd: HWND, msg: u32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const ReplyState;
    match msg {
        WM_APP => {
            if state_ptr.is_null() {
                return LRESULT(0);
            }
            let task = Box::from_raw(w_param.0 as *mut QueryTask);
            let state = &*state_ptr;
            let previous = state.pending.lock().unwrap().replace(*task);
            if let Some(stale) = previous {
                stale.tx.send(Err("overrun".to_string())).ok();
            }
            let (target, timeout_ms, buffer) = {
                let guard = state.pending.lock().unwrap();
                let pending = guard.as_ref().unwrap();
                (pending.target, pending.timeout_ms, pending.buffer.clone())
            };
            let copydata = COPYDATASTRUCT {
                dwData: COPYDATA_QUERY2W as usize,
                cbData: buffer.len() as u32,
                lpData: buffer.as_ptr() as *mut _,
            };
            let mut result: usize = 0;
            // Without SMTO_BLOCK the thread keeps processing incoming sent
            // messages, so a synchronous reply is delivered re-entrantly.
            let sent = SendMessageTimeoutW(
                HWND(target as *mut _),
                WM_COPYDATA,
                WPARAM(hwnd.0 as usize),
                LPARAM(&copydata as *const COPYDATASTRUCT as isize),
                SMTO_ABORTIFHUNG,
                timeout_ms,
                Some(&mut result),
            );
            if sent.0 == 0 {
                if let Some(failed) = state.pending.lock().unwrap().take() {
                    failed.tx.send(Err("send-failed".to_string())).ok();
                }
            }
            // A successful forward may still be answered asynchronously; the
            // message pump below delivers the WM_COPYDATA whenever it shows up.
            LRESULT(1)
        }
        WM_COPYDATA => {
            if state_ptr.is_null() {
                return LRESULT(0);
            }
            let state = &*state_ptr;
            let copydata = &*(l_param.0 as *const COPYDATASTRUCT);
            // Everything answers an EVERYTHING_IPC_QUERY2 with a WM_COPYDATA
            // whose dwData echoes the request's reply_copydata_message (our
            // query id). Do not look for an id inside EVERYTHING_IPC_LIST2:
            // that structure has no dwId member (bytes 8..12 are the result
            // list's `offset`, which is 0 for every request we send).
            let reply_id = copydata.dwData as u32;
            let pending = match state.take_reply(reply_id) {
                Some(pending) => pending,
                // A late reply for a query that already timed out (or was
                // abandoned). Drop it instead of taking the current pending
                // task, which would overwrite the in-flight query's result.
                None => return LRESULT(0),
            };
            let data = std::slice::from_raw_parts(copydata.lpData as *const u8, copydata.cbData as usize).to_vec();
            pending.tx.send(Ok(data)).ok();
            LRESULT(1)
        }
        WM_DESTROY => {
            let _ = PostMessageW(Some(hwnd), WM_QUIT, WPARAM(0), LPARAM(0));
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, w_param, l_param),
    }
}

fn spawn_reply_window() -> Result<ReplyWindow, String> {
    let state = Arc::new(ReplyState { pending: Mutex::new(None) });
    let (tx, rx) = mpsc::channel::<isize>();
    let thread_state = Arc::clone(&state);
    std::thread::spawn(move || unsafe {
        let instance = GetModuleHandleW(PCWSTR::null()).unwrap_or_default();
        let class_name: Vec<u16> = "HighlighterEverythingReply\0".encode_utf16().collect();
        let class = windows::Win32::UI::WindowsAndMessaging::WNDCLASSW {
            lpfnWndProc: Some(reply_wndproc),
            hInstance: instance.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            let _ = tx.send(0);
            return;
        }
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            None,
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            None,
        );
        let hwnd = match hwnd {
            Ok(handle) if !handle.is_invalid() => handle,
            _ => {
                let _ = tx.send(0);
                return;
            }
        };
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, Arc::into_raw(thread_state) as isize);
        let _ = tx.send(hwnd.0 as isize);
        let mut message = windows::Win32::UI::WindowsAndMessaging::MSG::default();
        loop {
            let result = GetMessageW(&mut message, Some(hwnd), 0, 0);
            if result.0 <= 0 {
                break;
            }
            DispatchMessageW(&mut message);
        }
    });
    let hwnd = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "reply window thread failed".to_string())?;
    if hwnd == 0 {
        return Err("failed to create reply window".to_string());
    }
    Ok(ReplyWindow { hwnd, state })
}

impl ReplyWindow {
    fn send_copydata(&self, target: isize, buffer: Vec<u8>, query_id: u32, timeout_ms: u32) -> Result<Vec<u8>, String> {
        let (tx, rx) = mpsc::channel();
        let task = Box::new(QueryTask {
            target,
            query_id,
            buffer,
            timeout_ms,
            tx,
        });
        let task_ptr = Box::into_raw(task);
        let posted = unsafe {
            PostMessageW(
                Some(HWND(self.hwnd as *mut _)),
                WM_APP,
                WPARAM(task_ptr as usize),
                LPARAM(0),
            )
        };
        if posted.is_err() {
            drop(unsafe { Box::from_raw(task_ptr) });
            return Err("send-failed".to_string());
        }
        match rx.recv_timeout(Duration::from_millis(u64::from(timeout_ms) + 4000)) {
            Ok(result) => result,
            Err(_) => {
                // Cancel the pending task so a late reply is not misdelivered.
                self.state.pending.lock().unwrap().take();
                Err("timeout".to_string())
            }
        }
    }
}

// ==================== Everything IPC ====================

fn enumerate_ipc_windows() -> Vec<(isize, String)> {
    let mut results: Vec<(isize, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut results as *mut _ as isize),
        );
    }
    results
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, l_param: LPARAM) -> BOOL {
    let results = &mut *(l_param.0 as *mut Vec<(isize, String)>);
    let mut buffer = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buffer);
    if len > 0 {
        let class_name = String::from_utf16_lossy(&buffer[..len as usize]);
        if class_name.starts_with(IPC_CLASS_PREFIX) && results.len() < MAX_PROBED_WINDOWS {
            results.push((hwnd.0 as isize, class_name));
        }
    }
    BOOL(1)
}

/// Send a `WM_USER` command; returns `None` when the target did not answer
/// (missing instance, or blocked by UIPI when Everything runs elevated).
fn send_ipc_command(hwnd: isize, command: u32) -> Option<usize> {
    let mut result: usize = 0;
    let sent = unsafe {
        SendMessageTimeoutW(
            HWND(hwnd as *mut _),
            EVERYTHING_WM_IPC,
            WPARAM(command as usize),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            PROBE_TIMEOUT_MS,
            Some(&mut result),
        )
    };
    if sent.0 == 0 {
        None
    } else {
        Some(result)
    }
}

/// Builds an `EVERYTHING_IPC_QUERY2` buffer and returns it together with the
/// reply id (`reply_copydata_message`) that Everything will echo in the reply
/// `COPYDATASTRUCT.dwData`.
fn build_query_buffer(
    reply_hwnd: isize,
    search: &str,
    search_flags: u32,
    request_flags: u32,
    sort: u32,
    offset: u32,
    max_results: u32,
) -> (Vec<u8>, u32) {
    let id = NEXT_QUERY_ID.fetch_add(1, Ordering::Relaxed);
    let mut buffer = Vec::with_capacity(30 + search.len() * 2);
    buffer.extend_from_slice(&(reply_hwnd as u32).to_le_bytes());
    buffer.extend_from_slice(&id.to_le_bytes());
    buffer.extend_from_slice(&search_flags.to_le_bytes());
    buffer.extend_from_slice(&offset.to_le_bytes());
    buffer.extend_from_slice(&max_results.to_le_bytes());
    buffer.extend_from_slice(&request_flags.to_le_bytes());
    buffer.extend_from_slice(&sort.to_le_bytes());
    for unit in search.encode_utf16() {
        buffer.extend_from_slice(&unit.to_le_bytes());
    }
    buffer.extend_from_slice(&0u16.to_le_bytes());
    (buffer, id)
}

fn probe_window(reply: &ReplyWindow, hwnd: isize) -> Result<u32, String> {
    let (buffer, query_id) = build_query_buffer(reply.hwnd, PROBE_SEARCH, 0, PROBE_FLAGS, SORT_NAME_ASC, 0, 1);
    let data = reply.send_copydata(hwnd, buffer, query_id, PROBE_TIMEOUT_MS)?;
    if data.len() < 4 {
        return Err("bad-reply".to_string());
    }
    Ok(u32::from_le_bytes(data[0..4].try_into().unwrap()))
}

struct TargetInfo {
    hwnd: isize,
    class_name: String,
    version: Option<(u32, u32, u32, u32)>,
    db_loaded: bool,
    probe_total: u32,
}

/// Pick the candidate most likely to hold the user's real index: windows that
/// answer a probe query with content rank first, fully accessible (same
/// integrity level, index loaded) windows rank next.
fn resolve_target(reply: &ReplyWindow) -> Option<TargetInfo> {
    let candidates = enumerate_ipc_windows();
    let mut best: Option<(i64, TargetInfo)> = None;
    // A window carrying Everything's exclusive IPC class proves an instance is
    // running even when both probe channels stay silent (UIPI filters them
    // when Everything runs elevated and the instance does not re-allow
    // WM_COPYDATA). Keep the first fully silent candidate so status can still
    // report `running` — only its version/db are unknowable.
    let mut silent_fallback: Option<TargetInfo> = None;
    for (hwnd, class_name) in candidates {
        let minor = send_ipc_command(hwnd, IPC_GET_MINOR_VERSION);
        let version = minor.map(|_| {
            let major = send_ipc_command(hwnd, IPC_GET_MAJOR_VERSION).unwrap_or(0) as u32;
            let minor_version = minor.unwrap_or(0) as u32;
            let revision = send_ipc_command(hwnd, 2).unwrap_or(0) as u32;
            let build = send_ipc_command(hwnd, IPC_GET_BUILD_NUMBER).unwrap_or(0) as u32;
            (major, minor_version, revision, build)
        });
        let ipc_available = matches!(minor, Some(value) if value >= 4);
        let db_loaded = send_ipc_command(hwnd, IPC_IS_DB_LOADED).unwrap_or(0) != 0;
        let probe_result = probe_window(reply, hwnd);
        let probe_total = probe_result.as_ref().copied().unwrap_or(0);
        let probe_failed = matches!(&probe_result, Err(message) if message == "send-failed");
        if !ipc_available && version.is_none() && probe_total == 0 && probe_failed {
            if silent_fallback.is_none() {
                silent_fallback = Some(TargetInfo {
                    hwnd,
                    class_name,
                    version: None,
                    db_loaded: false,
                    probe_total: 0,
                });
            }
            continue;
        }
        let content_score = i64::from(probe_total.min(100));
        let score: i64 = if probe_total > 0 {
            2000 + content_score + if ipc_available && db_loaded { 10 } else { 0 }
        } else if ipc_available && db_loaded {
            200
        } else if ipc_available || version.is_some() {
            100
        } else if !probe_failed {
            // WM_COPYDATA answered (possibly across an integrity level) but
            // the index holds no files yet.
            20
        } else {
            0
        };
        if score == 0 {
            continue;
        }
        let candidate = (score, TargetInfo { hwnd, class_name, version, db_loaded: db_loaded || probe_total > 0, probe_total });
        if best.as_ref().is_none_or(|(best_score, _)| score > *best_score) {
            best = Some(candidate);
        }
    }
    best.map(|(_, info)| info).or(silent_fallback)
}

// ==================== Query target cache ====================

/// F04: the cached Everything IPC window is reused for every following query.
/// Before this, each `"query"` ran `resolve_target`: an `EnumWindows` sweep of
/// every top-level window plus five `WM_USER` probes and one `*.exe` COPYDATA
/// probe per candidate — two of those per keystroke in match-path mode.
fn is_window_live(hwnd: isize) -> bool {
    // SAFETY: IsWindow only inspects a handle value; a stale handle is reported
    // as BOOL(FALSE), never dereferenced.
    unsafe { IsWindow(Some(HWND(hwnd as *mut _))).as_bool() }
}

fn is_communication_failure(error: &Value) -> bool {
    // `send_copydata` reports a failed SendMessageTimeoutW as "send-failed" and
    // a missing WM_COPYDATA reply as "timeout"; both mean the cached handle is
    // no longer answering. "bad-reply" means it did answer, so the cache stays.
    matches!(error.get("code").and_then(Value::as_str), Some("send-failed" | "timeout"))
}

/// Runs one query against the cached window when it is still a live window; only
/// a dead handle or a communication failure triggers exactly one `resolve_target`
/// re-probe. `is_live` / `resolve` / `attempt` are injected so the cache policy
/// is unit-testable without a message pump.
fn run_query_cached<T, F, R>(
    cache: &mut Option<TargetInfo>,
    is_live: impl Fn(isize) -> bool,
    mut resolve: R,
    mut attempt: F,
) -> Result<T, Value>
where
    F: FnMut(isize) -> Result<T, Value>,
    R: FnMut() -> Option<TargetInfo>,
{
    if let Some(hwnd) = cache.as_ref().map(|target| target.hwnd) {
        if is_live(hwnd) {
            match attempt(hwnd) {
                Ok(result) => return Ok(result),
                Err(error) if is_communication_failure(&error) => {
                    *cache = None;
                }
                Err(error) => return Err(error),
            }
        } else {
            // Everything restarted or closed: the handle no longer identifies a
            // live window, so reusing it would report a misleading failure.
            *cache = None;
        }
    }
    let target = match resolve() {
        Some(target) => target,
        None => {
            return Err(json!({ "code": "not-running", "message": "IPC window not found" }));
        }
    };
    let hwnd = target.hwnd;
    *cache = Some(target);
    let result = attempt(hwnd);
    if matches!(&result, Err(error) if is_communication_failure(error)) {
        *cache = None;
    }
    result
}

fn query_with_cache(reply: &ReplyWindow, cache: &mut Option<TargetInfo>, params: &Value) -> Result<Value, Value> {
    run_query_cached(cache, is_window_live, || resolve_target(reply), |hwnd| {
        run_query(reply, hwnd, params)
    })
}

// ==================== Process image path ====================

/// F04: resolve a pid to its executable path with QueryFullProcessImageNameW
/// (sub-millisecond) instead of a cold-started PowerShell + WMI query
/// (hundreds of milliseconds to seconds). Errors are typed strings and never
/// panic; the JS service treats them as "unverifiable", refuses to kill that pid
/// and logs the failure.
fn query_process_image_path(pid: u32) -> Result<String, &'static str> {
    if pid == 0 {
        return Err("invalid-pid");
    }
    // SAFETY: the handle comes from OpenProcess and is closed on every path; the
    // buffer is live for the call and the API writes back its used length.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process == 0 {
            return Err("process-open-failed");
        }
        let mut buffer = vec![0u16; PROCESS_PATH_MAX_UNITS];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        let _ = CloseHandle(process);
        if ok == 0 || length == 0 || length as usize > buffer.len() {
            return Err("process-path-failed");
        }
        Ok(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

fn process_path_result(pid: Option<u64>) -> Result<Value, Value> {
    let Some(pid) = pid.and_then(|value| u32::try_from(value).ok()).filter(|pid| *pid != 0) else {
        return Err(json!({ "code": "invalid-pid", "message": "无效的进程 ID" }));
    };
    query_process_image_path(pid)
        .map(|path| json!({ "path": path }))
        .map_err(|code| json!({ "code": code, "message": "无法获取进程映像路径" }))
}

// ==================== Query execution ====================

fn parse_sort(mode: &str) -> u32 {
    match mode {
        "name-asc" => SORT_NAME_ASC,
        "name-desc" => SORT_NAME_DESC,
        "path-asc" => SORT_PATH_ASC,
        "path-desc" => SORT_PATH_DESC,
        "size-asc" => SORT_SIZE_ASC,
        "size-desc" => SORT_SIZE_DESC,
        "modified-asc" => SORT_DATE_MODIFIED_ASC,
        _ => SORT_DATE_MODIFIED_DESC,
    }
}

fn filetime_to_unix_ms(raw: u64) -> Option<u64> {
    if raw == 0 {
        return None;
    }
    // FILETIME is 100ns ticks since 1601-01-01; shift to Unix epoch milliseconds.
    Some((raw / 10_000).saturating_sub(11_644_473_600_000))
}

fn read_u16_string(data: &[u8], cursor: &mut usize) -> Option<String> {
    if *cursor + 4 > data.len() {
        return None;
    }
    let len = u32::from_le_bytes(data[*cursor..*cursor + 4].try_into().ok()?) as usize;
    *cursor += 4;
    let bytes = (len + 1) * 2;
    if *cursor + bytes > data.len() {
        return None;
    }
    let units: Vec<u16> = data[*cursor..*cursor + len * 2]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    *cursor += bytes;
    Some(String::from_utf16_lossy(&units))
}

fn read_u64(data: &[u8], cursor: &mut usize) -> Option<u64> {
    if *cursor + 8 > data.len() {
        return None;
    }
    let value = u64::from_le_bytes(data[*cursor..*cursor + 8].try_into().ok()?);
    *cursor += 8;
    Some(value)
}

fn parse_reply(data: &[u8], expected_flags: u32) -> Result<(u32, Vec<Value>), String> {
    if data.len() < 20 {
        return Err("bad-reply".to_string());
    }
    let total = u32::from_le_bytes(data[0..4].try_into().unwrap());
    let num_items = u32::from_le_bytes(data[4..8].try_into().unwrap());
    let reply_flags = u32::from_le_bytes(data[12..16].try_into().unwrap()) & expected_flags;
    let mut items = Vec::with_capacity(num_items as usize);
    for index in 0..num_items as usize {
        let item_header = 20 + index * 8;
        if item_header + 8 > data.len() {
            return Err("bad-reply".to_string());
        }
        let mut cursor = u32::from_le_bytes(data[item_header + 4..item_header + 8].try_into().unwrap()) as usize;
        if cursor >= data.len() {
            return Err("bad-reply".to_string());
        }
        let mut fields = vec![(String::new(), Value::Null); REQUEST_FLAGS_ORDER.len()];
        for (flag, key) in REQUEST_FLAGS_ORDER {
            if reply_flags & flag == 0 {
                continue;
            }
            let value = match flag {
                REQ_SIZE => read_u64(data, &mut cursor).map(Value::from).unwrap_or(Value::Null),
                REQ_DATE_MODIFIED => read_u64(data, &mut cursor)
                    .and_then(filetime_to_unix_ms)
                    .map(Value::from)
                    .unwrap_or(Value::Null),
                _ => read_u16_string(data, &mut cursor).map(Value::from).unwrap_or(Value::Null),
            };
            let position = REQUEST_FLAGS_ORDER.iter().position(|(f, _)| *f == flag).unwrap();
            fields[position] = (key.to_string(), value);
        }
        let mut object = serde_json::Map::new();
        for (key, value) in fields {
            object.insert(key, value);
        }
        let name = object.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let path = object.get("path").and_then(Value::as_str).unwrap_or("").to_string();
        let full_path = if path.ends_with('\\') || path.ends_with('/') {
            format!("{path}{name}")
        } else {
            format!("{path}\\{name}")
        };
        object.insert("fullPath".to_string(), Value::from(full_path));
        items.push(Value::Object(object));
    }
    Ok((total, items))
}

fn run_query(reply: &ReplyWindow, target_hwnd: isize, params: &Value) -> Result<Value, Value> {
    let search = params.get("search").and_then(Value::as_str).unwrap_or("");
    let max_results = params
        .get("maxResults")
        .and_then(Value::as_u64)
        .unwrap_or(600)
        .clamp(1, 2000) as u32;
    let match_path = params.get("matchPath").and_then(Value::as_bool).unwrap_or(false);
    let sort = parse_sort(params.get("sortMode").and_then(Value::as_str).unwrap_or("modified-desc"));
    let timeout_ms = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .map(|value| value.min(QUERY_TIMEOUT_MAX_MS))
        .unwrap_or(QUERY_TIMEOUT_DEFAULT_MS) as u32;
    let request_flags = REQ_FILE_NAME
        | REQ_PATH
        | REQ_EXTENSION
        | REQ_SIZE
        | REQ_DATE_MODIFIED
        | REQ_HIGHLIGHTED_NAME
        | REQ_HIGHLIGHTED_PATH;
    let search_flags = if match_path { SEARCH_MATCH_PATH } else { 0 };
    let (buffer, query_id) = build_query_buffer(
        reply.hwnd,
        search,
        search_flags,
        request_flags,
        sort,
        0,
        max_results,
    );
    let data = reply
        .send_copydata(target_hwnd, buffer, query_id, timeout_ms)
        .map_err(|message| json!({ "code": message, "message": "Everything 查询失败" }))?;
    let (total, items) = parse_reply(&data, request_flags).map_err(|message| {
        json!({ "code": "bad-reply", "message": message })
    })?;
    Ok(json!({ "total": total, "items": items }))
}

fn status_value(reply: &ReplyWindow) -> Value {
    match resolve_target(reply) {
        None => json!({ "running": false, "dbLoaded": false, "version": null, "instance": null }),
        Some(info) => {
            let version = info.version
                .map(|(major, minor, revision, build)| format!("{major}.{minor}.{revision}.{build}"));
            let instance = info
                .class_name
                .strip_prefix(&format!("{IPC_CLASS_PREFIX}("))
                .and_then(|rest| rest.strip_suffix(')'))
                .map(str::to_string);
            json!({
                "running": true,
                "ipcAvailable": info.version.is_some(),
                "dbLoaded": info.db_loaded || info.probe_total > 0,
                "version": version,
                "instance": instance,
                "probeTotal": info.probe_total,
            })
        }
    }
}

fn wait_ready(reply: &ReplyWindow, params: &Value) -> Value {
    let timeout_ms = params
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .map(|value| value.min(WAIT_READY_MAX_MS))
        .unwrap_or(WAIT_READY_DEFAULT_MS);
    let start = Instant::now();
    let deadline = start + Duration::from_millis(timeout_ms);
    loop {
        let current = status_value(reply);
        let ready = current["running"].as_bool().unwrap_or(false)
            && current["dbLoaded"].as_bool().unwrap_or(false);
        if ready || Instant::now() >= deadline {
            return json!({
                "ready": ready,
                "elapsedMs": start.elapsed().as_millis() as u64,
                "status": current,
            });
        }
        std::thread::sleep(WAIT_READY_POLL_INTERVAL);
    }
}

fn write_response(id: &Value, ok: bool, error: Option<Value>, result: Option<Value>) {
    let response = json!({ "id": id, "ok": ok, "result": result, "error": error });
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    if let Err(error) = writeln!(handle, "{response}") {
        eprintln!("failed to write response: {error}");
        return;
    }
    let _ = handle.flush();
}

fn main() {
    let reply = match spawn_reply_window() {
        Ok(reply) => reply,
        Err(error) => {
            eprintln!("failed to start Everything bridge: {error}");
            return;
        }
    };
    {
        // Same startup handshake as the OCR sidecar.
        let stdout = std::io::stdout();
        let mut handle = stdout.lock();
        let _ = writeln!(handle, "{}", json!({ "type": "ready" }));
        let _ = handle.flush();
    }
    let stdin = std::io::stdin();
    // F04: resolved once and reused while the HWND stays a live window.
    let mut cached_target: Option<TargetInfo> = None;
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(error) => {
                write_response(
                    &Value::Null,
                    false,
                    Some(json!({ "code": "bad-request", "message": error.to_string() })),
                    None,
                );
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let action = request.get("action").and_then(Value::as_str).unwrap_or("");
        match action {
            "status" => write_response(&id, true, None, Some(status_value(&reply))),
            "probe-all" => {
                let candidates = enumerate_ipc_windows();
                let details: Vec<Value> = candidates.iter().map(|(hwnd, class_name)| {
                    let version = send_ipc_command(*hwnd, IPC_GET_MINOR_VERSION);
                    let probe_result = probe_window(&reply, *hwnd);
                    json!({
                        "hwnd": hwnd,
                        "class": class_name,
                        "versionProbe": version,
                        "dbLoaded": send_ipc_command(*hwnd, IPC_IS_DB_LOADED).unwrap_or(0) != 0,
                        "probe": match probe_result {
                            Ok(total) => json!({ "ok": true, "total": total }),
                            Err(error) => json!({ "ok": false, "error": error }),
                        },
                    })
                }).collect();
                write_response(&id, true, None, Some(json!({ "candidates": details })));
            }
            "wait-ready" => write_response(&id, true, None, Some(wait_ready(&reply, &request))),
            "query" => {
                let outcome = query_with_cache(&reply, &mut cached_target, &request);
                match outcome {
                    Ok(result) => write_response(&id, true, None, Some(result)),
                    Err(error) => write_response(&id, false, Some(error), None),
                }
            }
            "process-path" => {
                let pid = request.get("pid").and_then(Value::as_u64);
                match process_path_result(pid) {
                    Ok(result) => write_response(&id, true, None, Some(result)),
                    Err(error) => write_response(&id, false, Some(error), None),
                }
            }
            "shutdown" => {
                write_response(&id, true, None, Some(json!({ "bye": true })));
                break;
            }
            other => {
                write_response(
                    &id,
                    false,
                    Some(json!({ "code": "unknown-action", "message": format!("unknown action: {other}") })),
                    None,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query_task(query_id: u32) -> QueryTask {
        let (tx, _rx) = mpsc::channel();
        QueryTask {
            target: 0,
            query_id,
            buffer: Vec::new(),
            timeout_ms: 1,
            tx,
        }
    }

    // H04: the review report claims EVERYTHING_IPC_LIST2 carries a dwId at
    // offset 8..12. The official Everything.h has no such member: the reply id
    // travels in COPYDATASTRUCT.dwData, and the list header is
    // totitems(0)/numitems(4)/offset(8)/request_flags(12)/sort_type(16).
    #[test]
    fn h04_query_buffer_carries_reply_id_at_offset_four() {
        let (buffer, query_id) = build_query_buffer(0x1234_5678, "中文", 0, REQ_FILE_NAME, SORT_NAME_ASC, 0, 5);
        assert_ne!(query_id, 0);
        assert_eq!(u32::from_le_bytes(buffer[0..4].try_into().unwrap()), 0x1234_5678);
        // reply_copydata_message: Everything echoes this in the reply dwData.
        assert_eq!(u32::from_le_bytes(buffer[4..8].try_into().unwrap()), query_id);
        // The dwords a LIST2 reply reuses at 8/12/16 are not an id.
        assert_eq!(u32::from_le_bytes(buffer[8..12].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(buffer[12..16].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(buffer[20..24].try_into().unwrap()), REQ_FILE_NAME);
        let units: Vec<u16> = buffer[28..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(String::from_utf16_lossy(&units[..2]), "中文");
    }

    // H04: a late reply from a query that already timed out must be dropped
    // without disturbing the query that is now in flight.
    #[test]
    fn h04_take_reply_drops_late_reply_with_mismatched_id() {
        let state = ReplyState { pending: Mutex::new(Some(query_task(7))) };
        assert!(state.take_reply(6).is_none());
        assert_eq!(
            state.pending.lock().unwrap().as_ref().map(|task| task.query_id),
            Some(7),
            "a mismatched reply must not clear the in-flight query"
        );
        let taken = state.take_reply(7).expect("the matching reply is delivered");
        assert_eq!(taken.query_id, 7);
        assert!(state.pending.lock().unwrap().is_none());
    }

    #[test]
    fn h04_take_reply_ignores_reply_without_pending_query() {
        let state = ReplyState { pending: Mutex::new(None) };
        assert!(state.take_reply(1).is_none());
    }

    // ===================== F04: cached query target =====================

    fn target(hwnd: isize) -> TargetInfo {
        TargetInfo {
            hwnd,
            class_name: format!("{IPC_CLASS_PREFIX}(1.4)"),
            version: Some((1, 4, 1, 1032)),
            db_loaded: true,
            probe_total: 10,
        }
    }

    // F04: the review report's first finding is that every query re-ran
    // resolve_target (EnumWindows + 5 WM_USER probes + one `*.exe` COPYDATA
    // probe). With a live cached HWND the second query must attempt the cached
    // window directly and never call the resolver.
    #[test]
    fn f04_query_reuses_live_cached_target_without_resolving() {
        let mut cache = Some(target(0x1111));
        let mut resolve_calls = 0;
        let mut attempted = Vec::new();
        let result: Result<(), Value> = run_query_cached(
            &mut cache,
            |hwnd| hwnd == 0x1111,
            || {
                resolve_calls += 1;
                Some(target(0x2222))
            },
            |hwnd| {
                attempted.push(hwnd);
                Ok(())
            },
        );
        assert!(result.is_ok());
        assert_eq!(resolve_calls, 0, "a live cached HWND must skip resolve_target");
        assert_eq!(attempted, vec![0x1111], "the query goes straight to the cached window");
        assert_eq!(cache.as_ref().map(|info| info.hwnd), Some(0x1111));
    }

    // F04: Everything restarted, so the old HWND is no longer a window. The
    // query must resolve a fresh target instead of failing on the dead handle.
    #[test]
    fn f04_query_reresolves_when_cached_window_is_gone() {
        let mut cache = Some(target(0x1111));
        let mut resolve_calls = 0;
        let mut attempted = Vec::new();
        let result: Result<(), Value> = run_query_cached(
            &mut cache,
            |_| false,
            || {
                resolve_calls += 1;
                Some(target(0x2222))
            },
            |hwnd| {
                attempted.push(hwnd);
                Ok(())
            },
        );
        assert!(result.is_ok());
        assert_eq!(resolve_calls, 1);
        assert_eq!(attempted, vec![0x2222]);
        assert_eq!(cache.as_ref().map(|info| info.hwnd), Some(0x2222));
    }

    // F04: a SendMessageTimeoutW failure / missing CopyData receipt means the
    // cached window stopped answering; re-resolve exactly once so the user's
    // query still succeeds after an Everything restart.
    #[test]
    fn f04_query_reresolves_once_after_communication_failure() {
        let mut cache = Some(target(0x1111));
        let mut resolve_calls = 0;
        let mut attempted = Vec::new();
        let result: Result<(), Value> = run_query_cached(
            &mut cache,
            |_| true,
            || {
                resolve_calls += 1;
                Some(target(0x2222))
            },
            |hwnd| {
                attempted.push(hwnd);
                if hwnd == 0x1111 {
                    Err(json!({ "code": "timeout" }))
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_ok());
        assert_eq!(attempted, vec![0x1111, 0x2222], "one retry after re-resolving");
        assert_eq!(resolve_calls, 1);
        assert_eq!(cache.as_ref().map(|info| info.hwnd), Some(0x2222));
    }

    // F04: a malformed payload is not a communication failure, so it must keep
    // the cache instead of paying for another full desktop enumeration.
    #[test]
    fn f04_query_keeps_cache_after_non_communication_error() {
        let mut cache = Some(target(0x1111));
        let mut resolve_calls = 0;
        let result: Result<(), Value> = run_query_cached(
            &mut cache,
            |_| true,
            || {
                resolve_calls += 1;
                Some(target(0x2222))
            },
            |_| Err(json!({ "code": "bad-reply" })),
        );
        assert_eq!(result.unwrap_err().get("code").and_then(Value::as_str), Some("bad-reply"));
        assert_eq!(resolve_calls, 0);
        assert_eq!(cache.as_ref().map(|info| info.hwnd), Some(0x1111));
    }

    // F04: no cache and no Everything instance keeps the original not-running
    // protocol error the JS service relies on to re-check readiness.
    #[test]
    fn f04_query_reports_not_running_when_resolve_finds_nothing() {
        let mut cache = None;
        let mut attempted = 0;
        let result: Result<(), Value> = run_query_cached(
            &mut cache,
            |_| true,
            || None,
            |_| {
                attempted += 1;
                Ok(())
            },
        );
        let error = result.unwrap_err();
        assert_eq!(error.get("code").and_then(Value::as_str), Some("not-running"));
        assert_eq!(attempted, 0);
        assert!(cache.is_none());
    }

    #[test]
    fn f04_window_liveness_accepts_real_windows_and_rejects_stale_handles() {
        assert!(!is_window_live(0), "a null HWND is not live");
        // IsWindow is the exact guard for cache reuse; the desktop window is a
        // real window in every interactive session.
        let desktop = unsafe { windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow() };
        assert!(is_window_live(desktop.0 as isize));
    }

    // ===================== F04: process image path =====================

    // F04: QueryFullProcessImageNameW replaces the PowerShell + WMI probe that
    // cold-started a shell process per verification. The current process is a
    // known-good target for the real API.
    #[test]
    fn f04_process_path_resolves_the_current_process() {
        let path = query_process_image_path(std::process::id()).expect("own image path");
        let expected = std::env::current_exe().expect("current exe path");
        assert_eq!(
            path.to_lowercase(),
            expected.to_string_lossy().to_lowercase(),
            "QueryFullProcessImageNameW must return the current executable path"
        );
    }

    // F04: safe degradation — a pid that cannot be resolved is a typed error,
    // never a panic and never a guessed path.
    #[test]
    fn f04_process_path_rejects_unresolvable_pids() {
        assert_eq!(query_process_image_path(0), Err("invalid-pid"));
        let bogus = query_process_image_path(u32::MAX);
        assert!(bogus.is_err(), "a pid that cannot be opened must not resolve: {bogus:?}");
        let invalid = process_path_result(Some(0)).unwrap_err();
        assert_eq!(invalid.get("code").and_then(Value::as_str), Some("invalid-pid"));
        let accepted = process_path_result(Some(u64::from(std::process::id()))).expect("own pid");
        assert!(accepted.get("path").and_then(Value::as_str).is_some());
    }
}
