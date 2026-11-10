//! B. 二进制资源通道原型：command 二进制响应 vs 自定义 URI scheme protocol。
//!
//! 设计（对应 docs/plans/rust-migration/r0-resource-channel.md）：
//! - 后端维护一个资源注册表：不可猜测 ID（128-bit 随机 hex）、owner（webview label）、
//!   MIME、字节、可选 TTL 与撤销墓碑；
//! - 路径 1（command）：`resource_command` 返回 `tauri::ipc::Response::new(Vec<u8>)`，
//!   前端 `invoke` 直接拿到 ArrayBuffer（Tauri 2 的 IPC 协议对 raw response 用
//!   `arrayBuffer()`，不经过 Base64/JSON 数组）；
//! - 路径 2（protocol）：`register_uri_scheme_protocol("media", ...)`，Windows 上映射为
//!   `http://media.localhost/r/<id>`，支持 Range → 206 + Content-Range，并读取
//!   `UriSchemeContext::webview_label()` 做窗口归属鉴权；
//! - 拒绝路径：未知 ID 404、过期/撤销 410、路径遍历/非法 ID 400、跨窗口 403；
//! - 传输对照：同一份 20 MiB 合成数据分别走两条路径，记录耗时、字节数与
//!   `performance.memory` 采样（Chromium 非标准接口，未强制 GC，只作数量级参考）。
//!
//! 已知限制（必须如实记录，不得包装成“已按窗口鉴权”）：
//! - Tauri 的应用命令默认不受 capability ACL 约束；命令入口的 label 校验是纵深防御；
//! - 协议处理器的窗口归属依赖 `UriSchemeContext::webview_label()`，这是宿主侧
//!   “哪个 webview 发起的请求”信息，不是用户会话/角色权限；R1-04 仍需角色映射；
//! - 协议处理器签名要求 `Cow<'static, [u8]>`，整段响应需要一次内存拷贝（20 MiB 对照里可观测）。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, State, UriSchemeContext, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::cli::Options;
use crate::monitors;
use crate::shared::{ensure_dir, now_millis, write_json, CommandError};

/// 两个可见窗口的 label（capability 里登记同名窗口）。
pub const WINDOW_A: &str = "media-a";
pub const WINDOW_B: &str = "media-b";
/// 自定义 scheme（Windows 上实际请求地址是 `http://media.localhost/...`）。
pub const PROTOCOL_SCHEME: &str = "media";
pub const PROTOCOL_ORIGIN: &str = "http://media.localhost";
/// 传输对照用的合成二进制大小：20 MiB。
pub const BIG_BLOB_BYTES: usize = 20 * 1024 * 1024;
/// 资源 ID 长度（32 个 hex 字符 = 128 bit）。
const RESOURCE_ID_HEX_LEN: usize = 32;
/// 等待两份页面报告的总超时。
const REPORT_TIMEOUT: Duration = Duration::from_secs(120);

fn ipc_error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError::new(code, message)
}

// ---------------------------------------------------------------------------
// 资源注册表
// ---------------------------------------------------------------------------

struct ResourceEntry {
    id: String,
    tag: String,
    owner: String,
    mime: String,
    bytes: Arc<Vec<u8>>,
    expires_at: Option<Instant>,
}

#[derive(Default)]
struct RegistryInner {
    entries: HashMap<String, ResourceEntry>,
    revoked: HashSet<String>,
    sequence: u64,
}

/// 协议处理器/命令面共享的资源注册表（线程安全）。
pub struct ResourceRegistry {
    inner: Mutex<RegistryInner>,
    protocol_log: Mutex<Vec<serde_json::Value>>,
    command_log: Mutex<Vec<serde_json::Value>>,
    reports: Mutex<Vec<serde_json::Value>>,
    reports_condvar: Condvar,
    phase: Mutex<String>,
    environment: Mutex<serde_json::Value>,
}

/// 访问检查结果（成功时只拿 Arc 字节 + 元数据，不长期持锁）。
struct ResourceBody {
    bytes: Arc<Vec<u8>>,
    mime: String,
    tag: String,
}

/// 访问失败（带 HTTP 状态码，供协议处理器与命令面复用同一套判定）。
struct AccessError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl AccessError {
    fn not_found(id: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "resource-not-found",
            message: format!("资源不存在: {id}"),
        }
    }

    fn revoked(id: &str) -> Self {
        Self {
            status: StatusCode::GONE,
            code: "resource-revoked",
            message: format!("资源已被撤销: {id}"),
        }
    }

    fn expired(id: &str) -> Self {
        Self {
            status: StatusCode::GONE,
            code: "resource-expired",
            message: format!("资源已过期: {id}"),
        }
    }

    fn forbidden(requester: &str, owner: &str) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "window-owner-mismatch",
            message: format!("资源归属窗口 {owner}，请求窗口 {requester}"),
        }
    }
}

impl ResourceRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RegistryInner::default()),
            protocol_log: Mutex::new(Vec::new()),
            command_log: Mutex::new(Vec::new()),
            reports: Mutex::new(Vec::new()),
            reports_condvar: Condvar::new(),
            phase: Mutex::new("startup".to_string()),
            environment: Mutex::new(serde_json::json!({})),
        }
    }

    fn with_inner<T>(&self, action: impl FnOnce(&mut RegistryInner) -> T) -> Result<T, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "资源注册表互斥锁已中毒".to_string())?;
        Ok(action(&mut guard))
    }

    /// 注册资源，返回不可猜测 ID（32 hex）。
    pub fn register(
        &self,
        tag: &str,
        owner: &str,
        mime: &str,
        bytes: Vec<u8>,
        ttl: Option<Duration>,
    ) -> Result<String, String> {
        let id = random_resource_id()?;
        let entry = ResourceEntry {
            id: id.clone(),
            tag: tag.to_string(),
            owner: owner.to_string(),
            mime: mime.to_string(),
            bytes: Arc::new(bytes),
            expires_at: ttl.map(|ttl| Instant::now() + ttl),
        };
        self.with_inner(|inner| {
            inner.sequence += 1;
            inner.entries.insert(id.clone(), entry);
        })?;
        Ok(id)
    }

    /// 某 owner 的资源视图（页面通过 `resource_meta` 获取，避免前端硬编码 ID/URL）。
    pub fn views_for(&self, owner: &str) -> Result<Vec<serde_json::Value>, String> {
        let mut views: Vec<serde_json::Value> = self.with_inner(|inner| {
            inner
                .entries
                .values()
                .filter(|entry| entry.owner == owner && !inner.revoked.contains(&entry.id))
                .map(|entry| {
                    serde_json::json!({
                        "id": entry.id,
                        "tag": entry.tag,
                        "mime": entry.mime,
                        "owner": entry.owner,
                        "byteLength": entry.bytes.len(),
                        "url": format!("{PROTOCOL_ORIGIN}/r/{}", entry.id),
                        "expiresInMs": entry.expires_at.map(|deadline| deadline.saturating_duration_since(Instant::now()).as_millis() as u64),
                    })
                })
                .collect()
        })?;
        views.sort_by(|left, right| {
            left["tag"]
                .as_str()
                .unwrap_or("")
                .cmp(right["tag"].as_str().unwrap_or(""))
        });
        Ok(views)
    }

    /// 访问检查（命令面与协议处理器共用）。
    fn check_access(&self, requester: &str, id: &str) -> Result<ResourceBody, AccessError> {
        let mut guard = self.inner.lock().map_err(|_| AccessError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "resource-registry-poisoned",
            message: "资源注册表互斥锁已中毒".to_string(),
        })?;
        if guard.revoked.contains(id) {
            return Err(AccessError::revoked(id));
        }
        let Some(entry) = guard.entries.get(id) else {
            return Err(AccessError::not_found(id));
        };
        if let Some(deadline) = entry.expires_at {
            if Instant::now() >= deadline {
                let entry = guard.entries.remove(id);
                guard.revoked.insert(id.to_string());
                drop(entry);
                return Err(AccessError::expired(id));
            }
        }
        if entry.owner != requester {
            return Err(AccessError::forbidden(requester, &entry.owner));
        }
        Ok(ResourceBody {
            bytes: Arc::clone(&entry.bytes),
            mime: entry.mime.clone(),
            tag: entry.tag.clone(),
        })
    }

    /// 撤销资源（仅 owner 可撤销）。
    pub fn revoke(&self, requester: &str, id: &str) -> Result<bool, CommandError> {
        self.with_inner(|inner| match inner.entries.get(id) {
            None => Err(ipc_error("resource-not-found", format!("资源不存在: {id}"))),
            Some(entry) if entry.owner != requester => Err(ipc_error(
                "window-owner-mismatch",
                format!("资源归属窗口 {}，请求窗口 {requester}", entry.owner),
            )),
            Some(_) => {
                inner.entries.remove(id);
                inner.revoked.insert(id.to_string());
                Ok(true)
            }
        })
        .map_err(|message| ipc_error("resource-registry-error", message))?
    }

    /// 找到 `foreign-probe` 资源（A 拥有），供 B 做跨窗口拒绝测试；返回 (id, url)。
    pub fn foreign_probe(&self) -> Result<(String, String), String> {
        self.with_inner(|inner| {
            inner
                .entries
                .values()
                .find(|entry| entry.tag == "foreign-probe")
                .map(|entry| {
                    (
                        entry.id.clone(),
                        format!("{PROTOCOL_ORIGIN}/r/{}", entry.id),
                    )
                })
                .ok_or_else(|| "foreign-probe 资源未注册".to_string())
        })?
    }

    /// 所有资源元数据快照（写进报告，不含字节）。
    pub fn entries_snapshot(&self) -> Vec<serde_json::Value> {
        self.with_inner(|inner| {
            let mut entries: Vec<serde_json::Value> = inner
                .entries
                .values()
                .map(|entry| {
                    serde_json::json!({
                        "id": entry.id,
                        "tag": entry.tag,
                        "owner": entry.owner,
                        "mime": entry.mime,
                        "byteLength": entry.bytes.len(),
                        "revoked": inner.revoked.contains(&entry.id),
                        "hasTtl": entry.expires_at.is_some(),
                    })
                })
                .collect();
            entries.sort_by(|left, right| {
                left["tag"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(right["tag"].as_str().unwrap_or(""))
            });
            entries
        })
        .unwrap_or_default()
    }

    fn log_protocol(&self, entry: serde_json::Value) {
        if let Ok(mut guard) = self.protocol_log.lock() {
            guard.push(entry);
        }
    }

    fn log_command(&self, entry: serde_json::Value) {
        if let Ok(mut guard) = self.command_log.lock() {
            guard.push(entry);
        }
    }

    pub fn protocol_log_snapshot(&self) -> Vec<serde_json::Value> {
        self.protocol_log
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn command_log_snapshot(&self) -> Vec<serde_json::Value> {
        self.command_log
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn set_phase(&self, phase: &str) {
        if let Ok(mut guard) = self.phase.lock() {
            *guard = phase.to_string();
        }
    }

    fn phase(&self) -> String {
        self.phase
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| "poisoned".to_string())
    }

    fn push_report(&self, value: serde_json::Value) {
        if let Ok(mut guard) = self.reports.lock() {
            guard.push(value);
        }
        self.reports_condvar.notify_all();
    }

    /// 等待 expected 份页面报告（A 报告到达时把 phase 置为 `foreign`，唤醒 B 继续）。
    fn wait_reports(&self, expected: usize, timeout: Duration) -> Vec<serde_json::Value> {
        let deadline = Instant::now() + timeout;
        let mut guard = match self.reports.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        loop {
            if guard.len() >= expected {
                return guard.clone();
            }
            let now = Instant::now();
            if now >= deadline {
                return guard.clone();
            }
            let wait_for = deadline.saturating_duration_since(now);
            let (next_guard, _) = match self.reports_condvar.wait_timeout(guard, wait_for) {
                Ok(pair) => pair,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard = next_guard;
        }
    }

    pub fn set_environment(&self, environment: serde_json::Value) {
        if let Ok(mut guard) = self.environment.lock() {
            *guard = environment;
        }
    }

    fn environment_snapshot(&self) -> serde_json::Value {
        self.environment
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| serde_json::json!({}))
    }
}

/// 128-bit 随机 hex ID（不可猜测资源 ID）。
fn random_resource_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("随机数生成失败: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// 省略前缀后固定宽度 hex 校验（拒绝路径遍历/非 ID 字符）。
fn is_valid_resource_id(value: &str) -> bool {
    value.len() == RESOURCE_ID_HEX_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// ---------------------------------------------------------------------------
// Range 解析
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RangeDecision {
    /// 单段 Range：返回 206。
    Partial { start: u64, end: u64 },
    /// 多段/无法安全处理：退回整段 200（保守行为，不假装支持）。
    Full,
    /// 越界：416。
    Unsatisfiable,
}

/// 解析单个 `Range: bytes=...` 头（多段不支持 → Full）。
fn parse_range(raw: &str, total: u64) -> RangeDecision {
    let Some(spec) = raw.trim().strip_prefix("bytes=") else {
        return RangeDecision::Full;
    };
    if spec.contains(',') {
        return RangeDecision::Full;
    }
    let mut parts = spec.splitn(2, '-');
    let start_raw = parts.next().unwrap_or("").trim();
    let end_raw = parts.next().unwrap_or("").trim();
    if start_raw.is_empty() {
        // suffix range: bytes=-N
        let suffix: u64 = match end_raw.parse() {
            Ok(value) if value > 0 => value,
            _ => return RangeDecision::Unsatisfiable,
        };
        if total == 0 {
            return RangeDecision::Unsatisfiable;
        }
        let start = total.saturating_sub(suffix);
        return RangeDecision::Partial {
            start,
            end: total - 1,
        };
    }
    let start: u64 = match start_raw.parse() {
        Ok(value) => value,
        Err(_) => return RangeDecision::Unsatisfiable,
    };
    let end: u64 = if end_raw.is_empty() {
        total.saturating_sub(1)
    } else {
        match end_raw.parse() {
            Ok(value) => value,
            Err(_) => return RangeDecision::Unsatisfiable,
        }
    };
    if total == 0 || start >= total {
        return RangeDecision::Unsatisfiable;
    }
    let end = end.min(total - 1);
    if start > end {
        return RangeDecision::Unsatisfiable;
    }
    RangeDecision::Partial { start, end }
}

// ---------------------------------------------------------------------------
// 自定义 URI scheme 处理器
// ---------------------------------------------------------------------------

/// 构造协议响应（统一 CORS/缓存/Range 头）。
fn build_response(
    status: StatusCode,
    body: Vec<u8>,
    content_type: &str,
    content_length: Option<u64>,
    content_range: Option<String>,
    origin: Option<&str>,
    head_only: bool,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Range, Content-Length, Accept-Ranges",
        )
        .header("Timing-Allow-Origin", "*")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.unwrap_or("*"))
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "range, x-r0-probe")
        .header("Access-Control-Max-Age", "600");
    if let Some(length) = content_length {
        builder = builder.header(header::CONTENT_LENGTH, length.to_string());
    }
    if let Some(range) = content_range {
        builder = builder.header(header::CONTENT_RANGE, range);
    }
    let body = if head_only { Vec::new() } else { body };
    builder.body(body).unwrap_or_else(|_| {
        Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Vec::new())
            .expect("空响应总是可构造")
    })
}

fn json_response(
    status: StatusCode,
    code: &str,
    message: &str,
    origin: Option<&str>,
) -> Response<Vec<u8>> {
    let body = serde_json::to_vec(&serde_json::json!({ "code": code, "message": message }))
        .unwrap_or_default();
    let length = body.len() as u64;
    build_response(
        status,
        body,
        "application/json; charset=utf-8",
        Some(length),
        None,
        origin,
        false,
    )
}

/// 协议处理器主体（fn 里不用闭包，便于阅读与单测 Range 逻辑）。
fn handle_protocol_request(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    registry: Arc<ResourceRegistry>,
) -> Response<Vec<u8>> {
    let started = Instant::now();
    let webview_label = context.webview_label().to_string();
    let method = request.method().clone();
    let uri = request.uri().to_string();
    let path = request.uri().path().to_string();
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let origin_for_cors = origin.as_deref();
    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let head_only = method == tauri::http::Method::HEAD;

    let mut status = StatusCode::OK;
    let mut served_bytes: u64 = 0;
    let mut code = "ok".to_string();
    let mut content_range_log: Option<String> = None;

    let response = if method == tauri::http::Method::OPTIONS {
        status = StatusCode::NO_CONTENT;
        served_bytes = 0;
        build_response(
            StatusCode::NO_CONTENT,
            Vec::new(),
            "text/plain; charset=utf-8",
            Some(0),
            None,
            origin_for_cors,
            head_only,
        )
    } else if method != tauri::http::Method::GET && !head_only {
        status = StatusCode::METHOD_NOT_ALLOWED;
        code = "method-not-allowed".to_string();
        json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "method-not-allowed",
            &format!("只支持 GET/HEAD/OPTIONS，收到 {method}"),
            origin_for_cors,
        )
    } else {
        match parse_resource_path(&path) {
            Err(message) => {
                status = StatusCode::BAD_REQUEST;
                code = "resource-id-invalid".to_string();
                json_response(
                    StatusCode::BAD_REQUEST,
                    "resource-id-invalid",
                    &message,
                    origin_for_cors,
                )
            }
            Ok(id) => match registry.check_access(&webview_label, &id) {
                Err(error) => {
                    status = error.status;
                    code = error.code.to_string();
                    json_response(error.status, error.code, &error.message, origin_for_cors)
                }
                Ok(body) => {
                    let total = body.bytes.len() as u64;
                    match range_header.as_deref().map(|raw| parse_range(raw, total)) {
                        None | Some(RangeDecision::Full) => {
                            served_bytes = total;
                            build_response(
                                StatusCode::OK,
                                body.bytes.as_ref().clone(),
                                &body.mime,
                                Some(total),
                                None,
                                origin_for_cors,
                                head_only,
                            )
                        }
                        Some(RangeDecision::Unsatisfiable) => {
                            status = StatusCode::RANGE_NOT_SATISFIABLE;
                            code = "range-unsatisfiable".to_string();
                            let unsatisfied = format!("bytes */{total}");
                            content_range_log = Some(unsatisfied.clone());
                            build_response(
                                StatusCode::RANGE_NOT_SATISFIABLE,
                                Vec::new(),
                                &body.mime,
                                None,
                                Some(unsatisfied),
                                origin_for_cors,
                                head_only,
                            )
                        }
                        Some(RangeDecision::Partial { start, end }) => {
                            let length = end - start + 1;
                            let partial = body.bytes[start as usize..=end as usize].to_vec();
                            let content_range = format!("bytes {start}-{end}/{total}");
                            content_range_log = Some(content_range.clone());
                            served_bytes = length;
                            status = StatusCode::PARTIAL_CONTENT;
                            build_response(
                                StatusCode::PARTIAL_CONTENT,
                                partial,
                                &body.mime,
                                Some(length),
                                Some(content_range),
                                origin_for_cors,
                                head_only,
                            )
                        }
                    }
                }
            },
        }
    };

    registry.log_protocol(serde_json::json!({
        "webviewLabel": webview_label,
        "method": method.as_str(),
        "uri": uri,
        "path": path,
        "origin": origin,
        "range": range_header,
        "status": status.as_u16(),
        "code": code,
        "servedBytes": served_bytes,
        "contentRange": content_range_log,
        "elapsedMicros": started.elapsed().as_micros() as u64,
    }));
    response
}

/// 解析 `/r/<32 hex>`；其它形状一律 400（路径遍历在这里被拒）。
fn parse_resource_path(path: &str) -> Result<String, String> {
    let Some(rest) = path.strip_prefix("/r/") else {
        return Err(format!("只接受 /r/<资源ID> 路径，收到 {path}"));
    };
    if rest.contains('/') || rest.contains('\\') || rest.contains("..") {
        return Err(format!("资源 ID 不允许路径分隔符或 ..: {rest}"));
    }
    if !is_valid_resource_id(rest) {
        return Err(format!(
            "资源 ID 必须是 {RESOURCE_ID_HEX_LEN} 个 hex 字符: {rest}"
        ));
    }
    Ok(rest.to_string())
}

// ---------------------------------------------------------------------------
// Tauri 命令面
// ---------------------------------------------------------------------------

#[tauri::command]
fn resource_meta(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ResourceRegistry>>,
) -> Result<serde_json::Value, CommandError> {
    let label = window.label().to_string();
    let resources = state
        .views_for(&label)
        .map_err(|message| ipc_error("resource-meta-failed", message))?;
    let environment = state.environment_snapshot();
    Ok(serde_json::json!({
        "windowLabel": label,
        "resources": resources,
        "monitors": environment.get("monitors").cloned().unwrap_or(serde_json::json!([])),
        "windowPlacement": environment.get("windows").and_then(|windows| windows.get(&label)).cloned().unwrap_or(serde_json::json!(null)),
        "protocolOrigin": PROTOCOL_ORIGIN,
        "readme": "资源 ID 由宿主分配；页面不硬编码任何真实路径",
    }))
}

#[tauri::command]
fn resource_command(
    window: tauri::WebviewWindow,
    id: String,
    state: State<'_, Arc<ResourceRegistry>>,
) -> Result<tauri::ipc::Response, CommandError> {
    let label = window.label().to_string();
    let started = Instant::now();
    match state.check_access(&label, &id) {
        Ok(body) => {
            let bytes = body.bytes.as_ref().clone();
            state.log_command(serde_json::json!({
                "webviewLabel": label,
                "id": id,
                "tag": body.tag,
                "ok": true,
                "byteLength": bytes.len(),
                "elapsedMicros": started.elapsed().as_micros() as u64,
            }));
            Ok(tauri::ipc::Response::new(bytes))
        }
        Err(error) => {
            state.log_command(serde_json::json!({
                "webviewLabel": label,
                "id": id,
                "ok": false,
                "code": error.code,
                "status": error.status.as_u16(),
                "elapsedMicros": started.elapsed().as_micros() as u64,
            }));
            Err(ipc_error(error.code, error.message))
        }
    }
}

#[tauri::command]
fn resource_make_expiring(
    window: tauri::WebviewWindow,
    ttl_ms: u64,
    state: State<'_, Arc<ResourceRegistry>>,
) -> Result<serde_json::Value, CommandError> {
    let label = window.label().to_string();
    let ttl_ms = ttl_ms.clamp(200, 10_000);
    let bytes = synthetic_blob(32 * 1024);
    let id = state
        .register(
            "expiring",
            &label,
            "application/octet-stream",
            bytes,
            Some(Duration::from_millis(ttl_ms)),
        )
        .map_err(|message| ipc_error("resource-register-failed", message))?;
    Ok(serde_json::json!({
        "id": id,
        "url": format!("{PROTOCOL_ORIGIN}/r/{id}"),
        "ttlMs": ttl_ms,
    }))
}

#[tauri::command]
fn resource_revoke(
    window: tauri::WebviewWindow,
    id: String,
    state: State<'_, Arc<ResourceRegistry>>,
) -> Result<serde_json::Value, CommandError> {
    let label = window.label().to_string();
    let revoked = state.revoke(&label, &id)?;
    Ok(serde_json::json!({ "revoked": revoked }))
}

#[tauri::command]
fn resource_foreign_probe(
    state: State<'_, Arc<ResourceRegistry>>,
) -> Result<serde_json::Value, CommandError> {
    // 测试专用端点：故意把 A 拥有的合法 ID 交给 B，用来验证“合法 ID + 错误窗口”必须被拒绝。
    let (id, url) = state
        .foreign_probe()
        .map_err(|message| ipc_error("resource-foreign-probe-failed", message))?;
    Ok(serde_json::json!({
        "id": id,
        "url": url,
        "owner": WINDOW_A,
        "expectedStatus": 403,
        "testOnly": true,
    }))
}

#[tauri::command]
fn resource_phase(state: State<'_, Arc<ResourceRegistry>>) -> serde_json::Value {
    serde_json::json!({ "phase": state.phase() })
}

#[tauri::command]
fn resource_report(
    window: tauri::WebviewWindow,
    report: serde_json::Value,
    state: State<'_, Arc<ResourceRegistry>>,
) -> Result<serde_json::Value, CommandError> {
    let label = window.label().to_string();
    state.push_report(serde_json::json!({
        "windowLabel": label,
        "receivedAtUnixMs": now_millis(),
        "report": report,
    }));
    if label == WINDOW_A {
        state.set_phase("foreign");
    }
    Ok(serde_json::json!({ "accepted": true }))
}

#[tauri::command]
fn resource_save_artifact(
    window: tauri::WebviewWindow,
    name: String,
    base64: String,
    state: State<'_, Arc<ResourceRegistry>>,
) -> Result<serde_json::Value, CommandError> {
    let label = window.label().to_string();
    if label != WINDOW_A {
        return Err(ipc_error(
            "window-owner-mismatch",
            format!("resource_save_artifact 只接受 {WINDOW_A} 调用，收到 {label}"),
        ));
    }
    let valid_name = !name.is_empty()
        && name.len() <= 40
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid_name {
        return Err(ipc_error(
            "artifact-name-invalid",
            "artifact 名只允许小写字母/数字/连字符（1..=40）",
        ));
    }
    let bytes =
        decode_base64(&base64).map_err(|message| ipc_error("artifact-base64-invalid", message))?;
    let directory = crate::shared::resource_dir();
    ensure_dir(&directory).map_err(|message| ipc_error("artifact-dir-failed", message))?;
    let path = directory.join(format!("{name}.png"));
    std::fs::write(&path, &bytes).map_err(|error| {
        ipc_error(
            "artifact-write-failed",
            format!("写 {} 失败: {error}", path.display()),
        )
    })?;
    state.log_command(serde_json::json!({
        "webviewLabel": label,
        "command": "resource_save_artifact",
        "name": name,
        "bytes": bytes.len(),
        "file": path.display().to_string(),
    }));
    Ok(serde_json::json!({ "file": path.display().to_string(), "bytes": bytes.len() }))
}

// ---------------------------------------------------------------------------
// 启动 / 编排
// ---------------------------------------------------------------------------

/// 生成 20 MiB 合成二进制（xorshift64，确定性、不可压缩）。
fn synthetic_blob(byte_length: usize) -> Vec<u8> {
    let mut value: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut output = Vec::with_capacity(byte_length);
    while output.len() < byte_length {
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        output.extend_from_slice(&value.to_le_bytes());
    }
    output.truncate(byte_length);
    output
}

/// 标准 base64 解码（只用于把页面画布 PNG 交回宿主，避免引入额外依赖）。
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\r' | b'\n' | b' ' | b'\t' => continue,
            other => return Err(format!("非法 base64 字符: 0x{other:02x}")),
        };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    Ok(output)
}

/// 读取预生成的媒体文件（ffmpeg 命令见 r0-resource-channel.md）。
fn read_media(media_dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    let path = media_dir.join(name);
    std::fs::read(&path).map_err(|error| {
        format!(
            "读取媒体文件失败 {}: {error}（先按文档用 ffmpeg 生成到 .tmp-r0-resource/media/）",
            path.display()
        )
    })
}

/// 入口：资源通道模式。
pub fn run(options: Options) {
    let out_dir = options
        .out_dir
        .clone()
        .unwrap_or_else(crate::shared::resource_dir);
    if let Err(message) = ensure_dir(&out_dir) {
        eprintln!("[FAIL] {message}");
        std::process::exit(3);
    }
    let media_dir = out_dir.join("media");
    let image = match read_media(&media_dir, "image.png") {
        Ok(bytes) => bytes,
        Err(message) => {
            eprintln!("[FAIL] {message}");
            std::process::exit(3);
        }
    };
    let video = match read_media(&media_dir, "video.mp4") {
        Ok(bytes) => bytes,
        Err(message) => {
            eprintln!("[FAIL] {message}");
            std::process::exit(3);
        }
    };
    let big_blob = synthetic_blob(BIG_BLOB_BYTES);

    let registry = Arc::new(ResourceRegistry::new());
    let seed = |tag: &str, owner: &str, mime: &str, bytes: Vec<u8>| -> (String, String) {
        let id = registry
            .register(tag, owner, mime, bytes, None)
            .expect("注册种子资源失败");
        (id.clone(), format!("{PROTOCOL_ORIGIN}/r/{id}"))
    };
    seed("image", WINDOW_A, "image/png", image);
    seed("video", WINDOW_A, "video/mp4", video);
    seed("big-20mb", WINDOW_A, "application/octet-stream", big_blob);
    seed(
        "release-test",
        WINDOW_A,
        "text/plain; charset=utf-8",
        b"release-test-resource".to_vec(),
    );
    seed(
        "foreign-probe",
        WINDOW_A,
        "text/plain; charset=utf-8",
        b"foreign-probe-resource".to_vec(),
    );
    seed(
        "b-owned",
        WINDOW_B,
        "text/plain; charset=utf-8",
        b"b-owned-resource".to_vec(),
    );

    let protocol_registry = Arc::clone(&registry);
    let handler_registry = Arc::clone(&registry);

    let app = tauri::Builder::default()
        .manage(Arc::clone(&registry))
        .register_uri_scheme_protocol(PROTOCOL_SCHEME, move |context, request| {
            handle_protocol_request(context, request, Arc::clone(&handler_registry))
        })
        .invoke_handler(tauri::generate_handler![
            resource_meta,
            resource_command,
            resource_make_expiring,
            resource_revoke,
            resource_foreign_probe,
            resource_phase,
            resource_report,
            resource_save_artifact,
        ])
        .setup(move |app| {
            let monitors = match monitors::collect(app.handle()) {
                Ok(monitors) => monitors,
                Err(message) => {
                    println!("[FAIL] {message}");
                    app.handle().exit(2);
                    return Ok(());
                }
            };
            let Some(secondary) = monitors::secondary(&monitors).cloned() else {
                println!("[FAIL] 未检测到非主显示器：按约定不在主屏创建可见窗口，退出（退出码 2）");
                app.handle().exit(2);
                return Ok(());
            };
            println!(
                "[r0-resource] secondary={} pos={:?} size={:?} scale={}",
                secondary.name.clone().unwrap_or_else(|| "unnamed".to_string()),
                secondary.position,
                secondary.size,
                secondary.scale_factor
            );

            let windows = [
                (WINDOW_A, "resource-a.html", [40, 40], [1000u32, 780u32]),
                (WINDOW_B, "resource-b.html", [40, 860], [1000u32, 420u32]),
            ];
            let mut placements = serde_json::json!({});
            for (label, page, offset, size) in windows {
                let data_directory = out_dir.join("webview2-data").join(label);
                if let Err(message) = ensure_dir(&data_directory) {
                    println!("[FAIL] {message}");
                    app.handle().exit(3);
                    return Ok(());
                }
                let builder = WebviewWindowBuilder::new(
                    app.handle(),
                    label,
                    WebviewUrl::App(page.into()),
                )
                .title(format!("Highlighter R0-06 resource channel · {label}"))
                .inner_size(size[0] as f64, size[1] as f64)
                .visible(false)
                .focused(false)
                .skip_taskbar(false);
                #[cfg(windows)]
                let builder = builder.data_directory(data_directory);
                let window = match builder.build() {
                    Ok(window) => window,
                    Err(error) => {
                        println!("[FAIL] 创建窗口 {label} 失败: {error}");
                        app.handle().exit(3);
                        return Ok(());
                    }
                };
                if let Err(message) = monitors::place(&window, &secondary, offset, size) {
                    println!("[FAIL] 定位窗口 {label} 失败: {message}");
                    app.handle().exit(3);
                    return Ok(());
                }
                placements[label] = monitors::geometry(&window);
                if let Err(error) = window.show() {
                    println!("[FAIL] 显示窗口 {label} 失败: {error}");
                    app.handle().exit(3);
                    return Ok(());
                }
                println!("[r0-resource] visible window placed on secondary: {label}");
            }

            registry.set_environment(serde_json::json!({
                "monitors": monitors,
                "secondary": secondary,
                "windows": placements,
                "protocolOrigin": PROTOCOL_ORIGIN,
                "webview2Version": tauri::webview_version().unwrap_or_else(|error| format!("unavailable: {error}")),
            }));

            let app_handle = app.handle().clone();
            spawn_resource_worker(
                app_handle,
                Arc::clone(&protocol_registry),
                out_dir.clone(),
                options.hold_ms,
            );
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("[r0-resource] 构建 Tauri 应用失败: {error}");
            std::process::exit(3);
        }
    };
    let exit_code = app.run_return(|_app, _event| {});
    println!("[r0-resource] event loop exited code={exit_code}");
    std::process::exit(exit_code);
}

/// 断言辅助：把 (条件, 说明) 变成 JSON 记录。
fn check(name: &str, passed: bool, detail: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "check": name, "passed": passed, "detail": detail })
}

fn spawn_resource_worker(
    app: AppHandle,
    registry: Arc<ResourceRegistry>,
    out_dir: PathBuf,
    hold_ms: u64,
) {
    std::thread::spawn(move || {
        let code = resource_worker(&app, &registry, &out_dir);
        if hold_ms > 0 {
            std::thread::sleep(Duration::from_millis(hold_ms));
        }
        app.exit(code);
    });
}

fn resource_worker(app: &AppHandle, registry: &Arc<ResourceRegistry>, out_dir: &Path) -> i32 {
    let started_at = now_millis();
    let reports = registry.wait_reports(2, REPORT_TIMEOUT);
    let phase = registry.phase();
    let report_a = reports
        .iter()
        .find(|entry| entry["windowLabel"] == WINDOW_A)
        .cloned();
    let report_b = reports
        .iter()
        .find(|entry| entry["windowLabel"] == WINDOW_B)
        .cloned();

    // 从页面上报里取测试记录（缺失视为失败）。
    let test = |report: &Option<serde_json::Value>, name: &str| -> Option<serde_json::Value> {
        report
            .as_ref()
            .and_then(|entry| entry.get("report"))
            .and_then(|report| report.get("tests"))
            .and_then(|tests| tests.get(name))
            .cloned()
    };
    let a = |name: &str| test(&report_a, name);
    let b = |name: &str| test(&report_b, name);
    let flag = |value: &Option<serde_json::Value>, key: &str| -> bool {
        value
            .as_ref()
            .and_then(|entry| entry.get(key))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    };
    let number = |value: &Option<serde_json::Value>, key: &str| -> Option<f64> {
        value
            .as_ref()
            .and_then(|entry| entry.get(key))
            .and_then(|value| value.as_f64())
    };
    let status = |value: &Option<serde_json::Value>| -> Option<f64> { number(value, "status") };

    let mut checks: Vec<serde_json::Value> = Vec::new();
    let image_protocol = a("image_protocol");
    checks.push(check(
        "image_protocol_loads",
        flag(&image_protocol, "ok") && status(&image_protocol) == Some(200.0),
        serde_json::json!({ "test": image_protocol }),
    ));
    let image_command = a("image_command");
    checks.push(check(
        "image_command_binary",
        flag(&image_command, "ok") && number(&image_command, "byteLength").unwrap_or(0.0) > 0.0,
        serde_json::json!({ "test": image_command }),
    ));
    let video_load = a("video_protocol_load");
    checks.push(check(
        "video_protocol_loads",
        flag(&video_load, "ok") && number(&video_load, "duration").unwrap_or(0.0) > 1.0,
        serde_json::json!({ "test": video_load }),
    ));
    let video_seek = a("video_protocol_seek");
    let seek_ok = flag(&video_seek, "ok")
        && (number(&video_seek, "currentTime").unwrap_or(0.0) - 8.5).abs() < 0.75;
    checks.push(check(
        "video_protocol_seek",
        seek_ok,
        serde_json::json!({ "test": video_seek }),
    ));
    let range_manual = a("range_manual");
    let range_ok = flag(&range_manual, "ok")
        && status(&range_manual) == Some(206.0)
        && number(&range_manual, "bodyBytes") == Some(1000.0)
        && range_manual
            .as_ref()
            .and_then(|entry| entry.get("contentRange"))
            .and_then(|value| value.as_str())
            .map(|value| value.starts_with("bytes 1000-1999/"))
            .unwrap_or(false);
    checks.push(check(
        "protocol_range_206",
        range_ok,
        serde_json::json!({ "test": range_manual }),
    ));
    let range_suffix = a("range_suffix");
    checks.push(check(
        "protocol_range_suffix_206",
        flag(&range_suffix, "ok")
            && status(&range_suffix) == Some(206.0)
            && number(&range_suffix, "bodyBytes") == Some(500.0),
        serde_json::json!({ "test": range_suffix }),
    ));
    let preflight = a("custom_header_preflight");
    checks.push(check(
        "cors_preflight_custom_header",
        flag(&preflight, "ok") && status(&preflight) == Some(200.0),
        serde_json::json!({ "test": preflight }),
    ));
    let video_command = a("video_command_path");
    checks.push(check(
        "video_command_blob_playback",
        flag(&video_command, "ok"),
        serde_json::json!({ "test": video_command }),
    ));
    let frame = a("video_frame_artifact");
    checks.push(check(
        "video_frame_artifact",
        flag(&frame, "ok"),
        serde_json::json!({ "test": frame }),
    ));
    let transport = a("transport_20mb");
    let command_summary = transport
        .as_ref()
        .and_then(|entry| entry.get("commandSummary"))
        .cloned()
        .unwrap_or(serde_json::json!(null));
    let protocol_summary = transport
        .as_ref()
        .and_then(|entry| entry.get("protocolSummary"))
        .cloned()
        .unwrap_or(serde_json::json!(null));
    let transport_ok = flag(&transport, "ok")
        && command_summary
            .get("byteLength")
            .and_then(|value| value.as_f64())
            == Some(BIG_BLOB_BYTES as f64)
        && protocol_summary
            .get("byteLength")
            .and_then(|value| value.as_f64())
            == Some(BIG_BLOB_BYTES as f64);
    checks.push(check(
        "transport_20mb_equivalent",
        transport_ok,
        serde_json::json!({ "command": command_summary, "protocol": protocol_summary }),
    ));
    let unknown = a("unknown_id");
    checks.push(check(
        "unknown_id_404",
        status(&unknown) == Some(404.0),
        serde_json::json!({ "test": unknown }),
    ));
    let traversal = a("traversal_dotdot");
    let traversal_encoded_status = traversal
        .as_ref()
        .and_then(|entry| entry.get("encoded"))
        .and_then(|entry| entry.get("status"))
        .and_then(|value| value.as_f64());
    let traversal_normalized_status = traversal
        .as_ref()
        .and_then(|entry| entry.get("normalized"))
        .and_then(|entry| entry.get("status"))
        .and_then(|value| value.as_f64());
    checks.push(check(
        "path_traversal_rejected",
        flag(&traversal, "ok")
            && traversal_encoded_status == Some(400.0)
            && traversal_normalized_status == Some(400.0),
        serde_json::json!({ "test": traversal }),
    ));
    let expiring = a("expiring_id");
    checks.push(check(
        "expired_id_410",
        status(&expiring) == Some(410.0),
        serde_json::json!({ "test": expiring }),
    ));
    let revoked = a("revoked_id");
    checks.push(check(
        "revoked_id_410",
        status(&revoked) == Some(410.0),
        serde_json::json!({ "test": revoked }),
    ));
    let csp = a("csp_block");
    let violation_count = csp
        .as_ref()
        .and_then(|entry| entry.get("violationCount"))
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0);
    checks.push(check(
        "csp_blocks_unlisted_origin",
        flag(&csp, "ok") && violation_count > 0.0,
        serde_json::json!({ "test": csp }),
    ));
    let command_own = b("command_own");
    checks.push(check(
        "command_own_window_allowed",
        flag(&command_own, "ok") && number(&command_own, "byteLength").unwrap_or(0.0) > 0.0,
        serde_json::json!({ "test": command_own }),
    ));
    let command_foreign = b("command_foreign");
    let command_foreign_rejected = flag(&command_foreign, "rejected")
        && command_foreign
            .as_ref()
            .and_then(|entry| entry.get("error"))
            .and_then(|value| value.as_str())
            .map(|value| value.contains("window-owner-mismatch"))
            .unwrap_or(false);
    checks.push(check(
        "command_foreign_rejected",
        command_foreign_rejected,
        serde_json::json!({ "test": command_foreign }),
    ));
    let protocol_foreign = b("protocol_foreign");
    checks.push(check(
        "protocol_foreign_rejected_403",
        flag(&protocol_foreign, "rejected") && status(&protocol_foreign) == Some(403.0),
        serde_json::json!({ "test": protocol_foreign }),
    ));

    let protocol_log = registry.protocol_log_snapshot();
    let labels_seen: Vec<String> = {
        let mut labels: Vec<String> = protocol_log
            .iter()
            .filter_map(|entry| {
                entry["webviewLabel"]
                    .as_str()
                    .map(|value| value.to_string())
            })
            .collect();
        labels.sort();
        labels.dedup();
        labels
    };
    let range_request_count = protocol_log
        .iter()
        .filter(|entry| entry["range"].is_string())
        .count();
    let partial_count = protocol_log
        .iter()
        .filter(|entry| entry["status"].as_u64() == Some(206))
        .count();
    checks.push(check(
        "protocol_window_attribution_labels",
        labels_seen.iter().any(|label| label == WINDOW_A)
            && labels_seen.iter().any(|label| label == WINDOW_B),
        serde_json::json!({ "labels": labels_seen, "requestCount": protocol_log.len() }),
    ));
    checks.push(check(
        "protocol_range_observed_in_log",
        range_request_count > 0 && partial_count > 0,
        serde_json::json!({ "rangeRequestCount": range_request_count, "partialResponseCount": partial_count }),
    ));

    let passed = checks
        .iter()
        .filter(|entry| entry["passed"].as_bool().unwrap_or(false))
        .count();
    let total = checks.len();
    let environment = registry.environment_snapshot();
    let mut report = serde_json::json!({
        "mode": "resource",
        "outputDir": out_dir.display().to_string(),
        "startedAtUnixMs": started_at,
        "finishedAtUnixMs": now_millis(),
        "phaseAtFinish": phase,
        "environment": environment,
        "protocolOrigin": PROTOCOL_ORIGIN,
        "bigBlobBytes": BIG_BLOB_BYTES,
        "protocolRequests": protocol_log,
        "commandCalls": registry.command_log_snapshot(),
        "registryEntries": registry.entries_snapshot(),
        "pageReports": reports,
        "checks": checks,
        "summary": { "passed": passed, "total": total },
        "windows": {
            WINDOW_A: app.get_webview_window(WINDOW_A).map(|window| monitors::geometry(&window)).unwrap_or(serde_json::json!(null)),
            WINDOW_B: app.get_webview_window(WINDOW_B).map(|window| monitors::geometry(&window)).unwrap_or(serde_json::json!(null)),
        },
    });
    // protocol-requests.log：逐行 JSON，便于 grep Range/206 证据。
    let log_path = out_dir.join("protocol-requests.log");
    let log_lines: Vec<String> = protocol_log
        .iter()
        .map(|entry| serde_json::to_string(entry).unwrap_or_default())
        .collect();
    let _ = std::fs::write(&log_path, log_lines.join("\n"));
    report["protocolLogFile"] = serde_json::json!(log_path.display().to_string());

    let report_path = out_dir.join("resource-report.json");
    match write_json(&report_path, &report) {
        Ok(()) => println!("[report] {}", report_path.display()),
        Err(message) => println!("[FAIL] 写报告失败: {message}"),
    }

    for entry in report["checks"].as_array().cloned().unwrap_or_default() {
        let status = if entry["passed"].as_bool().unwrap_or(false) {
            "PASS"
        } else {
            "FAIL"
        };
        println!("[{status}] {}", entry["check"].as_str().unwrap_or("?"));
    }
    println!(
        "[r0-resource] checks {passed}/{total}; protocolRequests={}",
        protocol_log.len()
    );
    if passed == total {
        println!("[PASS] resource channel matrix");
        0
    } else {
        println!("[FAIL] resource channel matrix: {passed}/{total}");
        3
    }
}

/// 单测：Range 解析与资源 ID/路径校验（不启动 GUI）。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_closed_range() {
        assert_eq!(
            parse_range("bytes=1000-1999", 5000),
            RangeDecision::Partial {
                start: 1000,
                end: 1999
            }
        );
    }

    #[test]
    fn parses_open_ended_range() {
        assert_eq!(
            parse_range("bytes=4000-", 5000),
            RangeDecision::Partial {
                start: 4000,
                end: 4999
            }
        );
        assert_eq!(
            parse_range("bytes=0-", 10),
            RangeDecision::Partial { start: 0, end: 9 }
        );
    }

    #[test]
    fn parses_suffix_range() {
        assert_eq!(
            parse_range("bytes=-500", 5000),
            RangeDecision::Partial {
                start: 4500,
                end: 4999
            }
        );
        assert_eq!(
            parse_range("bytes=-999999", 5000),
            RangeDecision::Partial {
                start: 0,
                end: 4999
            }
        );
    }

    #[test]
    fn clamps_oversized_end() {
        assert_eq!(
            parse_range("bytes=10-999999", 100),
            RangeDecision::Partial { start: 10, end: 99 }
        );
    }

    #[test]
    fn rejects_out_of_range() {
        assert_eq!(
            parse_range("bytes=5000-", 5000),
            RangeDecision::Unsatisfiable
        );
        assert_eq!(parse_range("bytes=9-4", 100), RangeDecision::Unsatisfiable);
        assert_eq!(
            parse_range("bytes=abc-def", 100),
            RangeDecision::Unsatisfiable
        );
    }

    #[test]
    fn multi_range_falls_back_to_full() {
        assert_eq!(parse_range("bytes=0-99,200-299", 1000), RangeDecision::Full);
        assert_eq!(parse_range("items=0-1", 1000), RangeDecision::Full);
    }

    #[test]
    fn validates_resource_id_shape() {
        assert!(is_valid_resource_id("0123456789abcdef0123456789abcdef"));
        assert!(!is_valid_resource_id("0123456789abcdef0123456789abcde"));
        assert!(!is_valid_resource_id("0123456789ABCDEF0123456789abcdef"));
        assert!(!is_valid_resource_id("../../../Windows/win.ini"));
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(parse_resource_path("/r/0123456789abcdef0123456789abcdef").is_ok());
        assert!(parse_resource_path("/r/..%2F..%2FWindows%2Fwin.ini").is_err());
        assert!(parse_resource_path("/Windows/win.ini").is_err());
        assert!(parse_resource_path("/r/0123456789abcdef0123456789abcdef/x").is_err());
    }

    #[test]
    fn synthetic_blob_is_deterministic_and_sized() {
        let first = synthetic_blob(1024);
        let second = synthetic_blob(1024);
        assert_eq!(first.len(), 1024);
        assert_eq!(first, second, "xorshift64 应确定性");
        assert!(first.iter().any(|byte| *byte != 0), "不应全零");
    }

    #[test]
    fn base64_roundtrip_matches_reference() {
        // "R0-06 resource channel" 的 base64（用标准实现生成，验证解码器）。
        let encoded = "UjAtMDYgcmVzb3VyY2UgY2hhbm5lbA==";
        assert_eq!(decode_base64(encoded).unwrap(), b"R0-06 resource channel");
        assert!(decode_base64("not base64!").is_err());
    }
}
