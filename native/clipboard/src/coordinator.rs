//! Private, logon-scoped native-worker channel. Only fixed-size metadata crosses
//! this pipe; credentials are returned solely over the parent's private stdio.
use crate::barrier::{Barrier, Phase};
use serde_json::{json, Value};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Security::Authorization::*;
use windows::Win32::Security::Cryptography::*;
use windows::Win32::Security::*;
use windows::Win32::Storage::FileSystem::*;
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows::Win32::System::Pipes::*;
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::*;
use windows::Win32::System::IO::*;

const REQUEST: usize = 128;
const LEASE_MS: u32 = 2000;

struct OwnedHandle(HANDLE);
impl OwnedHandle {
    fn raw(&self) -> HANDLE {
        self.0
    }
}
// Kernel handles can be shared across threads; the last owner closes them.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}
fn random() -> Result<[u8; 32], &'static str> {
    let mut bytes = [0; 32];
    unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG).ok() }
        .map_err(|_| "RNG_FAILED")?;
    Ok(bytes)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

unsafe fn logon_sid(process: HANDLE) -> Result<String, &'static str> {
    let mut token = HANDLE::default();
    OpenProcessToken(process, TOKEN_QUERY, &mut token).map_err(|_| "TOKEN_UNAVAILABLE")?;
    let token = OwnedHandle(token);
    let mut size = 0;
    let _ = GetTokenInformation(token.0, TokenLogonSid, None, 0, &mut size);
    if size == 0 || size > 65536 {
        return Err("LOGON_SID_UNAVAILABLE");
    }
    let mut aligned = vec![0u64; (size as usize).div_ceil(8)];
    GetTokenInformation(
        token.0,
        TokenLogonSid,
        Some(aligned.as_mut_ptr().cast()),
        size,
        &mut size,
    )
    .map_err(|_| "LOGON_SID_UNAVAILABLE")?;
    let groups = &*aligned.as_ptr().cast::<TOKEN_GROUPS>();
    if groups.GroupCount != 1 {
        return Err("LOGON_SID_UNAVAILABLE");
    }
    let mut text = PWSTR::null();
    ConvertSidToStringSidW(groups.Groups[0].Sid, &mut text).map_err(|_| "LOGON_SID_UNAVAILABLE")?;
    let result = text.to_string().map_err(|_| "LOGON_SID_UNAVAILABLE");
    let _ = LocalFree(Some(HLOCAL(text.0.cast())));
    result
}

// Overlapped operations always reach completion before their stack buffers die.
// Idle connect uses an event wait, not polling; lease reads have a deadline.
unsafe fn complete(
    pipe: HANDLE,
    stop: HANDLE,
    host: HANDLE,
    event: HANDLE,
    operation: &mut OVERLAPPED,
    started: windows::core::Result<()>,
    timeout: u32,
) -> Result<u32, &'static str> {
    match started {
        Ok(()) => {}
        Err(error) if error.code() == ERROR_PIPE_CONNECTED.to_hresult() => return Ok(0),
        Err(error) if error.code() == ERROR_IO_PENDING.to_hresult() => {
            if WaitForMultipleObjects(&[event, stop, host], false, timeout) != WAIT_OBJECT_0 {
                let _ = CancelIoEx(pipe, Some(operation));
                let mut ignored = 0;
                let _ = GetOverlappedResult(pipe, operation, &mut ignored, true);
                return Err("PIPE_INTERRUPTED");
            }
        }
        Err(_) => return Err("PIPE_IO_FAILED"),
    }
    let mut transferred = 0;
    GetOverlappedResult(pipe, operation, &mut transferred, false).map_err(|_| "PIPE_IO_FAILED")?;
    Ok(transferred)
}

unsafe fn receive(
    pipe: HANDLE,
    stop: HANDLE,
    host: HANDLE,
    timeout: u32,
) -> Result<[u8; REQUEST], &'static str> {
    let event = OwnedHandle(CreateEventW(None, true, false, None).map_err(|_| "EVENT_FAILED")?);
    let mut operation = OVERLAPPED {
        hEvent: event.0,
        ..Default::default()
    };
    let mut bytes = [0; REQUEST];
    let started = ReadFile(pipe, Some(&mut bytes), None, Some(&mut operation));
    if complete(pipe, stop, host, event.0, &mut operation, started, timeout)? != REQUEST as u32 {
        return Err("INVALID_PACKET");
    }
    Ok(bytes)
}

unsafe fn respond(
    pipe: HANDLE,
    stop: HANDLE,
    host: HANDLE,
    tx: u64,
    epoch: u64,
    status: u32,
) -> Result<(), &'static str> {
    let mut bytes = [0u8; 32];
    bytes[..4].copy_from_slice(b"HLC1");
    bytes[4..8].copy_from_slice(&status.to_le_bytes());
    bytes[8..16].copy_from_slice(&tx.to_le_bytes());
    bytes[16..24].copy_from_slice(&epoch.to_le_bytes());
    bytes[24..28].copy_from_slice(&LEASE_MS.to_le_bytes());
    let event = OwnedHandle(CreateEventW(None, true, false, None).map_err(|_| "EVENT_FAILED")?);
    let mut operation = OVERLAPPED {
        hEvent: event.0,
        ..Default::default()
    };
    let started = WriteFile(pipe, Some(&bytes), None, Some(&mut operation));
    if complete(pipe, stop, host, event.0, &mut operation, started, 100)? != bytes.len() as u32 {
        return Err("PIPE_IO_FAILED");
    }
    Ok(())
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}
fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn authenticated(bytes: &[u8; REQUEST], nonce: &[u8; 32], epoch: &[u8; 32]) -> bool {
    // Compare all credential bytes before deciding, and reject reserved fields.
    let different = bytes[16..48]
        .iter()
        .zip(nonce)
        .fold(0u8, |v, (a, b)| v | (a ^ b))
        | bytes[48..80]
            .iter()
            .zip(epoch)
            .fold(0u8, |v, (a, b)| v | (a ^ b));
    &bytes[..4] == b"HLC1" && different == 0 && bytes[112..].iter().all(|v| *v == 0)
}

pub struct Coordinator {
    host: Arc<OwnedHandle>,
    stop: Arc<OwnedHandle>,
    thread: Option<thread::JoinHandle<()>>,
    done: mpsc::Receiver<()>,
    barrier: Arc<Barrier>,
    endpoint: Value,
    completion: Arc<Mutex<Option<Value>>>,
}

impl Coordinator {
    pub fn start(host_pid: u32, barrier: Arc<Barrier>) -> Result<Self, &'static str> {
        unsafe {
            if host_pid == 0 || barrier.phase() != Phase::Idle {
                return Err("COORDINATION_BLOCKED");
            }
            let host = Arc::new(OwnedHandle(
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    false,
                    host_pid,
                )
                .map_err(|_| "HOST_UNAVAILABLE")?,
            ));
            let sid = logon_sid(GetCurrentProcess())?;
            if logon_sid(host.0)? != sid {
                return Err("HOST_LOGON_MISMATCH");
            }
            let mut current_session = 0;
            let mut host_session = 0;
            ProcessIdToSessionId(std::process::id(), &mut current_session)
                .map_err(|_| "SESSION_UNAVAILABLE")?;
            ProcessIdToSessionId(host_pid, &mut host_session).map_err(|_| "SESSION_UNAVAILABLE")?;
            if current_session != host_session || WaitForSingleObject(host.0, 0) != WAIT_TIMEOUT {
                return Err("HOST_UNAVAILABLE");
            }
            let nonce = random()?;
            let epoch = random()?;
            let name = format!("\\\\.\\pipe\\Highlighter.Clipboard.{}", hex(&random()?));
            let descriptor_text = wide(&format!("D:P(A;;GA;;;{sid})"));
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(descriptor_text.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
            .map_err(|_| "PIPE_ACL_FAILED")?;
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: false.into(),
            };
            let name_wide = wide(&name);
            let handle = CreateNamedPipeW(
                PCWSTR(name_wide.as_ptr()),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                512,
                512,
                100,
                Some(&attributes),
            );
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            if handle.is_invalid() {
                return Err("PIPE_CREATE_FAILED");
            }
            let pipe = OwnedHandle(handle);
            let stop = Arc::new(OwnedHandle(
                CreateEventW(None, true, false, None).map_err(|_| "EVENT_FAILED")?,
            ));
            let endpoint = json!({"pipeName":name,"nonce":hex(&nonce),"hostEpoch":hex(&epoch),"hostPid":host_pid,"serverPid":std::process::id()});
            barrier.register_host()?;
            let (finished, done) = mpsc::channel();
            let thread_stop = stop.clone();
            let thread_host = host.clone();
            let gate = barrier.clone();
            let completion = Arc::new(Mutex::new(None));
            let last_completion = completion.clone();
            let thread = thread::spawn(move || {
                while WaitForSingleObject(thread_stop.0, 0) == WAIT_TIMEOUT
                    && WaitForSingleObject(thread_host.0, 0) == WAIT_TIMEOUT
                {
                    let connected = (|| -> Result<(), &'static str> {
                        let event = OwnedHandle(
                            CreateEventW(None, true, false, None).map_err(|_| "EVENT_FAILED")?,
                        );
                        let mut operation = OVERLAPPED {
                            hEvent: event.0,
                            ..Default::default()
                        };
                        let started = ConnectNamedPipe(pipe.raw(), Some(&mut operation));
                        complete(
                            pipe.raw(),
                            thread_stop.0,
                            thread_host.0,
                            event.0,
                            &mut operation,
                            started,
                            INFINITE,
                        )?;
                        let mut client_pid = 0;
                        GetNamedPipeClientProcessId(pipe.raw(), &mut client_pid)
                            .map_err(|_| "CLIENT_UNAVAILABLE")?;
                        if client_pid != host_pid
                            || WaitForSingleObject(thread_host.0, 0) != WAIT_TIMEOUT
                        {
                            return Err("CLIENT_MISMATCH");
                        }
                        let begin = receive(pipe.raw(), thread_stop.0, thread_host.0, 100)?;
                        if !authenticated(&begin, &nonce, &epoch)
                            || u32_at(&begin, 4) != 1
                            || begin[80..112].iter().any(|v| *v != 0)
                        {
                            return Err("INVALID_BEGIN");
                        }
                        let tx = u64_at(&begin, 8);
                        let generation = match gate.begin(tx, Duration::from_millis(60)) {
                            Ok(value) => value,
                            Err(_) => {
                                let _ = respond(pipe.raw(), thread_stop.0, thread_host.0, tx, 0, 1);
                                return Ok(());
                            }
                        };
                        // Any failure after granting or trying to grant is orphaned.
                        let lease_started = Instant::now();
                        if respond(pipe.raw(), thread_stop.0, thread_host.0, tx, generation, 0)
                            .is_err()
                        {
                            gate.orphan();
                            return Err("GRANT_FAILED");
                        }
                        let end = receive(
                            pipe.raw(),
                            thread_stop.0,
                            thread_host.0,
                            LEASE_MS.saturating_sub(lease_started.elapsed().as_millis() as u32),
                        );
                        let end = match end {
                            Ok(value) => value,
                            Err(code) => {
                                gate.orphan();
                                return Err(code);
                            }
                        };
                        if !authenticated(&end, &nonce, &epoch)
                            || u32_at(&end, 4) != 2
                            || u64_at(&end, 8) != tx
                            || u64_at(&end, 80) != generation
                            || !(1..=3).contains(&u32_at(&end, 108))
                        {
                            gate.orphan();
                            return Err("INVALID_END");
                        }
                        // Anchors are observations, never ownership of a sequence range.
                        let baseline = GetClipboardSequenceNumber();
                        gate.end(tx, generation, baseline)?;
                        let anchors: Vec<u32> =
                            (0..5).map(|index| u32_at(&end, 88 + index * 4)).collect();
                        let outcome = match u32_at(&end, 108) {
                            1 if anchors[4] == baseline => "restored",
                            2 => "interrupted",
                            _ => "ambiguous",
                        };
                        *last_completion.lock().unwrap_or_else(|e| e.into_inner()) = Some(
                            json!({"transactionId":tx.to_string(),"generation":generation,"anchors":anchors,"outcome":outcome,"baseline":baseline}),
                        );
                        respond(pipe.raw(), thread_stop.0, thread_host.0, tx, generation, 0)
                    })();
                    let _ = DisconnectNamedPipe(pipe.raw());
                    if connected.is_err() && gate.phase() == Phase::Active {
                        gate.orphan();
                    }
                    if connected.is_err() {
                        // Bad clients or a failing pipe must not create a hot
                        // reconnect loop. This wait is cancellable and occurs
                        // only after failure; an idle healthy server blocks.
                        let _ = WaitForMultipleObjects(&[thread_stop.0, thread_host.0], false, 25);
                    }
                }
                gate.orphan();
                let _ = finished.send(());
            });
            Ok(Self {
                host,
                stop,
                thread: Some(thread),
                done,
                barrier,
                endpoint,
                completion,
            })
        }
    }

    pub fn endpoint(&self) -> Value {
        self.endpoint.clone()
    }
    pub fn status(&self) -> Value {
        json!({"phase":format!("{:?}",self.barrier.phase()).to_lowercase(),"hostAlive":self.host_alive(),"listening":self.thread.as_ref().is_some_and(|thread| !thread.is_finished()),"lastCompletion":*self.completion.lock().unwrap_or_else(|e| e.into_inner())})
    }
    pub fn host_alive(&self) -> bool {
        unsafe { WaitForSingleObject(self.host.0, 0) == WAIT_TIMEOUT }
    }
    pub fn recover(&self) -> Result<(), &'static str> {
        if self.host_alive() {
            return Err("HOST_STILL_RUNNING");
        }
        self.barrier
            .recover_after_host_exit(unsafe { GetClipboardSequenceNumber() })
    }
    pub fn stop(&mut self) -> Result<(), &'static str> {
        if matches!(
            self.barrier.phase(),
            Phase::Pending | Phase::Active | Phase::Orphaned
        ) {
            return Err("COORDINATION_BUSY");
        }
        unsafe {
            SetEvent(self.stop.0).map_err(|_| "COORDINATOR_STOP_FAILED")?;
        }
        if let Some(thread) = self.thread.take() {
            if self.done.recv_timeout(Duration::from_secs(2)).is_err() {
                self.thread = Some(thread);
                return Err("COORDINATOR_STOP_TIMEOUT");
            }
            thread.join().map_err(|_| "COORDINATOR_STOP_FAILED")?;
        }
        Ok(())
    }
}
impl Drop for Coordinator {
    fn drop(&mut self) {
        self.barrier.orphan();
        unsafe {
            let _ = SetEvent(self.stop.0);
        }
    }
}
