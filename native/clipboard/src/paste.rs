//! Explicit, single-use paste. HWNDs/tickets stay on private parent stdio.
//! No global hooks, idle polling, elevation, clipboard rollback or paste retries.
use crate::{
    barrier::Barrier,
    publication::{PublicationProof, WriterContext},
    storage::Store,
    writer::{self, PasteWrite},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    mem::size_of,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::*,
    System::{StationsAndDesktops::*, Threading::*},
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

struct Process(HANDLE);
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
struct Target {
    id: String,
    window: HWND,
    focus: HWND,
    thread: u32,
    pid: u32,
    process: Process,
    captured: Instant,
}
impl Target {
    fn valid(&self) -> bool {
        // Retaining the original process HANDLE prevents PID reuse from
        // substituting a new process, even when its numeric PID is identical.
        unsafe {
            self.captured.elapsed() < Duration::from_secs(300)
                && WaitForSingleObject(self.process.0, 0) == WAIT_TIMEOUT
                && identity(self.window) == (self.thread, self.pid)
                && identity(self.focus).1 == self.pid
                && GetAncestor(self.focus, GA_ROOT) == self.window
                && IsWindow(Some(self.window)).as_bool()
                && IsWindow(Some(self.focus)).as_bool()
                && IsWindowVisible(self.window).as_bool()
                && !IsIconic(self.window).as_bool()
        }
    }
    fn focused(&self) -> bool {
        self.valid()
            && unsafe { GetForegroundWindow() == self.window }
            && focused_window(self.thread) == Some(self.focus)
    }
}
struct Prepared {
    ticket: String,
    id: String,
    operation: String,
    target: Target,
    panel: HWND,
    proof: PublicationProof,
    written: Instant,
}
#[derive(Default)]
pub struct PasteSession {
    panel: Option<(HWND, u32)>,
    target: Option<Target>,
    prepared: Option<Prepared>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capture {
    panel_window: String,
    parent_pid: u32,
}

fn identity(window: HWND) -> (u32, u32) {
    let mut pid = 0;
    let thread = unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    (thread, pid)
}
fn focused_window(thread: u32) -> Option<HWND> {
    let mut info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        GetGUIThreadInfo(thread, &mut info).ok()?;
    }
    if info.hwndFocus.0.is_null() {
        None
    } else {
        Some(info.hwndFocus)
    }
}
fn desktop_name(desktop: HDESK) -> Option<Vec<u16>> {
    let mut name = [0u16; 256];
    let mut size = 0;
    unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            size_of_val(&name) as u32,
            Some(&mut size),
        )
        .ok()?;
    }
    if size < 2 || size as usize > size_of_val(&name) {
        return None;
    }
    Some(name[..(size as usize / 2)].to_vec())
}
fn input_desktop() -> bool {
    unsafe {
        let Ok(input) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let current = GetThreadDesktop(GetCurrentThreadId())
            .ok()
            .and_then(desktop_name);
        let active = desktop_name(input);
        let _ = CloseDesktop(input);
        current.is_some() && current == active
    }
}
fn released() -> bool {
    // Never synthesize releases for modifiers the user is holding. Checking V
    // also prevents a held key from turning one paste into repeated pastes.
    [
        VK_LCONTROL,
        VK_RCONTROL,
        VK_LSHIFT,
        VK_RSHIFT,
        VK_LMENU,
        VK_RMENU,
        VK_LWIN,
        VK_RWIN,
        VK_V,
        VK_LBUTTON,
        VK_RBUTTON,
        VK_MBUTTON,
    ]
    .iter()
    .all(|key| unsafe { GetAsyncKeyState(key.0 as i32) >= 0 })
}
fn key(key: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                dwExtraInfo: 0x484c5041,
                ..Default::default()
            },
        },
    }
}
fn copied_only(reason: &str) -> Value {
    json!({"copied":true,"outcome":"copiedOnly","reason":reason})
}
fn finish(store: &Mutex<Store>, id: &str, op: &str, value: Value) -> Result<Value, &'static str> {
    store
        .lock()
        .map_err(|_| "PASTE_OUTCOME_UNKNOWN")?
        .finish_paste(id, op, &value)
        .map_err(|_| "PASTE_OUTCOME_UNKNOWN")?;
    Ok(value)
}

impl PasteSession {
    pub fn clear(&mut self) {
        self.target = None;
        self.prepared = None;
        self.panel = None;
    }
    pub fn capture(&mut self, args: Value) -> Result<Value, &'static str> {
        self.clear();
        let args: Capture = serde_json::from_value(args).map_err(|_| "INVALID_ARGUMENT")?;
        let raw = usize::from_str_radix(&args.panel_window, 16).map_err(|_| "INVALID_ARGUMENT")?;
        let panel = HWND(raw as *mut _);
        if raw == 0 || args.parent_pid == 0 || identity(panel).1 != args.parent_pid {
            return Err("INVALID_ARGUMENT");
        }
        self.panel = Some((panel, args.parent_pid));
        let target = (|| {
            if !input_desktop() {
                return None;
            }
            let window = unsafe { GetForegroundWindow() };
            let (thread, pid) = identity(window);
            if thread == 0 || pid == 0 || pid == args.parent_pid || pid == std::process::id() {
                return None;
            }
            let process = Process(unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    false,
                    pid,
                )
                .ok()?
            });
            let focus = focused_window(thread)?;
            let target = Target {
                id: uuid::Uuid::new_v4().to_string(),
                window,
                focus,
                thread,
                pid,
                process,
                captured: Instant::now(),
            };
            if !target.focused() {
                return None;
            }
            Some(target)
        })();
        let value = json!({"targetId":target.as_ref().map(|target| &target.id)});
        self.target = target;
        Ok(value)
    }
    pub fn prepare(
        &mut self,
        barrier: &Barrier,
        context: &WriterContext,
        store: &Mutex<Store>,
        id: &str,
        op: &str,
        target_id: Option<&str>,
    ) -> Result<Value, &'static str> {
        self.prepared = None;
        let (panel, parent) = self.panel.ok_or("WINDOW_NOT_VISIBLE")?;
        if unsafe { GetForegroundWindow() } != panel || identity(panel).1 != parent {
            return Err("WINDOW_NOT_VISIBLE");
        }
        let target = self
            .target
            .take()
            .filter(|target| Some(target.id.as_str()) == target_id);
        match writer::prepare_paste(barrier, context, store, id, op)? {
            PasteWrite::Completed(value) => Ok(value),
            PasteWrite::Published(proof) => {
                let Some(target) = target.filter(Target::valid) else {
                    return finish(store, id, op, copied_only("TARGET_UNAVAILABLE"));
                };
                let ticket = uuid::Uuid::new_v4().to_string();
                self.prepared = Some(Prepared {
                    ticket: ticket.clone(),
                    id: id.into(),
                    operation: op.into(),
                    target,
                    panel,
                    proof,
                    written: Instant::now(),
                });
                Ok(json!({"copied":true,"ticket":ticket}))
            }
        }
    }
    pub fn commit(
        &mut self,
        barrier: &Barrier,
        store: &Mutex<Store>,
        ticket: &str,
        cancel: bool,
    ) -> Result<Value, &'static str> {
        let Some(prepared) = self.prepared.take() else {
            return Err("PASTE_OUTCOME_UNKNOWN");
        };
        if prepared.ticket != ticket {
            return Err("PASTE_OUTCOME_UNKNOWN");
        }
        if cancel {
            return finish(
                store,
                &prepared.id,
                &prepared.operation,
                copied_only("FOCUS_CHANGED"),
            );
        }
        let value = match barrier.begin_local(Duration::from_millis(100)) {
            Err(_) => copied_only("COORDINATION_BUSY"),
            Ok(epoch) => {
                let result = inject(&prepared);
                // This phase never writes: preserve the owned-copy baseline,
                // allowing any intervening genuine clipboard change through.
                barrier
                    .end(0, epoch, prepared.proof.sequence)
                    .map_err(|_| "PASTE_OUTCOME_UNKNOWN")?;
                result?
            }
        };
        finish(store, &prepared.id, &prepared.operation, value)
    }
}

fn inject(prepared: &Prepared) -> Result<Value, &'static str> {
    let target = &prepared.target;
    if prepared.written.elapsed() > Duration::from_secs(3) || !input_desktop() || !target.valid() {
        return Ok(copied_only("TARGET_UNAVAILABLE"));
    }
    // Hiding a window can briefly leave no foreground. Wait only for that
    // transition; another real foreground is a cancellation, never a new target.
    let transition = Instant::now() + Duration::from_millis(100);
    let foreground = loop {
        let foreground = unsafe { GetForegroundWindow() };
        if !foreground.0.is_null() {
            break foreground;
        }
        if Instant::now() >= transition {
            return Ok(copied_only("FOCUS_CHANGED"));
        }
        thread::sleep(Duration::from_millis(10));
    };
    if foreground != target.window && foreground != prepared.panel {
        return Ok(copied_only("FOCUS_CHANGED"));
    }
    if foreground != target.window {
        unsafe {
            let _ = SetForegroundWindow(target.window);
        }
    }
    let deadline = Instant::now() + Duration::from_millis(300);
    loop {
        if !prepared.proof.current() {
            return Ok(copied_only("CLIPBOARD_CHANGED"));
        }
        let foreground = unsafe { GetForegroundWindow() };
        if foreground != target.window && foreground != prepared.panel {
            return Ok(copied_only("FOCUS_CHANGED"));
        }
        if target.focused() && released() {
            break;
        }
        if Instant::now() >= deadline {
            return Ok(copied_only("FOCUS_OR_KEYS_BUSY"));
        }
        thread::sleep(Duration::from_millis(10));
    }
    if !input_desktop() || !target.focused() || !released() || !prepared.proof.current() {
        return Ok(copied_only("FOCUS_CHANGED"));
    }
    // One batch, one attempt. Success only proves insertion into the input
    // stream; it cannot prove that the target application consumed the paste.
    let inputs = [
        key(VK_LCONTROL, false),
        key(VK_V, false),
        key(VK_V, true),
        key(VK_LCONTROL, true),
    ];
    let sent = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    if sent == 0 {
        return Ok(copied_only("INPUT_BLOCKED"));
    }
    if sent != inputs.len() as u32 {
        // Release only keys whose synthetic downs were actually inserted.
        // No paste retry; a partial batch has an unknown external outcome.
        let cleanup: Vec<_> = [
            if sent == 2 {
                Some(key(VK_V, true))
            } else {
                None
            },
            Some(key(VK_LCONTROL, true)),
        ]
        .into_iter()
        .flatten()
        .collect();
        unsafe {
            SendInput(&cleanup, size_of::<INPUT>() as i32);
        }
        return Err("PASTE_OUTCOME_UNKNOWN");
    }
    Ok(json!({"copied":true,"outcome":"injected"}))
}
