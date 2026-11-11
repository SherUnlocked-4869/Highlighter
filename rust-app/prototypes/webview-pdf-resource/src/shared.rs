//! 共享路径、错误类型与 JSON 落盘工具（R0-06 原型）。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// 本 crate 根目录（编译期固定），用于推导仓库根与 `.tmp-r0-*/` 产物目录。
pub const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

/// 应用命令错误（R0 原型版；正式 `OperationError` 由 `contracts` crate 定义）。
#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    /// 机器可读错误码，例如 `window-owner-mismatch`。
    pub code: String,
    /// 说明（R0 不含本地化 messageKey）。
    pub message: String,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

/// 仓库根：`rust-app/prototypes/webview-pdf-resource` 往上三级。
pub fn repo_root() -> PathBuf {
    Path::new(MANIFEST_DIR).join("..").join("..").join("..")
}

/// PDF 产物/日志目录（gitignore：`.tmp*/`）。
pub fn pdf_dir() -> PathBuf {
    repo_root().join(".tmp-r0-pdf")
}

/// 资源通道产物/日志目录（gitignore：`.tmp*/`）。
pub fn resource_dir() -> PathBuf {
    repo_root().join(".tmp-r0-resource")
}

/// 建目录（已存在视为成功）。
pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("创建目录失败 {}: {error}", path.display()))
}

/// 以 UTF-8、2 空格缩进写 JSON，失败返回可诊断错误。
pub fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let payload =
        serde_json::to_vec_pretty(value).map_err(|error| format!("序列化 JSON 失败: {error}"))?;
    std::fs::write(path, payload).map_err(|error| format!("写入失败 {}: {error}", path.display()))
}

/// Unix 毫秒时间戳（日志排序用）。
pub fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// 进程自启动以来的毫秒数（耗时日志用）。
pub fn elapsed_ms(start: &std::time::Instant) -> u128 {
    start.elapsed().as_millis()
}
