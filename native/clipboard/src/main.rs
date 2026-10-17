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
    use std::time::{SystemTime, UNIX_EPOCH};
    let epoch = format!(
        "g0-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let mut initialized = false;
    let mut monitor: Option<Monitor> = None;
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
                    "capabilities":{"clipboardMonitor":true,"history":false,"coordination":false},"enabled":false}),
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
                            Monitor::start().map(|current| {
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
                "quiesce" => {
                    quiescing = true;
                    let stopped = monitor.as_mut().map(Monitor::stop).unwrap_or(Ok(()));
                    stopped.map(|()| {
                        monitor = None;
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
