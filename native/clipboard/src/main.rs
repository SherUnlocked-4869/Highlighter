//! G0 control surface. Recording is never enabled at launch; the product
//! feature is not wired in until coordination and persistence gates pass.
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
    use highlighter_clipboard::{barrier::Barrier, coordinator::Coordinator};
    use std::sync::Arc;
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
        let result: Result<Value, &str> = if request.method == "initialize" {
            if initialized {
                Err("ALREADY_INITIALIZED")
            } else {
                initialized = true;
                Ok(
                    json!({"protocolVersion":1,"phase":"g0", "nativeBuildId":option_env!("HL_CLIPBOARD_SOURCE_ID").unwrap_or("unidentified"),
                    "capabilities":{"clipboardMonitor":true,"history":false,"coordination":true,"qualified":false},"enabled":false}),
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
                        let started = if enabled && monitor.is_none() {
                            Monitor::start_with_barrier(barrier.clone()).map(|current| {
                                monitor = Some(current);
                            })
                        } else {
                            Ok(())
                        };
                        started.map(|()| {
                            if let Some(current) = &monitor {
                                current.configure(enabled);
                            }
                            json!({"enabled":enabled,"persistent":false})
                        })
                    } else {
                        Err("INVALID_ARGUMENT")
                    }
                }
                "status" => Ok(monitor
                    .as_ref()
                    .map(Monitor::status)
                    .unwrap_or_else(|| json!({"enabled":false,"accepted":0}))),
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
                    quiescing = true;
                    if let Some(current) = &monitor {
                        current.configure(false);
                    }
                    let stopped = coordinator
                        .as_mut()
                        .map(Coordinator::stop)
                        .unwrap_or(Ok(()))
                        .and_then(|()| monitor.as_mut().map(Monitor::stop).unwrap_or(Ok(())));
                    stopped.map(|()| {
                        monitor = None;
                        coordinator = None;
                        quiescing = false;
                        json!({"phase":"stopped"})
                    })
                }
                _ => Err("UNSUPPORTED_METHOD"),
            }
        };
        let response = match result {
            Ok(value) => {
                json!({"version":1,"sessionEpoch":epoch,"type":"response","requestId":request.request_id,"ok":true,"result":value})
            }
            Err(code) => {
                json!({"version":1,"sessionEpoch":epoch,"type":"response","requestId":request.request_id,"ok":false,"error":{"code":code}})
            }
        };
        write_frame(&mut output, &response, &[])?;
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
