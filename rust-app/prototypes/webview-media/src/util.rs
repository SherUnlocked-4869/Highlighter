//! 路径与编码小工具（无第三方依赖，保持原型最小）。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 本 crate 的 manifest 目录（`rust-app/prototypes/webview-media`）。
pub fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 仓库根目录：`rust-app/prototypes/webview-media` 向上三级。
pub fn repo_root() -> PathBuf {
    manifest_dir().join("../../..")
}

/// 本原型的全部产物目录（已 gitignore：`.tmp*/`）。
pub fn out_dir() -> PathBuf {
    match std::env::var("R0_MEDIA_OUT_DIR") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => crate::util::repo_root().join(".tmp-r0-media-webview"),
    }
}

/// Unix 毫秒时间戳（报告里用；ISO 时间由外层 run-matrix.ps1 记录）。
pub fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// 创建目录（含父目录）。
pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("create_dir_all({}): {error}", path.display()))
}

/// 标准 Base64 解码（带 `=` 填充；页面用 `btoa` 生成）。
///
/// 原型只接收自己页面发来的数据，不做 URL-safe 变体。
pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    let mut padding = 0usize;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                padding += 1;
                continue;
            }
            b'\r' | b'\n' | b' ' | b'\t' => continue,
            other => return Err(format!("decode_base64: 非法字符 0x{other:02x}")),
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    let _ = padding;
    Ok(out)
}

/// 把 JSON 值写入 NDJSON 文件（追加；用于页面事件流水）。
pub fn append_ndjson(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    use std::io::Write;
    let line =
        serde_json::to_string(value).map_err(|error| format!("serialize ndjson: {error}"))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("open {}: {error}", path.display()))?;
    writeln!(file, "{line}").map_err(|error| format!("write {}: {error}", path.display()))
}
