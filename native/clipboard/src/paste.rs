//! Explicit, single-use paste. HWNDs/tickets stay on private parent stdio.
//! No global hooks, idle polling, elevation, clipboard rollback or paste retries.
use crate::{
    barrier::Barrier,
    publication::{PublicationProof, WriterContext},
    storage::Store,
    writer::{self, PasteWrite},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
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
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteTrace {
    foreground_request_succeeded: bool,
    foreground_matches: bool,
    focus_matches: bool,
    keys_released: bool,
    /// True when the user's still-held Ctrl was reused instead of synthesizing it.
    reused_ctrl: bool,
    target_valid: bool,
    outcome: String,
    elapsed_micros: u64,
}
#[derive(Default)]
pub struct PasteSession {
    panel: Option<(HWND, u32)>,
    target: Option<Target>,
    prepared: Option<Prepared>,
    recent: VecDeque<PasteTrace>,
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

fn key_down(key: VIRTUAL_KEY) -> bool {
    unsafe { GetAsyncKeyState(key.0 as i32) < 0 }
}

fn ctrl_held() -> bool {
    key_down(VK_LCONTROL) || key_down(VK_RCONTROL)
}

/// Everything except Ctrl is up, so a paste can reuse the Ctrl the user is still
/// holding (Ctrl+Enter keeps it down through the panel hide). Any other modifier,
/// V itself, or a mouse button still blocks the reuse.
fn released_except_control() -> bool {
    [
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

/// How long the commit phase waits for the shortcut modifiers to be released.
/// 600 ms covers a relaxed Ctrl+Enter release; waiting the full window is the
/// exception (a still-held Ctrl is reused, other held keys fail fast) so the
/// local barrier is normally held far shorter.
const MODIFIER_RELEASE_WAIT: Duration = Duration::from_millis(600);

struct PasteBatch {
    inputs: Vec<INPUT>,
    /// Synthetic key-downs as (index in `inputs`, virtual key). A partial SendInput
    /// only inserts a prefix of `inputs`, so these indices decide what to release.
    downs: Vec<(usize, VIRTUAL_KEY)>,
}

/// Build the single paste batch. Ctrl+V is the normal shape; when the user's own
/// Ctrl is still physically down only V is synthesized, which the target still
/// resolves as Ctrl+V.
fn paste_batch(reuse_held_ctrl: bool) -> PasteBatch {
    let mut batch = PasteBatch {
        inputs: Vec::with_capacity(4),
        downs: Vec::with_capacity(2),
    };
    if !reuse_held_ctrl {
        batch.downs.push((batch.inputs.len(), VK_LCONTROL));
        batch.inputs.push(key(VK_LCONTROL, false));
    }
    batch.downs.push((batch.inputs.len(), VK_V));
    batch.inputs.push(key(VK_V, false));
    batch.inputs.push(key(VK_V, true));
    if !reuse_held_ctrl {
        batch.inputs.push(key(VK_LCONTROL, true));
    }
    batch
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
    pub fn diagnostics(&self) -> Value {
        json!({"recent":self.recent})
    }
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
                let started = Instant::now();
                let mut trace = PasteTrace::default();
                let result = inject(&prepared, &mut trace);
                trace.elapsed_micros = started.elapsed().as_micros() as u64;
                trace.outcome = match &result {
                    Ok(value) => value
                        .get("reason")
                        .or_else(|| value.get("outcome"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    Err(code) => code,
                }
                .into();
                if self.recent.len() == 16 {
                    self.recent.pop_front();
                }
                self.recent.push_back(trace);
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

fn inject(prepared: &Prepared, trace: &mut PasteTrace) -> Result<Value, &'static str> {
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
            trace.foreground_request_succeeded = SetForegroundWindow(target.window).as_bool();
        }
    }
    let deadline = Instant::now() + MODIFIER_RELEASE_WAIT;
    let mut reuse_held_ctrl = false;
    loop {
        if !prepared.proof.current() {
            return Ok(copied_only("CLIPBOARD_CHANGED"));
        }
        let foreground = unsafe { GetForegroundWindow() };
        trace.foreground_matches = foreground == target.window;
        trace.focus_matches = focused_window(target.thread) == Some(target.focus);
        trace.target_valid = target.valid();
        trace.keys_released = released();
        // SetForegroundWindow may acknowledge before the GUI thread finishes
        // activation. An empty transition is not a different target. Keep the
        // same deadline and cancel immediately for any actual third window.
        if !foreground.0.is_null() && foreground != target.window && foreground != prepared.panel {
            return Ok(copied_only("FOCUS_CHANGED"));
        }
        if trace.foreground_matches && trace.focus_matches && trace.target_valid {
            if trace.keys_released {
                break;
            }
            // Ctrl+Enter: the user often keeps Ctrl down after the panel hides.
            // Once the target window has focus and no other key is held, reuse that
            // Ctrl and synthesize only V - the target still sees Ctrl+V. Waiting for
            // a slow release used to fail with FOCUS_OR_KEYS_BUSY after 300 ms.
            if ctrl_held() && released_except_control() {
                reuse_held_ctrl = true;
                break;
            }
        }
        if Instant::now() >= deadline {
            return Ok(copied_only("FOCUS_OR_KEYS_BUSY"));
        }
        thread::sleep(Duration::from_millis(10));
    }
    // Re-validate the exact state the batch depends on. A released reuse-Ctrl must
    // not become a bare V keystroke, and a re-pressed key must keep the original
    // fail-closed FOCUS_CHANGED semantics.
    if !input_desktop() || !target.focused() || !prepared.proof.current() {
        return Ok(copied_only("FOCUS_CHANGED"));
    }
    if reuse_held_ctrl {
        if !ctrl_held() || !released_except_control() {
            return Ok(copied_only("FOCUS_CHANGED"));
        }
    } else if !released() {
        return Ok(copied_only("FOCUS_CHANGED"));
    }
    trace.reused_ctrl = reuse_held_ctrl;
    // One batch, one attempt. Success only proves insertion into the input
    // stream; it cannot prove that the target application consumed the paste.
    let batch = paste_batch(reuse_held_ctrl);
    let sent = unsafe { SendInput(&batch.inputs, size_of::<INPUT>() as i32) };
    if sent == 0 {
        return Ok(copied_only("INPUT_BLOCKED"));
    }
    if sent != batch.inputs.len() as u32 {
        // Release only keys whose synthetic downs were actually inserted.
        // No paste retry; a partial batch has an unknown external outcome.
        let cleanup: Vec<_> = batch
            .downs
            .iter()
            .filter(|(index, _)| *index < sent as usize)
            .rev()
            .map(|(_, vk)| key(*vk, true))
            .collect();
        if !cleanup.is_empty() {
            unsafe {
                SendInput(&cleanup, size_of::<INPUT>() as i32);
            }
        }
        return Err("PASTE_OUTCOME_UNKNOWN");
    }
    Ok(json!({"copied":true,"outcome":"injected"}))
}

#[cfg(test)]
mod paste_batch_tests {
    //! Pure input-batch tests: no clipboard, no input injection, no desktop. The
    //! physical Ctrl-reuse decision itself can only be exercised against real key
    //! state, so the batch shape and the wait budget are pinned here.
    use super::*;

    fn vk_of(input: &INPUT) -> VIRTUAL_KEY {
        // Reading the input union is unsafe by definition; the values were built by
        // `key()` in this module, so the layout is the keyboard variant.
        unsafe { input.Anonymous.ki.wVk }
    }

    fn is_keyup(input: &INPUT) -> bool {
        unsafe { input.Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP) }
    }

    fn tag_of(input: &INPUT) -> usize {
        unsafe { input.Anonymous.ki.dwExtraInfo }
    }

    #[test]
    fn normal_paste_uses_one_symmetric_ctrl_v_batch() {
        let batch = paste_batch(false);
        assert_eq!(batch.inputs.len(), 4);
        assert_eq!(batch.downs.len(), 2);
        assert_eq!(batch.downs[0], (0, VK_LCONTROL));
        assert_eq!(batch.downs[1], (1, VK_V));
        assert_eq!(vk_of(&batch.inputs[0]), VK_LCONTROL);
        assert_eq!(is_keyup(&batch.inputs[0]), false);
        assert_eq!(vk_of(&batch.inputs[1]), VK_V);
        assert_eq!(is_keyup(&batch.inputs[1]), false);
        assert_eq!(vk_of(&batch.inputs[2]), VK_V);
        assert_eq!(is_keyup(&batch.inputs[2]), true);
        assert_eq!(vk_of(&batch.inputs[3]), VK_LCONTROL);
        assert_eq!(is_keyup(&batch.inputs[3]), true);
        assert!(batch.inputs.iter().all(|input| tag_of(input) == 0x484c5041));
    }

    #[test]
    fn reused_ctrl_paste_sends_only_v_and_keeps_partial_cleanup_consistent() {
        let batch = paste_batch(true);
        assert_eq!(batch.inputs.len(), 2);
        assert_eq!(batch.downs, vec![(0, VK_V)]);
        assert_eq!(vk_of(&batch.inputs[0]), VK_V);
        assert_eq!(is_keyup(&batch.inputs[0]), false);
        assert_eq!(vk_of(&batch.inputs[1]), VK_V);
        assert_eq!(is_keyup(&batch.inputs[1]), true);
    }

    #[test]
    fn modifier_release_window_is_600ms() {
        // A Ctrl still held after 300 ms used to fail with FOCUS_OR_KEYS_BUSY; the
        // scan window is now 600 ms and the reuse branch normally ends it early.
        assert_eq!(MODIFIER_RELEASE_WAIT, Duration::from_millis(600));
    }
}

