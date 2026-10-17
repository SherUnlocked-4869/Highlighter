//! Private parent control surface. Launch never starts capture; initialize,
//! authenticated host coordination and explicit configure are separate steps.
use highlighter_clipboard::protocol::{read_frame, write_frame};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u32,
    #[serde(rename = "type")]
    kind: String,
    request_id: String,
    session_epoch: Option<String>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[cfg(windows)]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use highlighter_clipboard::listener::Monitor;
    use highlighter_clipboard::storage::{Filter, Rules, Store};
    use highlighter_clipboard::{barrier::Barrier, coordinator::Coordinator};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};
    let epoch = format!(
        "g0-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let mut initialized = false;
    let mut monitor: Option<Monitor> = None;
    let barrier = Arc::new(Barrier::default());
    let mut coordinator: Option<Coordinator> = None;
    let mut quiescing = false;
    let mut store: Option<Arc<Mutex<Store>>> = None;
    let mut rules = Rules::default();
    let mut paste = highlighter_clipboard::paste::PasteSession::default();
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Some(frame) = read_frame(&mut input)? {
        let request: Request = serde_json::from_value(frame.header)?;
        if request.version != 1
            || request.kind != "request"
            || request.request_id.is_empty()
            || request.request_id.len() > 64
            || !frame.payload.is_empty()
        {
            return Err("INVALID_REQUEST".into());
        }
        let mut binary = Vec::new();
        let result: Result<Value, &str> = (|| {
            if request.method == "initialize" {
                if initialized {
                    Err("ALREADY_INITIALIZED")
                } else {
                    if let Some(root) = request.params.get("storageRoot").and_then(Value::as_str) {
                        store = Some(Arc::new(Mutex::new(Store::open(std::path::Path::new(
                            root,
                        ))?)));
                    }
                    initialized = true;
                    Ok(
                        json!({"protocolVersion":1,"phase":if store.is_some(){"v1-candidate"}else{"g0"}, "nativeBuildId":option_env!("HL_CLIPBOARD_SOURCE_ID").unwrap_or("unidentified"),
                    "capabilities":{"clipboardMonitor":true,"history":store.is_some(),"coordination":true,"qualified":false},"enabled":false}),
                    )
                }
            } else if !initialized || request.session_epoch.as_deref() != Some(&epoch) {
                Err("SESSION_MISMATCH")
            } else {
                match request.method.as_str() {
                    "configure" => {
                        if quiescing {
                            Err("QUIESCE_PENDING")
                        } else if let Some(enabled) =
                            request.params.get("enabled").and_then(Value::as_bool)
                        {
                            if let Some(value) = request.params.get("rules") {
                                let next: Rules = serde_json::from_value(value.clone())
                                    .map_err(|_| "INVALID_RULES")?;
                                next.validate()?;
                                if let Some(current) = &monitor {
                                    current.set_rules(next.clone());
                                }
                                if let Some(store) = &store {
                                    store
                                        .lock()
                                        .map_err(|_| "STORAGE_FAILED")?
                                        .configure(next.clone())?;
                                }
                                rules = next;
                            }
                            if enabled && store.is_some() && coordinator.is_none() {
                                return Err("COORDINATOR_REQUIRED");
                            }
                            let started = if enabled && monitor.is_none() {
                                Monitor::start_with_store(barrier.clone(), store.clone()).map(
                                    |current| {
                                        current.set_rules(rules.clone());
                                        monitor = Some(current);
                                    },
                                )
                            } else {
                                Ok(())
                            };
                            started.map(|()| {
                                if let Some(current) = &monitor {
                                    current.configure(enabled);
                                }
                                json!({"enabled":enabled,"persistent":store.is_some()})
                            })
                        } else {
                            Err("INVALID_ARGUMENT")
                        }
                    }
                    "status" => {
                        let mut value = monitor
                            .as_ref()
                            .map(Monitor::status)
                            .unwrap_or_else(|| json!({"enabled":false,"accepted":0}));
                        if let Some(store) = &store {
                            // Status stays responsive even if an image is decoding.
                            if let Ok(store) = store.try_lock() {
                                for (key, field) in
                                    store.status()?.as_object().ok_or("STORAGE_FAILED")?
                                {
                                    value[key] = field.clone();
                                }
                            }
                        }
                        value["coordination"] = coordinator
                            .as_ref()
                            .map(Coordinator::status)
                            .unwrap_or_else(|| json!({"phase":"unregistered"}));
                        Ok(value)
                    }
                    "list" => store
                        .as_ref()
                        .ok_or("STORAGE_NOT_OPEN")?
                        .lock()
                        .map_err(|_| "STORAGE_FAILED")?
                        .list(
                            serde_json::from_value::<Filter>(request.params.clone())
                                .map_err(|_| "INVALID_FILTER")?,
                        ),
                    "detail" => store
                        .as_ref()
                        .ok_or("STORAGE_NOT_OPEN")?
                        .lock()
                        .map_err(|_| "STORAGE_FAILED")?
                        .detail(
                            request
                                .params
                                .get("id")
                                .and_then(Value::as_str)
                                .ok_or("INVALID_ID")?,
                        ),
                    "thumbnail" => {
                        let (mime, bytes) = store
                            .as_ref()
                            .ok_or("STORAGE_NOT_OPEN")?
                            .lock()
                            .map_err(|_| "STORAGE_FAILED")?
                            .payload(
                                request
                                    .params
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .ok_or("INVALID_ID")?,
                                true,
                            )?;
                        binary = bytes;
                        Ok(json!({"mime":mime,"byteLength":binary.len()}))
                    }
                    "paste.capture" => paste.capture(request.params.clone()),
                    "paste.clear" => {
                        paste.clear();
                        Ok(json!({"cleared":true}))
                    }
                    "paste.prepare" => paste.prepare(
                        &barrier,
                        store.as_ref().ok_or("STORAGE_NOT_OPEN")?,
                        request
                            .params
                            .get("id")
                            .and_then(Value::as_str)
                            .ok_or("INVALID_ID")?,
                        request
                            .params
                            .get("operationId")
                            .and_then(Value::as_str)
                            .ok_or("INVALID_OPERATION")?,
                        request.params.get("targetId").and_then(Value::as_str),
                    ),
                    "paste.commit" | "paste.cancel" => paste.commit(
                        &barrier,
                        store.as_ref().ok_or("STORAGE_NOT_OPEN")?,
                        request
                            .params
                            .get("ticket")
                            .and_then(Value::as_str)
                            .ok_or("INVALID_OPERATION")?,
                        request.method == "paste.cancel",
                    ),
                    "copy" => {
                        let id = request
                            .params
                            .get("id")
                            .and_then(Value::as_str)
                            .ok_or("INVALID_ID")?;
                        let op = request
                            .params
                            .get("operationId")
                            .and_then(Value::as_str)
                            .ok_or("INVALID_OPERATION")?;
                        let store = store.as_ref().ok_or("STORAGE_NOT_OPEN")?;
                        highlighter_clipboard::writer::copy_item(&barrier, store, id, op)?;
                        Ok(json!({"copied":true}))
                    }
                    "set-pinned" | "delete" | "clear" => {
                        if let Some(current) = &monitor {
                            current.invalidate();
                        }
                        store
                            .as_ref()
                            .ok_or("STORAGE_NOT_OPEN")?
                            .lock()
                            .map_err(|_| "STORAGE_FAILED")?
                            .mutate(&request.method, &request.params)
                    }
                    "maintenance" => {
                        store
                            .as_ref()
                            .ok_or("STORAGE_NOT_OPEN")?
                            .lock()
                            .map_err(|_| "STORAGE_FAILED")?
                            .maintain_if_due()?;
                        Ok(json!({"done":true}))
                    }
                    "coordination.start" => {
                        if monitor.as_ref().is_some_and(Monitor::enabled) {
                            Err("CAPTURE_MUST_BE_PAUSED")
                        } else if coordinator.is_some() || quiescing {
                            Err("COORDINATION_BLOCKED")
                        } else if let Some(pid) = request
                            .params
                            .get("hostPid")
                            .and_then(Value::as_u64)
                            .and_then(|pid| u32::try_from(pid).ok())
                        {
                            Coordinator::start(pid, barrier.clone()).map(|current| {
                                let endpoint = current.endpoint();
                                coordinator = Some(current);
                                endpoint
                            })
                        } else {
                            Err("INVALID_ARGUMENT")
                        }
                    }
                    "coordination.status" => Ok(coordinator
                        .as_ref()
                        .map(Coordinator::status)
                        .unwrap_or_else(|| json!({"phase":"unregistered"}))),
                    "coordination.recover" if monitor.as_ref().is_some_and(Monitor::enabled) => {
                        Err("CAPTURE_MUST_BE_PAUSED")
                    }
                    "coordination.recover" => coordinator
                        .as_ref()
                        .ok_or("UNREGISTERED")
                        .and_then(Coordinator::recover)
                        .map(|()| json!({"recovered":true})),
                    "coordination.stop" => {
                        let stopped = if monitor.as_ref().is_some_and(Monitor::enabled) {
                            Err("CAPTURE_MUST_BE_PAUSED")
                        } else {
                            coordinator
                                .as_mut()
                                .map(Coordinator::stop)
                                .unwrap_or(Ok(()))
                        };
                        stopped.map(|()| {
                            coordinator = None;
                            json!({"phase":"stopped"})
                        })
                    }
                    "quiesce" => {
                        paste.clear();
                        quiescing = true;
                        if let Some(current) = &monitor {
                            current.configure(false);
                        }
                        let stopped = coordinator
                            .as_mut()
                            .map(Coordinator::stop)
                            .unwrap_or(Ok(()))
                            .and_then(|()| monitor.as_mut().map(Monitor::stop).unwrap_or(Ok(())));
                        stopped
                            .map(|()| {
                                monitor = None;
                                coordinator = None;
                                quiescing = false;
                                if let Some(storage) = store.take() {
                                    storage.lock().map_err(|_| "STORAGE_FAILED")?.checkpoint()?;
                                }
                                Ok(json!({"phase":"stopped"}))
                            })
                            .and_then(|result| result)
                    }
                    _ => Err("UNSUPPORTED_METHOD"),
                }
            }
        })();
        let response = match result {
            Ok(value) => {
                json!({"version":1,"sessionEpoch":epoch,"type":"response","requestId":request.request_id,"ok":true,"result":value})
            }
            Err(code) => {
                json!({"version":1,"sessionEpoch":epoch,"type":"response","requestId":request.request_id,"ok":false,"error":{"code":code}})
            }
        };
        write_frame(&mut output, &response, &binary)?;
    }
    if let Some(mut current) = monitor {
        current.stop()?;
    }
    barrier.close();
    Ok(())
}

fn main() {
    #[cfg(windows)]
    if run().is_err() {
        eprintln!("clipboard sidecar failed; no payload logged");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("clipboard sidecar currently supports Windows only");
        std::process::exit(1);
    }
}
