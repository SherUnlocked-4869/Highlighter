//! `ICoreWebView2ScreenCaptureStarting` 事件注册与判定（本原型最关键的一段 unsafe）。
//!
//! 背景（官方文档 + 0.39.1 bindings 实测）：
//! - 接口 `ICoreWebView2_27` 提供 `add_ScreenCaptureStarting`（WebView2 SDK 1.0.2903.40 引入；
//!   本机 Runtime 157.0.4341.42 远高于该下限）。
//! - args（`ICoreWebView2ScreenCaptureStartingEventArgs`）**只有**：
//!   `Cancel` / `put_Cancel`、`Handled` / `put_Handled`、`OriginalSourceFrameInfo`、`GetDeferral`。
//!   **没有** "指定源" / "提供 video+audio 源" 的方法——这是与 Electron
//!   `session.setDisplayMediaRequestHandler(request, callback)` 的关键差异（后者可直接
//!   `callback({ video: source, audio: 'loopback' })`）。
//! - 官方语义：Cancel 之后 **Screen Capture UI 不显示**，脚本侧 getDisplayMedia 以
//!   `NotAllowedError`（Permission denied）失败；Handled 只用于阻止更下游的事件处理器，
//!   并不等于"跳过选源 UI"。
//!
//! 四种模式（环境变量 `R0_SCS_MODE`，每次进程运行一种）：
//! - `none`：不注册事件处理器（基线：WebView2 默认行为）；
//! - `observe`：注册但**不**改 Cancel/Handled（观察默认选源 UI 是否出现）；
//! - `handled-allow`：SetHandled(true)+SetCancel(false)（探测"不取消是否仍出 UI"）；
//! - `handled-cancel`：SetHandled(true)+SetCancel(true)（探测宿主能否静默拒绝）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2ScreenCaptureStartingEventArgs, ICoreWebView2_27,
};
use webview2_com::{take_pwstr, ScreenCaptureStartingEventHandler};
use windows::core::{Interface, BOOL, PCWSTR, PWSTR};

/// 事件处理模式（见模块注释）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScsMode {
    /// 不注册处理器。
    None,
    /// 注册但不修改 Cancel/Handled。
    Observe,
    /// SetHandled(true) + SetCancel(false)。
    HandledAllow,
    /// SetHandled(true) + SetCancel(true)。
    HandledCancel,
}

impl ScsMode {
    /// 解析 `R0_SCS_MODE`；缺省 `observe`。
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "observe" => Ok(Self::Observe),
            "none" => Ok(Self::None),
            "handled-allow" => Ok(Self::HandledAllow),
            "handled-cancel" => Ok(Self::HandledCancel),
            other => Err(format!(
                "未知 R0_SCS_MODE={other:?}（可选 none/observe/handled-allow/handled-cancel）"
            )),
        }
    }

    /// 字符串名（日志/报告用）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Observe => "observe",
            Self::HandledAllow => "handled-allow",
            Self::HandledCancel => "handled-cancel",
        }
    }
}

/// 屏幕采集事件流水 + 注册状态（跨线程共享）。
pub struct ScsRegistry {
    mode: ScsMode,
    registered: AtomicBool,
    next_seq: AtomicU64,
    events: Mutex<Vec<serde_json::Value>>,
}

impl ScsRegistry {
    /// 新建注册表。
    pub fn new(mode: ScsMode) -> Arc<Self> {
        Arc::new(Self {
            mode,
            registered: AtomicBool::new(false),
            next_seq: AtomicU64::new(0),
            events: Mutex::new(Vec::new()),
        })
    }

    /// 当前模式。
    pub fn mode(&self) -> ScsMode {
        self.mode
    }

    /// 下一个事件序号。
    pub fn next_seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::SeqCst)
    }

    /// 追加一条事件流水（同时打印到 stdout，供外层脚本抓取）。
    pub fn record(&self, value: serde_json::Value) {
        println!("[r0-media][scs] {value}");
        if let Ok(mut events) = self.events.lock() {
            events.push(value);
        }
    }

    /// 事件快照。
    pub fn snapshot(&self) -> Vec<serde_json::Value> {
        self.events
            .lock()
            .map(|events| events.clone())
            .unwrap_or_default()
    }

    /// 是否已成功注册 COM 事件处理器。
    pub fn is_registered(&self) -> bool {
        self.registered.load(Ordering::SeqCst)
    }
}

/// 在指定窗口的 WebView2 上注册 `ScreenCaptureStarting` 处理器。
///
/// 每个窗口（每个 CoreWebView2）各有一个事件源，`window_label` 用于区分事件来源。
/// `with_webview` 的回调在主线程执行；命令线程阻塞等待其返回（10s 超时）。
pub fn install(
    window: &WebviewWindow,
    registry: Arc<ScsRegistry>,
    window_label: &str,
) -> Result<(), String> {
    if registry.mode() == ScsMode::None {
        registry.record(json!({
            "event": "handler-skipped",
            "window": window_label,
            "reason": "R0_SCS_MODE=none（不注册 ScreenCaptureStarting 处理器）",
        }));
        return Ok(());
    }
    let (sender, receiver) = std::sync::mpsc::channel::<Result<(), String>>();
    let registry_for_callback = registry.clone();
    let label = window_label.to_string();
    window
        .with_webview(move |platform| {
            let outcome = install_inner(platform, registry_for_callback, label);
            let _ = sender.send(outcome);
        })
        .map_err(|error| format!("with_webview 调度失败: {error}"))?;
    receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "with_webview 10s 内未执行（主线程未处理消息？）".to_string())?
}

fn install_inner(
    platform: tauri::webview::PlatformWebview,
    registry: Arc<ScsRegistry>,
    window_label: String,
) -> Result<(), String> {
    // SAFETY: 必须在创建 WebView2 的 UI 线程调用（with_webview 保证）；接口查询/事件注册
    // 是标准 COM 调用。handler 由 WebView2 持有引用，注册后即使局部变量离开作用域也存活。
    unsafe {
        let controller = platform.controller();
        let core = controller
            .CoreWebView2()
            .map_err(|error| format!("ICoreWebView2Controller::CoreWebView2: {error}"))?;
        let core27: ICoreWebView2_27 = core.cast().map_err(|error| {
            format!("QueryInterface(ICoreWebView2_27) 失败: {error}（Runtime 过旧？）")
        })?;

        let mode = registry.mode();
        let log = registry.clone();
        let label = window_label;
        let label_for_event = label.clone();
        let handler = ScreenCaptureStartingEventHandler::create(Box::new(
            move |_sender, args: Option<ICoreWebView2ScreenCaptureStartingEventArgs>| {
                let mut record = json!({
                    "event": "screen-capture-starting",
                    "window": label,
                    "seq": log.next_seq(),
                    "mode": mode.as_str(),
                    "argsPresent": args.is_some(),
                    "epochMs": crate::util::epoch_ms(),
                });
                if let Some(args) = args {
                    // 判定前读一次，记录 WebView2 给的初值。
                    let mut cancel_before = BOOL(0);
                    let mut handled_before = BOOL(0);
                    let _ = args.Cancel(&mut cancel_before);
                    let _ = args.Handled(&mut handled_before);
                    record["cancelBefore"] = json!(cancel_before.as_bool());
                    record["handledBefore"] = json!(handled_before.as_bool());

                    // OriginalSourceFrameInfo：哪个 frame 发起的 getDisplayMedia。
                    if let Ok(frame_info) = args.OriginalSourceFrameInfo() {
                        let mut name = PWSTR::null();
                        if frame_info.Name(&mut name).is_ok() {
                            record["frameName"] =
                                json!(webview2_com::string_from_pcwstr(&PCWSTR::from_raw(name.0)));
                        }
                        let mut source = PWSTR::null();
                        if frame_info.Source(&mut source).is_ok() {
                            record["frameSource"] = json!(take_pwstr(source));
                        }
                    }

                    // 本原型的模式动作。
                    match mode {
                        ScsMode::HandledAllow => {
                            let _ = args.SetHandled(true);
                            let _ = args.SetCancel(false);
                        }
                        ScsMode::HandledCancel => {
                            let _ = args.SetHandled(true);
                            let _ = args.SetCancel(true);
                        }
                        ScsMode::Observe | ScsMode::None => {}
                    }

                    let mut cancel_after = BOOL(0);
                    let _ = args.Cancel(&mut cancel_after);
                    record["cancelAfter"] = json!(cancel_after.as_bool());
                }
                log.record(record);
                Ok(())
            },
        ));

        let mut token = 0i64;
        core27
            .add_ScreenCaptureStarting(&handler, &mut token)
            .map_err(|error| format!("add_ScreenCaptureStarting: {error}"))?;
        registry.record(json!({
            "event": "handler-installed",
            "window": label_for_event,
            "mode": mode.as_str(),
            "token": token,
            "interface": "ICoreWebView2_27",
        }));
        registry.registered.store(true, Ordering::SeqCst);
        Ok(())
    }
}
