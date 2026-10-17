//! The lease blocks reads before acknowledging the worker. Notification epochs
//! invalidate queued and in-flight candidates without classifying sequence ranges.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Pending,
    Active,
    Orphaned,
    Closed,
}

struct State {
    phase: Phase,
    epoch: u64,
    tx: u64,
    last_tx: u64,
    readers: usize,
    baseline: u32,
}

pub struct Barrier {
    state: Mutex<State>,
    drained: Condvar,
    published_epoch: AtomicU64,
}

pub struct ReadPermit {
    barrier: Arc<Barrier>,
    epoch: u64,
}

impl Default for Barrier {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                phase: Phase::Idle,
                epoch: 1,
                tx: 0,
                last_tx: 0,
                readers: 0,
                baseline: 0,
            }),
            drained: Condvar::new(),
            published_epoch: AtomicU64::new(1),
        }
    }
}

impl Barrier {
    pub fn register_host(&self) -> Result<(), &'static str> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase != Phase::Idle {
            return Err("COORDINATION_BLOCKED");
        }
        state.last_tx = 0;
        Ok(())
    }
    pub fn notice_epoch(&self) -> u64 {
        self.published_epoch.load(Ordering::Acquire)
    }

    pub fn try_read(self: &Arc<Self>, epoch: u64, sequence: u32) -> Option<ReadPermit> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase != Phase::Idle || state.epoch != epoch || state.baseline == sequence {
            return None;
        }
        state.readers += 1;
        Some(ReadPermit {
            barrier: self.clone(),
            epoch,
        })
    }

    pub fn begin(&self, tx: u64, timeout: Duration) -> Result<u64, &'static str> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase != Phase::Idle {
            return Err("COORDINATION_BLOCKED");
        }
        if tx == 0 || tx <= state.last_tx {
            return Err("STALE_TRANSACTION");
        }
        state.phase = Phase::Pending;
        state.epoch += 1;
        self.published_epoch.store(state.epoch, Ordering::Release);
        state.tx = tx;
        state.last_tx = tx;
        while state.readers != 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.phase = Phase::Idle;
                state.epoch += 1;
                self.published_epoch.store(state.epoch, Ordering::Release);
                return Err("CAPTURE_DRAIN_TIMEOUT");
            }
            let waited = self
                .drained
                .wait_timeout(state, remaining)
                .unwrap_or_else(|e| e.into_inner());
            state = waited.0;
            if state.phase != Phase::Pending {
                return Err("COORDINATION_BLOCKED");
            }
        }
        state.phase = Phase::Active;
        Ok(state.epoch)
    }

    pub fn end(&self, tx: u64, epoch: u64, baseline: u32) -> Result<(), &'static str> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase != Phase::Active || state.tx != tx || state.epoch != epoch {
            return Err("STALE_TRANSACTION");
        }
        state.baseline = baseline;
        state.epoch += 1;
        self.published_epoch.store(state.epoch, Ordering::Release);
        state.phase = Phase::Idle;
        Ok(())
    }

    pub fn orphan(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(state.phase, Phase::Pending | Phase::Active) {
            state.phase = Phase::Orphaned;
            state.epoch += 1;
            self.published_epoch.store(state.epoch, Ordering::Release);
            self.drained.notify_all();
        }
    }

    // Caller must verify the registered process HANDLE is signaled, not merely
    // trust a PID or an expired deadline. This never restores clipboard data.
    pub fn recover_after_host_exit(&self, baseline: u32) -> Result<(), &'static str> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.phase != Phase::Orphaned {
            return Err("NOT_ORPHANED");
        }
        state.baseline = baseline;
        state.epoch += 1;
        self.published_epoch.store(state.epoch, Ordering::Release);
        state.phase = Phase::Idle;
        Ok(())
    }

    pub fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.phase = Phase::Closed;
        state.epoch += 1;
        self.published_epoch.store(state.epoch, Ordering::Release);
        self.drained.notify_all();
    }

    pub fn phase(&self) -> Phase {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).phase
    }
}

impl ReadPermit {
    pub fn current(&self) -> bool {
        let state = self.barrier.state.lock().unwrap_or_else(|e| e.into_inner());
        state.phase == Phase::Idle && state.epoch == self.epoch
    }
}
impl Drop for ReadPermit {
    fn drop(&mut self) {
        let mut state = self.barrier.state.lock().unwrap_or_else(|e| e.into_inner());
        state.readers -= 1;
        if state.readers == 0 {
            self.barrier.drained.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drains_open_reads_before_granting_and_invalidates_candidates() {
        let gate = Arc::new(Barrier::default());
        let before = gate.notice_epoch();
        let read = gate.try_read(before, 12).unwrap();
        let other = gate.clone();
        let (granted, received) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            granted
                .send(other.begin(1, Duration::from_secs(1)))
                .unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while gate.phase() == Phase::Idle {
            assert!(Instant::now() < deadline, "begin worker did not run");
            std::thread::yield_now();
        }
        assert!(!read.current());
        assert!(received.try_recv().is_err());
        assert!(gate.try_read(gate.notice_epoch(), 13).is_none());
        drop(read);
        let epoch = received
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        worker.join().unwrap();
        gate.end(1, epoch, u32::MAX).unwrap();
        assert!(gate.try_read(before, 13).is_none());
        assert!(gate.try_read(gate.notice_epoch(), u32::MAX).is_none());
        // Equality only: a wrapped real copy must not fall in a suppressed range.
        assert!(gate.try_read(gate.notice_epoch(), 0).is_some());
    }
    #[test]
    fn drain_timeout_and_orphan_do_not_silently_resume() {
        let gate = Arc::new(Barrier::default());
        let read = gate.try_read(gate.notice_epoch(), 1).unwrap();
        assert_eq!(gate.begin(1, Duration::ZERO), Err("CAPTURE_DRAIN_TIMEOUT"));
        drop(read);
        let epoch = gate.begin(2, Duration::ZERO).unwrap();
        gate.orphan();
        assert_eq!(gate.end(2, epoch, 2), Err("STALE_TRANSACTION"));
        assert!(gate.try_read(gate.notice_epoch(), 3).is_none());
        assert!(gate.begin(3, Duration::ZERO).is_err());
        gate.recover_after_host_exit(3).unwrap();
        assert!(gate.try_read(gate.notice_epoch(), 3).is_none());
        assert!(gate.try_read(gate.notice_epoch(), 4).is_some());
        assert!(gate.begin(2, Duration::ZERO).is_err());
    }
    #[test]
    fn stale_release_and_close_cannot_open_a_new_lease() {
        let gate = Barrier::default();
        let epoch = gate.begin(1, Duration::ZERO).unwrap();
        assert!(gate.end(1, epoch + 1, 1).is_err());
        assert_eq!(gate.phase(), Phase::Active);
        gate.close();
        assert!(gate.end(1, epoch, 1).is_err());
        assert!(gate.begin(2, Duration::ZERO).is_err());
    }
}
