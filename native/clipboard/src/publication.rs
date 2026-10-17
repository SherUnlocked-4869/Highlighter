//! A writer identity belongs to one message-loop lifetime, never to a recycled
//! HWND number. Metadata only; no clipboard payloads are retained here.
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use windows::Win32::{
    Foundation::HWND,
    System::DataExchange::{GetClipboardOwner, GetClipboardSequenceNumber},
};

#[derive(Clone, Default)]
pub struct WriterContext(Arc<Identity>);
#[derive(Default)]
struct Identity {
    window: AtomicIsize,
    alive: AtomicBool,
    revoked: AtomicU64,
    traces: Mutex<VecDeque<PublicationTrace>>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationTrace {
    pub phase: &'static str,
    pub before_close: u32,
    pub after_close: u32,
    pub verified_sequence: u32,
    pub owner_is_ours: bool,
    pub content_matched: bool,
    pub publish_micros: u64,
    pub verify_micros: u64,
}
pub struct PublicationProof {
    pub sequence: u32,
    context: WriterContext,
    generation: u64,
}
impl WriterContext {
    pub(crate) fn bind(&self, window: HWND) {
        self.0.window.store(window.0 as isize, Ordering::Release);
        self.0.alive.store(true, Ordering::Release);
    }
    pub(crate) fn revoke(&self) {
        self.0.revoked.fetch_add(1, Ordering::AcqRel);
    }
    pub(crate) fn close(&self) {
        self.0.alive.store(false, Ordering::Release);
        self.revoke();
    }
    pub fn window(&self) -> Result<HWND, &'static str> {
        if !self.0.alive.load(Ordering::Acquire) {
            return Err("WRITER_UNAVAILABLE");
        }
        Ok(HWND(self.0.window.load(Ordering::Acquire) as *mut _))
    }
    pub fn generation(&self) -> u64 {
        self.0.revoked.load(Ordering::Acquire)
    }
    pub fn owns_clipboard(&self) -> bool {
        self.window()
            .ok()
            .is_some_and(|window| unsafe { GetClipboardOwner().ok() == Some(window) })
    }
    pub fn unchanged(&self, generation: u64) -> bool {
        self.generation() == generation && self.owns_clipboard()
    }
    pub fn proof(&self, sequence: u32, generation: u64) -> PublicationProof {
        PublicationProof {
            sequence,
            generation,
            context: self.clone(),
        }
    }
    pub fn record(&self, trace: PublicationTrace) {
        let mut traces = self.0.traces.lock().unwrap_or_else(|e| e.into_inner());
        if traces.len() == 16 {
            traces.pop_front();
        }
        traces.push_back(trace);
    }
    pub fn diagnostics(&self) -> serde_json::Value {
        serde_json::json!({"recent":*self.0.traces.lock().unwrap_or_else(|e| e.into_inner())})
    }
}
impl PublicationProof {
    pub fn current(&self) -> bool {
        self.context.unchanged(self.generation)
            && unsafe { GetClipboardSequenceNumber() } == self.sequence
    }
}
