//! Only bounded metadata is queued from the message callback. No clipboard
//! reads, sleeps, filesystem access or stdout writes occur on that thread.
use crate::barrier::Barrier;
use crate::capture::read_snapshot_with_rules;
use crate::limits::Skip;
use crate::storage::{Rules, Store};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, GetClipboardSequenceNumber, RemoveClipboardFormatListener,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

const STOP: u32 = WM_APP + 1;

#[derive(Default)]
struct State {
    barrier: Arc<Barrier>,
    enabled: AtomicBool,
    generation: AtomicU64,
    last_notified: AtomicU32,
    queued: AtomicU64,
    queue_full: AtomicU64,
    accepted: AtomicU64,
    accepted_bytes: AtomicU64,
    max_capture_micros: AtomicU64,
    skipped: Mutex<BTreeMap<&'static str, u64>>,
    rules: Mutex<Rules>,
    capture_started: Mutex<Option<Instant>>,
}

struct Notice {
    sequence: u32,
    generation: u64,
    barrier_epoch: u64,
}
struct Context {
    state: Arc<State>,
    sender: mpsc::SyncSender<Notice>,
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if message == STOP {
        PostQuitMessage(0);
        return LRESULT(0);
    }
    if message == WM_CLIPBOARDUPDATE {
        let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Context;
        if let Some(context) = pointer.as_ref() {
            let state = &context.state;
            if state.enabled.load(Ordering::Acquire) {
                let sequence = GetClipboardSequenceNumber();
                if state.last_notified.swap(sequence, Ordering::AcqRel) != sequence {
                    if context
                        .sender
                        .try_send(Notice {
                            sequence,
                            generation: state.generation.load(Ordering::Acquire),
                            barrier_epoch: state.barrier.notice_epoch(),
                        })
                        .is_ok()
                    {
                        state.queued.fetch_add(1, Ordering::Relaxed);
                    } else {
                        state.queue_full.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, message, wp, lp)
}

pub struct Monitor {
    state: Arc<State>,
    hwnd: isize,
    listener: Option<thread::JoinHandle<()>>,
    listener_done: mpsc::Receiver<()>,
    worker: Option<thread::JoinHandle<()>>,
    worker_done: mpsc::Receiver<()>,
}

impl Monitor {
    pub fn start() -> Result<Self, &'static str> {
        Self::start_with_barrier(Arc::new(Barrier::default()))
    }

    pub fn start_with_barrier(barrier: Arc<Barrier>) -> Result<Self, &'static str> {
        Self::start_with_store(barrier, None)
    }

    pub fn start_with_store(
        barrier: Arc<Barrier>,
        store: Option<Arc<Mutex<Store>>>,
    ) -> Result<Self, &'static str> {
        let state = Arc::new(State {
            barrier,
            ..State::default()
        });
        let (sender, receiver) = mpsc::sync_channel::<Notice>(64);
        let (ready, startup) = mpsc::sync_channel(1);
        let (listener_finished, listener_done) = mpsc::channel();
        let window_state = state.clone();
        let listener = thread::spawn(move || unsafe {
            // Always unregister after destroying the HWND, including startup
            // failures. A later configure after quiesce must be able to restart.
            struct ClassGuard(windows::Win32::Foundation::HINSTANCE);
            impl Drop for ClassGuard {
                fn drop(&mut self) {
                    unsafe {
                        let _ = UnregisterClassW(w!("HighlighterClipboardListener"), Some(self.0));
                    }
                }
            }
            let mut class_guard = None;
            let init = (|| -> windows::core::Result<(HWND, *mut Context)> {
                let instance = GetModuleHandleW(None)?;
                let class = WNDCLASSW {
                    lpfnWndProc: Some(window_proc),
                    hInstance: instance.into(),
                    lpszClassName: w!("HighlighterClipboardListener"),
                    ..Default::default()
                };
                if RegisterClassW(&class) == 0 {
                    return Err(windows::core::Error::from_thread());
                }
                class_guard = Some(ClassGuard(instance.into()));
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    class.lpszClassName,
                    w!(""),
                    WINDOW_STYLE::default(),
                    0,
                    0,
                    0,
                    0,
                    Some(HWND_MESSAGE),
                    None,
                    Some(instance.into()),
                    None,
                )?;
                let pointer = Box::into_raw(Box::new(Context {
                    state: window_state,
                    sender,
                }));
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, pointer as isize);
                if let Err(error) = AddClipboardFormatListener(hwnd) {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    drop(Box::from_raw(pointer));
                    let _ = DestroyWindow(hwnd);
                    return Err(error);
                }
                Ok((hwnd, pointer))
            })();
            match init {
                Ok((hwnd, pointer)) => {
                    if ready.send(Ok(hwnd.0 as isize)).is_ok() {
                        let mut message = MSG::default();
                        loop {
                            let result = GetMessageW(&mut message, None, 0, 0).0;
                            if result <= 0 {
                                break;
                            }
                            let _ = DispatchMessageW(&message);
                        }
                    }
                    let _ = RemoveClipboardFormatListener(hwnd);
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    let _ = DestroyWindow(hwnd);
                    drop(Box::from_raw(pointer));
                }
                Err(_) => {
                    let _ = ready.send(Err("LISTENER_START_FAILED"));
                }
            }
            drop(class_guard);
            let _ = listener_finished.send(());
        });
        let hwnd = startup
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "LISTENER_START_TIMEOUT")??;
        let worker_state = state.clone();
        let (done, worker_done) = mpsc::channel();
        let worker = thread::spawn(move || {
            while let Ok(notice) = receiver.recv() {
                if !current(&worker_state, &notice) {
                    skip(&worker_state, "stale_configuration");
                    continue;
                }
                let Some(permit) = worker_state
                    .barrier
                    .try_read(notice.barrier_epoch, notice.sequence)
                else {
                    skip(&worker_state, "transient_barrier");
                    continue;
                };
                let started = Instant::now();
                *worker_state
                    .capture_started
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(started);
                let rules = worker_state
                    .rules
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                let mut result = Err(Skip::Busy);
                for delay in [0, 5, 15, 30] {
                    if !current(&worker_state, &notice) || !permit.current() {
                        break;
                    }
                    if delay != 0 {
                        thread::sleep(Duration::from_millis(delay));
                    }
                    if !current(&worker_state, &notice) || !permit.current() {
                        break;
                    }
                    result = read_snapshot_with_rules(
                        notice.sequence,
                        rules.capture_text,
                        rules.capture_images,
                        &rules.excluded_apps,
                    );
                    if !matches!(result, Err(Skip::Busy)) {
                        break;
                    }
                }
                worker_state
                    .max_capture_micros
                    .fetch_max(started.elapsed().as_micros() as u64, Ordering::Relaxed);
                *worker_state
                    .capture_started
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                if !current(&worker_state, &notice) || !permit.current() {
                    skip(&worker_state, "stale_configuration");
                    continue;
                }
                match result {
                    Ok(snapshot) => {
                        let length = snapshot.bytes.len() as u64;
                        if let Some(store) = &store {
                            // A deletion invalidates generation before taking this
                            // mutex. A snapshot cannot reappear after that delete.
                            let mut store = store.lock().unwrap_or_else(|e| e.into_inner());
                            if !current(&worker_state, &notice) || !permit.current() {
                                continue;
                            }
                            if let Err(code) =
                                store.accept(snapshot.kind, snapshot.bytes, &snapshot.source)
                            {
                                skip(&worker_state, code);
                                continue;
                            }
                        }
                        worker_state.accepted.fetch_add(1, Ordering::Relaxed);
                        worker_state
                            .accepted_bytes
                            .fetch_add(length, Ordering::Relaxed);
                    }
                    Err(reason) => skip(&worker_state, reason.code()),
                }
            }
            let _ = done.send(());
        });
        Ok(Self {
            state,
            hwnd,
            listener: Some(listener),
            listener_done,
            worker: Some(worker),
            worker_done,
        })
    }

    pub fn configure(&self, enabled: bool) {
        self.state.enabled.store(false, Ordering::Release);
        self.state.generation.fetch_add(1, Ordering::AcqRel);
        self.state
            .last_notified
            .store(unsafe { GetClipboardSequenceNumber() }, Ordering::Release);
        self.state.enabled.store(enabled, Ordering::Release);
    }

    pub fn invalidate(&self) {
        self.state.generation.fetch_add(1, Ordering::AcqRel);
    }
    pub fn set_rules(&self, rules: Rules) {
        self.invalidate();
        *self.state.rules.lock().unwrap_or_else(|e| e.into_inner()) = rules;
    }

    pub fn enabled(&self) -> bool {
        self.state.enabled.load(Ordering::Acquire)
    }

    pub fn status(&self) -> Value {
        json!({
            "captureBusyMs": self.state.capture_started.lock().unwrap_or_else(|e|e.into_inner()).map(|start|start.elapsed().as_millis() as u64).unwrap_or(0),
            "enabled": self.state.enabled.load(Ordering::Acquire),
            "coordinationPhase": format!("{:?}", self.state.barrier.phase()).to_lowercase(),
            "queued": self.state.queued.load(Ordering::Relaxed),
            "queueFull": self.state.queue_full.load(Ordering::Relaxed),
            "accepted": self.state.accepted.load(Ordering::Relaxed),
            "acceptedBytes": self.state.accepted_bytes.load(Ordering::Relaxed),
            "maxCaptureMicros": self.state.max_capture_micros.load(Ordering::Relaxed),
            "skipped": *self.state.skipped.lock().unwrap_or_else(|e| e.into_inner())
        })
    }

    pub fn stop(&mut self) -> Result<(), &'static str> {
        self.configure(false);
        if self.listener.is_some() {
            unsafe { PostMessageW(Some(HWND(self.hwnd as *mut _)), STOP, WPARAM(0), LPARAM(0)) }
                .map_err(|_| "LISTENER_STOP_FAILED")?;
            self.listener_done
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| "LISTENER_STOP_TIMEOUT")?;
            if let Some(listener) = self.listener.take() {
                listener.join().map_err(|_| "LISTENER_STOP_FAILED")?;
            }
        }
        if self.worker.is_some() {
            self.worker_done
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| "CAPTURE_STOP_TIMEOUT")?;
            if let Some(worker) = self.worker.take() {
                worker.join().map_err(|_| "CAPTURE_STOP_FAILED")?;
            }
        }
        Ok(())
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        // Explicit stop reports timeouts; Drop must not repeat a blocking wait
        // or falsely report a blocked native capture as successfully stopped.
        self.state.enabled.store(false, Ordering::Release);
        self.state.generation.fetch_add(1, Ordering::AcqRel);
        if self.listener.is_some() {
            unsafe {
                let _ = PostMessageW(Some(HWND(self.hwnd as *mut _)), STOP, WPARAM(0), LPARAM(0));
            }
        }
    }
}

fn current(state: &State, notice: &Notice) -> bool {
    state.enabled.load(Ordering::Acquire)
        && state.generation.load(Ordering::Acquire) == notice.generation
}

fn skip(state: &State, code: &'static str) {
    *state
        .skipped
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(code)
        .or_default() += 1;
}
